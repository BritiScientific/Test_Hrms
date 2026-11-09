import { randomUUID } from 'node:crypto';
import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { forbidden, notFound, unprocessable } from '../../shared/errors';
import { leaveAudit, today, yearOf } from './leave-common';
import { getEntitlement, resolvePolicy } from './leave-policy.service';

/**
 * Every balance change is a ledger row. The API never updates leave_balances: it
 * inserts into leave_balance_transactions and a trigger applies the row to the
 * matching bucket. available = credits - used - pending - expired - encashed - carried_out.
 *
 *   submit             LEAVE_HOLD                               pending +d
 *   final approval     LEAVE_HOLD_RELEASE + LEAVE_CONSUMPTION   pending -d, used +d
 *   reject / withdraw  LEAVE_HOLD_RELEASE                       pending -d
 *   cancel approved    LEAVE_REVERSAL                           used -d
 *
 * Each row has a deterministic idempotency key, so a retry cannot post twice.
 */

export type LedgerType =
  | 'OPENING_BALANCE' | 'ACCRUAL' | 'LEAVE_HOLD' | 'LEAVE_HOLD_RELEASE' | 'LEAVE_CONSUMPTION' | 'LEAVE_REVERSAL'
  | 'CARRY_FORWARD' | 'CARRY_FORWARD_OUT' | 'EXPIRY' | 'MANUAL_CREDIT' | 'MANUAL_DEBIT' | 'COMP_OFF_CREDIT' | 'ENCASHMENT';

export interface BalanceRow {
  id: number;
  employee_id: number;
  leave_type_id: number;
  leave_year: number;
  opening: number;
  accrued: number;
  carried_forward: number;
  adjusted: number;
  comp_off: number;
  used: number;
  pending: number;
  expired: number;
  encashed: number;
  carried_out: number;
  available: number;
}

/** Lock the balance row, creating it at zero if needed. Concurrent requests for one balance serialise here. */
export async function lockBalance(tx: Tx, tenantId: number, employeeId: number, leaveTypeId: number, year: number): Promise<BalanceRow> {
  await tx.query(
    `INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, leave_year)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, employee_id, leave_type_id, leave_year) DO NOTHING`,
    [tenantId, employeeId, leaveTypeId, year],
  );
  const r = await tx.query<BalanceRow>(
    `SELECT * FROM leave_balances
      WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3
      FOR UPDATE`,
    [employeeId, leaveTypeId, year],
  );
  return r.rows[0];
}

/** Returns false when this idempotency key was already posted: nothing changes. */
export async function postLedger(
  tx: Tx,
  e: {
    tenantId: number;
    balanceId: number;
    type: LedgerType;
    days: number;
    effectiveDate: string;
    idempotencyKey: string;
    leaveRequestId?: number | null;
    expiresOn?: string | null;
    note?: string | null;
    actorUserId?: number | null;
  },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO leave_balance_transactions
       (tenant_id, balance_id, txn_type, days, effective_date, expires_on, leave_request_id, idempotency_key, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT ON CONSTRAINT uq_leave_txn_idempotency DO NOTHING`,
    [e.tenantId, e.balanceId, e.type, e.days, e.effectiveDate, e.expiresOn ?? null, e.leaveRequestId ?? null,
     e.idempotencyKey, e.note ?? null, e.actorUserId ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

// ------------------------------------------------------------------- reads ---

export async function listBalances(tx: Tx, employeeId: number, year: number) {
  const policyDate = await effectivePolicyDate(tx, year);
  const policy = await resolvePolicy(tx, employeeId, policyDate);
  const r = await tx.query(
    `SELECT lt.id AS leave_type_id, lt.code AS leave_type_code, lt.name AS leave_type_name, lt.category, lt.is_paid,
            b.id AS balance_id, $2::int AS leave_year,
            COALESCE(en.annual_entitlement, 0) AS annual_entitlement,
            COALESCE(b.opening, 0) AS opening, COALESCE(b.accrued, 0) AS accrued,
            COALESCE(b.carried_forward, 0) AS carried_forward, COALESCE(b.adjusted, 0) AS adjusted,
            COALESCE(b.comp_off, 0) AS comp_off, COALESCE(b.used, 0) AS used, COALESCE(b.pending, 0) AS pending,
            COALESCE(b.expired, 0) AS expired, COALESCE(b.encashed, 0) AS encashed,
            COALESCE(b.carried_out, 0) AS carried_out, COALESCE(b.available, 0) AS available,
            COALESCE(en.allow_negative_balance, false) AS allow_negative_balance,
            COALESCE(en.allow_encashment, false) AS allow_encashment,
            expiring.next_expiry_on, COALESCE(expiring.expiring_days, 0) AS expiring_days
       FROM leave_types lt
       LEFT JOIN leave_policy_entitlements en
              ON en.tenant_id = lt.tenant_id AND en.leave_type_id = lt.id AND en.policy_id = $3
       LEFT JOIN leave_balances b
              ON b.tenant_id = lt.tenant_id AND b.leave_type_id = lt.id AND b.employee_id = $1 AND b.leave_year = $2
       LEFT JOIN LATERAL (
              SELECT min(t.expires_on) AS next_expiry_on,
                     sum(t.days) FILTER (WHERE t.expires_on = (
                       SELECT min(x.expires_on) FROM leave_balance_transactions x
                        WHERE x.balance_id = b.id AND x.expires_on >= tenant_today())) AS expiring_days
                FROM leave_balance_transactions t
               WHERE t.balance_id = b.id AND t.expires_on >= tenant_today()
            ) expiring ON true
      WHERE (en.id IS NOT NULL AND lt.is_active) OR b.id IS NOT NULL
      ORDER BY lt.name`,
    [employeeId, year, policy?.id ?? null],
  );
  return r.rows;
}

/** Today for the current year, otherwise a date inside the year asked about. */
async function effectivePolicyDate(tx: Tx, year: number) {
  const now = await today(tx);
  if (yearOf(now) === year) return now;
  return yearOf(now) < year ? `${year}-01-01` : `${year}-12-31`;
}

export async function listTransactions(
  tx: Tx,
  employeeId: number,
  q: { year: number; leaveTypeId?: number; limit?: number; offset?: number },
) {
  const params: unknown[] = [employeeId, q.year];
  let filter = '';
  if (q.leaveTypeId) {
    params.push(q.leaveTypeId);
    filter = `AND b.leave_type_id = $${params.length}`;
  }
  const total = await tx.query(
    `SELECT count(*)::int AS n FROM leave_balance_transactions t
       JOIN leave_balances b ON b.tenant_id = t.tenant_id AND b.id = t.balance_id
      WHERE b.employee_id = $1 AND b.leave_year = $2 ${filter}`,
    params,
  );
  const limit = Math.min(q.limit ?? 25, 100);
  const offset = q.offset ?? 0;
  const r = await tx.query(
    `SELECT * FROM (
       SELECT t.id, t.txn_type, t.days, t.effective_date, t.expires_on, t.leave_request_id, t.note, t.created_at,
              leave_txn_available_delta(t.txn_type, t.days) AS delta,
              sum(leave_txn_available_delta(t.txn_type, t.days))
                OVER (PARTITION BY t.balance_id ORDER BY t.created_at, t.id) AS available_after,
              lt.code AS leave_type_code, lt.name AS leave_type_name, u.full_name AS created_by_name
         FROM leave_balance_transactions t
         JOIN leave_balances b ON b.tenant_id = t.tenant_id AND b.id = t.balance_id
         JOIN leave_types lt   ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
         LEFT JOIN users u     ON u.id = t.created_by
        WHERE b.employee_id = $1 AND b.leave_year = $2 ${filter}
     ) s
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  return { items: r.rows, total: total.rows[0].n, limit, offset };
}

export async function reconciliation(tx: Tx) {
  const r = await tx.query(
    `SELECT d.*, e.full_name AS employee_name, lt.name AS leave_type_name
       FROM v_leave_balance_drift d
       JOIN employees e ON e.tenant_id = d.tenant_id AND e.id = d.employee_id
       JOIN leave_types lt ON lt.tenant_id = d.tenant_id AND lt.id = d.leave_type_id`,
  );
  return { inBalance: r.rowCount === 0, drift: r.rows };
}

// ------------------------------------------------------- manual adjustments ---

async function loadEmployeeAndType(tx: Tx, employeeId: number, leaveTypeId: number) {
  const e = await tx.query(`SELECT id, full_name FROM employees WHERE id = $1`, [employeeId]);
  if (!e.rowCount) throw notFound('Employee');
  const t = await tx.query(`SELECT id, code FROM leave_types WHERE id = $1`, [leaveTypeId]);
  if (!t.rowCount) throw notFound('Leave type');
}

export interface AdjustInput {
  employeeId: number;
  leaveTypeId: number;
  year: number;
  days: number;
  direction: 'credit' | 'debit';
  note: string;
  idempotencyKey?: string | null;
}

const assertNotOwnBalance = (auth: AuthContext, employeeId: number) => {
  if (employeeId === auth.employeeId) throw forbidden('SELF_APPROVAL', 'You cannot change your own leave balance');
};

export async function adjustBalance(tx: Tx, auth: AuthContext, input: AdjustInput) {
  assertNotOwnBalance(auth, input.employeeId);
  await loadEmployeeAndType(tx, input.employeeId, input.leaveTypeId);
  const bal = await lockBalance(tx, auth.tenantId, input.employeeId, input.leaveTypeId, input.year);
  if (input.direction === 'debit' && bal.available - input.days < 0) {
    throw unprocessable('INSUFFICIENT_BALANCE', 'This debit would take the balance below zero', { available: bal.available });
  }
  const key = `manual:${input.idempotencyKey ?? randomUUID()}`;
  const posted = await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: bal.id,
    type: input.direction === 'credit' ? 'MANUAL_CREDIT' : 'MANUAL_DEBIT',
    days: input.days, effectiveDate: await today(tx), idempotencyKey: key, note: input.note, actorUserId: auth.userId,
  });
  if (posted) {
    await leaveAudit(tx, auth, `balance.${input.direction}`, 'leave_balance', bal.id, { available: bal.available }, {
      employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year, days: input.days, note: input.note,
    });
  }
  return { replayed: !posted, balance: await lockBalance(tx, auth.tenantId, input.employeeId, input.leaveTypeId, input.year) };
}

/** Encashment debits the balance only; the payment itself belongs to payroll. */
export async function encashBalance(
  tx: Tx,
  auth: AuthContext,
  input: { employeeId: number; leaveTypeId: number; year: number; days: number; note: string; idempotencyKey?: string | null },
) {
  assertNotOwnBalance(auth, input.employeeId);
  await loadEmployeeAndType(tx, input.employeeId, input.leaveTypeId);
  const policy = await resolvePolicy(tx, input.employeeId, await effectivePolicyDate(tx, input.year));
  const ent = policy ? await getEntitlement(tx, policy.id, input.leaveTypeId) : null;
  if (!ent?.allow_encashment) {
    throw unprocessable('ENCASHMENT_NOT_ALLOWED', 'The employee’s leave policy does not allow encashment of this leave type');
  }
  const bal = await lockBalance(tx, auth.tenantId, input.employeeId, input.leaveTypeId, input.year);
  if (bal.available - input.days < 0) {
    throw unprocessable('INSUFFICIENT_BALANCE', 'Not enough available balance to encash', { available: bal.available });
  }
  const posted = await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: bal.id, type: 'ENCASHMENT', days: input.days,
    effectiveDate: await today(tx), idempotencyKey: `encash:${input.idempotencyKey ?? randomUUID()}`,
    note: input.note, actorUserId: auth.userId,
  });
  if (posted) {
    await leaveAudit(tx, auth, 'balance.encash', 'leave_balance', bal.id, { available: bal.available }, {
      employeeId: input.employeeId, leaveTypeId: input.leaveTypeId, year: input.year, days: input.days, note: input.note,
    });
  }
  return { replayed: !posted, balance: await lockBalance(tx, auth.tenantId, input.employeeId, input.leaveTypeId, input.year) };
}

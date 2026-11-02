import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { notFound, unprocessable } from '../../shared/errors';

/**
 * Balance buckets: allocated / used / pending(reserved). available =
 * allocated - used - pending (generated column).
 *
 *   submit   -> reserve  (pending +d)
 *   approve  -> release  (pending -d) + debit (used +d)
 *   reject / withdraw -> release (pending -d)
 *   cancel approved   -> credit (used -d)
 *
 * The app never UPDATEs leave_balances: it inserts ledger rows and a DB
 * trigger applies the deltas. Each (request, txn_type) can exist once, so a
 * retried approval is a no-op instead of a double debit.
 */

export type LedgerType = 'allocation' | 'reserve' | 'release' | 'debit' | 'credit' | 'adjustment' | 'carry_forward' | 'lapse';

export interface BalanceRow {
  id: number;
  employee_id: number;
  leave_type_id: number;
  period_year: number;
  allocated: number;
  used: number;
  pending: number;
  available: number;
}

export async function lockBalance(tx: Tx, employeeId: number, leaveTypeId: number, year: number): Promise<BalanceRow> {
  const r = await tx.query<BalanceRow>(
    `SELECT id, employee_id, leave_type_id, period_year, allocated, used, pending, available
       FROM leave_balances
      WHERE employee_id = $1 AND leave_type_id = $2 AND period_year = $3
      FOR UPDATE`,
    [employeeId, leaveTypeId, year],
  );
  if (!r.rowCount) throw unprocessable('NO_BALANCE', `No ${year} balance allocated for this leave type`);
  return r.rows[0];
}

export async function postLedger(
  tx: Tx,
  e: {
    tenantId: number;
    balanceId: number;
    type: LedgerType;
    leaveRequestId?: number | null;
    allocated?: number;
    used?: number;
    pending?: number;
    note?: string | null;
    actorUserId?: number | null;
  },
): Promise<boolean> {
  const r = await tx.query(
    `INSERT INTO leave_balance_transactions
       (tenant_id, balance_id, leave_request_id, txn_type, allocated_delta, used_delta, pending_delta, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, leave_request_id, txn_type) WHERE leave_request_id IS NOT NULL
     DO NOTHING`,
    [e.tenantId, e.balanceId, e.leaveRequestId ?? null, e.type, e.allocated ?? 0, e.used ?? 0,
     e.pending ?? 0, e.note ?? null, e.actorUserId ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function allocate(
  tx: Tx,
  actor: AuthContext,
  input: { employeeId: number; leaveTypeCode: string; year: number; days: number; note?: string },
) {
  const lt = await tx.query(`SELECT id FROM leave_types WHERE code = $1 AND is_active`, [input.leaveTypeCode]);
  if (!lt.rowCount) throw notFound('Leave type');
  const emp = await tx.query(`SELECT id FROM employees WHERE id = $1`, [input.employeeId]);
  if (!emp.rowCount) throw notFound('Employee');

  await tx.query(
    `INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, period_year)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, employee_id, leave_type_id, period_year) DO NOTHING`,
    [actor.tenantId, input.employeeId, lt.rows[0].id, input.year],
  );
  const bal = await lockBalance(tx, input.employeeId, lt.rows[0].id, input.year);
  if (bal.allocated + input.days < 0) throw unprocessable('INVALID_ALLOCATION', 'Allocation cannot go below zero');
  await postLedger(tx, {
    tenantId: actor.tenantId, balanceId: bal.id, type: input.days >= 0 ? 'allocation' : 'adjustment',
    allocated: input.days, note: input.note ?? null, actorUserId: actor.userId,
  });
  return lockBalance(tx, input.employeeId, lt.rows[0].id, input.year);
}

export async function listBalances(tx: Tx, employeeId: number, year: number) {
  const r = await tx.query(
    `SELECT lt.code AS leave_type, lt.name, b.period_year, b.allocated, b.used, b.pending, b.available
       FROM leave_balances b JOIN leave_types lt ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
      WHERE b.employee_id = $1 AND b.period_year = $2
      ORDER BY lt.name`,
    [employeeId, year],
  );
  return r.rows;
}

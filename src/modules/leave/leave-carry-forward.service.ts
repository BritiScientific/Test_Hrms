import type { Tx } from '../../config/db';
import { lockLeaveJobs, roundDays, today } from './leave-common';
import { lockBalance, postLedger } from './leave-balance.service';
import { policyResolver } from './leave-accrual.service';

/**
 * Year-end carry-forward and expiry. Each posting has a deterministic key, so a
 * re-run is a no-op. Closing a year moves carried days out of the old balance
 * (CARRY_FORWARD_OUT) and lapses the excess (EXPIRY), so they cannot also be spent
 * by a backdated request against the old year.
 */

export interface CarryLine {
  employeeId: number;
  employeeName: string;
  leaveTypeId: number;
  leaveTypeName: string;
  closing: number;
  carried: number;
  lapsed: number;
  pendingInOldYear: number;
  expiresOn: string | null;
}

const addMonthsMinusDay = (iso: string, months: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

/** Pure, so the limits can be unit tested. */
export function computeCarry(
  closing: number,
  rule: { maximum_carry_forward: number | null; maximum_balance: number | null },
  targetBalance: number,
): { carried: number; lapsed: number } {
  const base = Math.max(0, closing);
  let carried = rule.maximum_carry_forward == null ? base : Math.min(base, rule.maximum_carry_forward);
  if (rule.maximum_balance != null) carried = Math.min(carried, Math.max(0, rule.maximum_balance - targetBalance));
  return { carried: roundDays(carried), lapsed: roundDays(base - carried) };
}

export async function runCarryForward(
  tx: Tx,
  tenantId: number,
  opts: { fromYear: number; dryRun?: boolean; actorUserId?: number | null },
) {
  await lockLeaveJobs(tx, tenantId);
  const { fromYear } = opts;
  const dryRun = opts.dryRun ?? false;
  const toYear = fromYear + 1;
  const carryDate = `${toYear}-01-01`;
  const closeDate = `${fromYear}-12-31`;
  const policyOn = await policyResolver(tx);

  const rules = (await tx.query(
    `SELECT r.*, en.policy_id, en.leave_type_id
       FROM leave_carry_forward_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
      WHERE r.status = 'active' AND r.is_enabled AND en.allow_carry_forward
        AND daterange(r.effective_from, r.effective_to, '[]') @> $1::date`,
    [closeDate],
  )).rows;
  const ruleFor = (policyId: number | null, typeId: number) =>
    rules.find((r) => r.policy_id === policyId && r.leave_type_id === typeId);

  const balances = (await tx.query(
    `SELECT b.id, b.employee_id, b.leave_type_id, b.available, b.pending, e.full_name, lt.name AS leave_type_name
       FROM leave_balances b
       JOIN employees e ON e.tenant_id = b.tenant_id AND e.id = b.employee_id AND e.status <> 'exited'
       JOIN leave_types lt ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
      WHERE b.leave_year = $1
      ORDER BY b.employee_id, b.leave_type_id`,
    [fromYear],
  )).rows;

  const lines: CarryLine[] = [];
  let skippedAlreadyClosed = 0;
  for (const row of balances) {
    const rule = ruleFor(policyOn(row.employee_id, closeDate), row.leave_type_id);
    if (!rule) continue;

    const already = await tx.query(
      `SELECT 1 FROM leave_balance_transactions WHERE idempotency_key = ANY($1::text[]) LIMIT 1`,
      [[`carry-out:${row.id}`, `yearend-lapse:${row.id}`]],
    );
    if (already.rowCount) {
      skippedAlreadyClosed += 1;
      continue;
    }

    const old = dryRun ? row : await lockBalance(tx, tenantId, row.employee_id, row.leave_type_id, fromYear);
    const target = dryRun ? null : await lockBalance(tx, tenantId, row.employee_id, row.leave_type_id, toYear);
    const { carried, lapsed } = computeCarry(old.available, rule, target ? target.available + target.pending : 0);
    const expiresOn = !rule.expiry_enabled ? null
      : rule.expiry_date_rule === 'end_of_next_year' ? `${toYear}-12-31`
        : addMonthsMinusDay(carryDate, rule.expiry_after_months);

    if (!dryRun) {
      const base = { tenantId, actorUserId: opts.actorUserId ?? null };
      if (carried > 0) {
        await postLedger(tx, { ...base, balanceId: old.id, type: 'CARRY_FORWARD_OUT', days: carried, effectiveDate: closeDate,
          idempotencyKey: `carry-out:${old.id}`, note: `Carried to ${toYear}` });
        await postLedger(tx, { ...base, balanceId: target!.id, type: 'CARRY_FORWARD', days: carried, effectiveDate: carryDate,
          expiresOn, idempotencyKey: `carry-in:${old.id}`, note: `Carried from ${fromYear}` });
      }
      if (lapsed > 0) {
        await postLedger(tx, { ...base, balanceId: old.id, type: 'EXPIRY', days: lapsed, effectiveDate: closeDate,
          idempotencyKey: `yearend-lapse:${old.id}`, note: `Above the carry-forward limit for ${fromYear}` });
      }
    }
    if (carried > 0 || lapsed > 0 || old.pending > 0) {
      lines.push({
        employeeId: row.employee_id, employeeName: row.full_name, leaveTypeId: row.leave_type_id,
        leaveTypeName: row.leave_type_name, closing: old.available, carried, lapsed,
        pendingInOldYear: old.pending, expiresOn: carried > 0 ? expiresOn : null,
      });
    }
  }
  return {
    fromYear, toYear, dryRun, skippedAlreadyClosed,
    totalCarried: roundDays(lines.reduce((s, l) => s + l.carried, 0)),
    totalLapsed: roundDays(lines.reduce((s, l) => s + l.lapsed, 0)),
    balancesWithPending: lines.filter((l) => l.pendingInOldYear > 0).length,
    lines: lines.slice(0, 500),
  };
}

export interface ExpiringCredit {
  id: number;
  days: number;
  expires_on: string | null;
  effective_date: string;
  /** Days of this credit an earlier run already expired. */
  expired_days: number;
}

/**
 * First-in-first-out: days used or held are taken from the oldest credits first, so
 * only what is left of a credit can expire. A credit stays valid through expires_on.
 * Pure, so it can be unit tested.
 */
export function computeExpiries(
  credits: ExpiringCredit[],
  consumed: number,
  asOf: string,
): { id: number; days: number }[] {
  let burn = consumed;
  const out: { id: number; days: number }[] = [];
  for (const c of [...credits].sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.id - b.id)) {
    const capacity = roundDays(c.days - c.expired_days);
    const taken = Math.min(burn, capacity);
    burn = roundDays(burn - taken);
    const remaining = roundDays(capacity - taken);
    if (remaining > 0 && c.expired_days === 0 && c.expires_on && c.expires_on < asOf) out.push({ id: c.id, days: remaining });
  }
  return out;
}

/** Expire carried-forward and comp off credits whose date has passed. */
export async function runExpiry(
  tx: Tx,
  tenantId: number,
  opts: { asOf?: string; dryRun?: boolean; actorUserId?: number | null } = {},
) {
  await lockLeaveJobs(tx, tenantId);
  const asOf = opts.asOf ?? (await today(tx));
  const dryRun = opts.dryRun ?? false;

  const candidates = (await tx.query(
    `SELECT DISTINCT b.id, b.employee_id, b.leave_type_id, b.leave_year
       FROM leave_balance_transactions t
       JOIN leave_balances b ON b.tenant_id = t.tenant_id AND b.id = t.balance_id
      WHERE t.expires_on < $1::date
      ORDER BY b.id`,
    [asOf],
  )).rows;

  let expiredDays = 0;
  let creditsExpired = 0;
  for (const c of candidates) {
    const bal = dryRun
      ? (await tx.query(`SELECT * FROM leave_balances WHERE id = $1`, [c.id])).rows[0]
      : await lockBalance(tx, tenantId, c.employee_id, c.leave_type_id, c.leave_year);
    const credits = (await tx.query<ExpiringCredit>(
      `SELECT t.id, t.days, t.expires_on::text AS expires_on, t.effective_date::text AS effective_date,
              COALESCE((SELECT x.days FROM leave_balance_transactions x
                         WHERE x.idempotency_key = 'expiry:' || t.id), 0) AS expired_days
         FROM leave_balance_transactions t
        WHERE t.balance_id = $1 AND t.txn_type IN ('CARRY_FORWARD', 'COMP_OFF_CREDIT')`,
      [bal.id],
    )).rows;
    for (const d of computeExpiries(credits, bal.used + bal.pending, asOf)) {
      // Never expire more than is available: a hold or a negative balance has priority.
      const room = dryRun ? bal.available : (await lockBalance(tx, tenantId, c.employee_id, c.leave_type_id, c.leave_year)).available;
      const days = roundDays(Math.min(d.days, Math.max(0, room)));
      if (days <= 0) continue;
      if (!dryRun) {
        await postLedger(tx, {
          tenantId, balanceId: bal.id, type: 'EXPIRY', days, effectiveDate: asOf,
          idempotencyKey: `expiry:${d.id}`, actorUserId: opts.actorUserId ?? null, note: 'Credit expired',
        });
      }
      expiredDays = roundDays(expiredDays + days);
      creditsExpired += 1;
    }
  }
  return { asOf, dryRun, creditsExpired, expiredDays };
}

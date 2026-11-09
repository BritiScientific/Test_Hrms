import type { Tx } from '../../config/db';
import { lockLeaveJobs, roundDays, today, yearOf } from './leave-common';
import { lockBalance, postLedger } from './leave-balance.service';

/**
 * Accrual. Run by the scheduled job (src/cli/leave-jobs.ts) or by HR. Re-running is
 * always safe: a period is credited once per rule and employee, enforced by a unique
 * index on leave_accrual_postings and again by the ledger's idempotency key.
 * Only the leave year of `asOf` is processed; older years are not back-filled.
 */

export interface AccrualRule {
  id: number;
  policy_id: number;
  leave_type_id: number;
  accrual_frequency: 'annual' | 'monthly' | 'quarterly' | 'joining_date' | 'one_time' | 'manual';
  accrual_amount: number;
  accrual_start_rule: 'joining_date' | 'next_period';
  credit_timing: 'period_start' | 'period_end';
  proration_enabled: boolean;
  maximum_balance: number | null;
  effective_from: string;
  effective_to: string | null;
}

export interface DuePeriod {
  periodKey: string;
  creditDate: string;
  days: number;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const lastOfMonth = (y: number, m: number) => iso(y, m + 1, 0);
const dayCount = (from: string, to: string) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;

/** Periods a rule credits in the leave year of `asOf`, up to and including `asOf`. Pure, so it can be unit tested. */
export function duePeriods(rule: AccrualRule, dateOfJoining: string | null, asOf: string): DuePeriod[] {
  const year = yearOf(asOf);
  const periods: { key: string; start: string; end: string; pinnedCredit?: string }[] = [];
  switch (rule.accrual_frequency) {
    case 'manual':
      return [];
    case 'annual':
      periods.push({ key: `${year}`, start: iso(year, 1, 1), end: iso(year, 12, 31) });
      break;
    case 'monthly':
      for (let m = 1; m <= 12; m++) {
        periods.push({ key: `${year}-${String(m).padStart(2, '0')}`, start: iso(year, m, 1), end: lastOfMonth(year, m) });
      }
      break;
    case 'quarterly':
      for (let q = 1; q <= 4; q++) {
        periods.push({ key: `${year}-Q${q}`, start: iso(year, q * 3 - 2, 1), end: lastOfMonth(year, q * 3) });
      }
      break;
    case 'joining_date': {
      if (!dateOfJoining) return [];
      const anniversary = `${year}${dateOfJoining.slice(4)}`;
      periods.push({ key: `${year}-JD`, start: anniversary, end: anniversary, pinnedCredit: anniversary });
      break;
    }
    case 'one_time': {
      const start = dateOfJoining && dateOfJoining > rule.effective_from ? dateOfJoining : rule.effective_from;
      if (yearOf(start) !== year) return [];
      periods.push({ key: 'ONCE', start, end: start, pinnedCredit: start });
      break;
    }
  }

  const due: DuePeriod[] = [];
  for (const p of periods) {
    let days = rule.accrual_amount;
    let credit = p.pinnedCredit ?? (rule.credit_timing === 'period_start' ? p.start : p.end);
    if (dateOfJoining) {
      if (p.end < dateOfJoining) continue;
      if (dateOfJoining > p.start) {
        if (rule.accrual_start_rule === 'next_period') continue;
        if (rule.proration_enabled) days = roundDays(days * (dayCount(dateOfJoining, p.end) / dayCount(p.start, p.end)));
        if (credit < dateOfJoining) credit = dateOfJoining;
      }
    }
    if (credit > asOf || credit < rule.effective_from) continue;
    if (rule.effective_to && credit > rule.effective_to) continue;
    if (days > 0) due.push({ periodKey: p.key, creditDate: credit, days });
  }
  return due;
}

export interface AccrualSummary {
  asOf: string;
  dryRun: boolean;
  periods: number;
  employees: number;
  creditedDays: number;
  cappedDays: number;
  items: { employeeId: number; employeeName: string; leaveTypeId: number; leaveTypeName: string; periodKey: string; days: number; capped: number }[];
}

export async function runAccrual(
  tx: Tx,
  tenantId: number,
  opts: { asOf?: string; dryRun?: boolean; ruleId?: number; employeeId?: number; actorUserId?: number | null } = {},
): Promise<AccrualSummary> {
  await lockLeaveJobs(tx, tenantId);
  const asOf = opts.asOf ?? (await today(tx));
  const dryRun = opts.dryRun ?? false;

  const rules = (await tx.query<AccrualRule & { leave_type_name: string }>(
    `SELECT r.id, en.policy_id, en.leave_type_id, lt.name AS leave_type_name, r.accrual_frequency, r.accrual_amount,
            r.accrual_start_rule, r.credit_timing, r.proration_enabled, r.maximum_balance, r.effective_from, r.effective_to
       FROM leave_accrual_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id AND lt.is_active
       JOIN leave_policies p ON p.tenant_id = en.tenant_id AND p.id = en.policy_id AND p.status = 'active'
      WHERE r.status = 'active' AND r.accrual_frequency <> 'manual'
        AND ($1::bigint IS NULL OR r.id = $1)
      ORDER BY r.id`,
    [opts.ruleId ?? null],
  )).rows;

  const employees = (await tx.query(
    `SELECT id, full_name, date_of_joining::text AS date_of_joining FROM employees
      WHERE status <> 'exited' AND ($1::bigint IS NULL OR id = $1)
      ORDER BY id`,
    [opts.employeeId ?? null],
  )).rows;

  const summary: AccrualSummary = { asOf, dryRun, periods: 0, employees: 0, creditedDays: 0, cappedDays: 0, items: [] };
  if (!rules.length || !employees.length) return summary;

  const posted = new Set((await tx.query(
    `SELECT accrual_rule_id, employee_id, period_key FROM leave_accrual_postings WHERE accrual_rule_id = ANY($1::bigint[])`,
    [rules.map((r) => r.id)],
  )).rows.map((x) => `${x.accrual_rule_id}:${x.employee_id}:${x.period_key}`));

  const policyOn = await policyResolver(tx);
  const touched = new Set<number>();
  const planned = new Map<string, number>();

  for (const emp of employees) {
    for (const rule of rules) {
      for (const period of duePeriods(rule, emp.date_of_joining, asOf)) {
        if (posted.has(`${rule.id}:${emp.id}:${period.periodKey}`)) continue;
        if (policyOn(emp.id, period.creditDate) !== rule.policy_id) continue;

        // A dry run must not create balance rows, so it reads instead of locking and adds up its own credits.
        const year = yearOf(period.creditDate);
        const planKey = `${emp.id}:${rule.leave_type_id}:${year}`;
        const bal = dryRun
          ? (await tx.query(
            `SELECT id, available, pending FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`,
            [emp.id, rule.leave_type_id, year],
          )).rows[0] ?? { id: 0, available: 0, pending: 0 }
          : await lockBalance(tx, tenantId, emp.id, rule.leave_type_id, year);
        const held = bal.available + bal.pending + (planned.get(planKey) ?? 0);
        const room = rule.maximum_balance == null ? period.days : Math.max(0, rule.maximum_balance - held);
        const credit = roundDays(Math.min(period.days, room));
        planned.set(planKey, (planned.get(planKey) ?? 0) + (dryRun ? credit : 0));

        if (!dryRun) {
          const row = await tx.query(
            `INSERT INTO leave_accrual_postings (tenant_id, accrual_rule_id, employee_id, period_key, scheduled_days, credited_days)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT ON CONSTRAINT uq_leave_accrual_period DO NOTHING
             RETURNING id`,
            [tenantId, rule.id, emp.id, period.periodKey, period.days, credit],
          );
          if (!row.rowCount) continue;
          if (credit > 0) {
            await postLedger(tx, {
              tenantId, balanceId: bal.id, type: 'ACCRUAL', days: credit, effectiveDate: period.creditDate,
              idempotencyKey: `accrual:${rule.id}:${emp.id}:${period.periodKey}`,
              actorUserId: opts.actorUserId ?? null,
              note: credit < period.days ? `Accrual ${period.periodKey} (capped at maximum balance)` : `Accrual ${period.periodKey}`,
            });
          }
        }
        summary.periods += 1;
        summary.creditedDays = roundDays(summary.creditedDays + credit);
        summary.cappedDays = roundDays(summary.cappedDays + period.days - credit);
        touched.add(emp.id);
        if (summary.items.length < 200) {
          summary.items.push({
            employeeId: emp.id, employeeName: emp.full_name, leaveTypeId: rule.leave_type_id,
            leaveTypeName: rule.leave_type_name, periodKey: period.periodKey, days: credit, capped: roundDays(period.days - credit),
          });
        }
      }
    }
  }
  summary.employees = touched.size;
  return summary;
}

/** In-memory lookup of the policy governing (employee, date); one query instead of one per period. */
export async function policyResolver(tx: Tx) {
  const assignments = (await tx.query(
    `SELECT a.employee_id, a.policy_id, a.effective_from::text AS effective_from, a.effective_to::text AS effective_to,
            p.effective_from::text AS p_from, p.effective_to::text AS p_to
       FROM leave_policy_assignments a
       JOIN leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id AND p.status = 'active'`,
  )).rows;
  const defaults = (await tx.query(
    `SELECT id, effective_from::text AS effective_from, effective_to::text AS effective_to
       FROM leave_policies WHERE is_default AND status = 'active'`,
  )).rows;
  const within = (d: string, from: string, to: string | null) => d >= from && (!to || d <= to);
  return (employeeId: number, date: string): number | null => {
    const a = assignments.find((x) => x.employee_id === employeeId && within(date, x.effective_from, x.effective_to) && within(date, x.p_from, x.p_to));
    if (a) return a.policy_id;
    return defaults.find((x) => within(date, x.effective_from, x.effective_to))?.id ?? null;
  };
}

/** Impact shown to HR before a rule is activated. Writes nothing. */
export async function accrualRuleImpact(tx: Tx, tenantId: number, ruleId: number) {
  const r = (await tx.query<AccrualRule>(
    `SELECT r.id, en.policy_id, en.leave_type_id, r.accrual_frequency, r.accrual_amount, r.accrual_start_rule,
            r.credit_timing, r.proration_enabled, r.maximum_balance, r.effective_from, r.effective_to
       FROM leave_accrual_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
      WHERE r.id = $1`,
    [ruleId],
  )).rows[0];
  if (!r) return null;
  const now = await today(tx);
  const policyOn = await policyResolver(tx);
  const employees = (await tx.query(
    `SELECT id, date_of_joining::text AS date_of_joining FROM employees WHERE status <> 'exited'`,
  )).rows;
  let affected = 0;
  let daysDueNow = 0;
  let periodsDueNow = 0;
  for (const e of employees) {
    if (policyOn(e.id, now) !== r.policy_id) continue;
    affected += 1;
    for (const p of duePeriods(r, e.date_of_joining, now)) {
      periodsDueNow += 1;
      daysDueNow = roundDays(daysDueNow + p.days);
    }
  }
  return { employeesOnPolicy: affected, periodsDueNow, daysDueNow, note: 'Maximum-balance caps can reduce the days actually credited.' };
}

import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { conflict, notFound, unprocessable } from '../../shared/errors';
import { accrualRuleImpact } from './leave-accrual.service';
import { leaveAudit, likeTerm, today } from './leave-common';

/**
 * HR configuration. Nothing here rewrites history: leave types are deactivated
 * instead of deleted, active rules are archived and replaced rather than edited,
 * and ledger rows are never touched. Every change is written to leave_audit_log.
 */

/** Build `SET a = $2, b = $3` from the keys present in a patch. Column names come from code, never input. */
function setClause(patch: Record<string, unknown>, columns: Record<string, string>) {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns)) {
    if (patch[key] !== undefined) {
      values.push(patch[key]);
      sets.push(`${column} = $${values.length + 1}`);
    }
  }
  return { sets, values };
}

async function updateRow(
  tx: Tx,
  auth: AuthContext,
  table: string,
  auditName: string,
  id: number,
  patch: Record<string, unknown>,
  columns: Record<string, string>,
) {
  const before = (await tx.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound(auditName.replace(/_/g, ' '));
  const { sets, values } = setClause(patch, columns);
  if (!sets.length) return before;
  const r = await tx.query(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, [id, ...values]);
  await leaveAudit(tx, auth, `${auditName}.update`, auditName, id, before, r.rows[0]);
  return r.rows[0];
}

const assertDates = (from?: string | null, to?: string | null) => {
  if (from && to && to < from) throw unprocessable('INVALID_DATES', 'The end date is before the start date');
};

// ------------------------------------------------------------- leave types ---

const TYPE_COLUMNS = {
  name: 'name', description: 'description', category: 'category', isPaid: 'is_paid', isActive: 'is_active',
  allowHalfDay: 'allow_half_day', requiresAttachment: 'requires_attachment', requiresContactDetails: 'requires_contact_details',
  allowBackdated: 'allow_backdated', maxBackdatedDays: 'max_backdated_days', maxConsecutiveDays: 'max_consecutive_days',
  minNoticeDays: 'min_notice_days', includeNonWorkingDays: 'include_non_working_days',
};

export async function listTypes(tx: Tx, q: { includeInactive?: boolean } = {}) {
  const r = await tx.query(
    `SELECT lt.*, EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.leave_type_id = lt.id) AS in_use
       FROM leave_types lt WHERE ($1 OR lt.is_active) ORDER BY lt.name`,
    [q.includeInactive ?? true],
  );
  return r.rows;
}

export async function createType(tx: Tx, auth: AuthContext, b: any) {
  const r = await tx.query(
    `INSERT INTO leave_types (tenant_id, code, name, description, category, is_paid, allow_half_day, requires_attachment,
                              requires_contact_details, allow_backdated, max_backdated_days, max_consecutive_days,
                              min_notice_days, include_non_working_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [auth.tenantId, b.code, b.name, b.description ?? null, b.category ?? 'other', b.isPaid ?? true, b.allowHalfDay ?? true,
     b.requiresAttachment ?? false, b.requiresContactDetails ?? false, b.allowBackdated ?? false, b.maxBackdatedDays ?? null,
     b.maxConsecutiveDays ?? null, b.minNoticeDays ?? 0, b.includeNonWorkingDays ?? false],
  );
  await leaveAudit(tx, auth, 'leave_type.create', 'leave_type', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export const updateType = (tx: Tx, auth: AuthContext, id: number, b: any) =>
  updateRow(tx, auth, 'leave_types', 'leave_type', id, b, TYPE_COLUMNS);

// ---------------------------------------------------------------- policies ---

export async function listPolicies(tx: Tx) {
  const r = await tx.query(
    `SELECT p.*,
            (SELECT count(*)::int FROM leave_policy_entitlements en WHERE en.policy_id = p.id) AS entitlement_count,
            (SELECT count(*)::int FROM leave_policy_assignments a
              WHERE a.policy_id = p.id AND daterange(a.effective_from, a.effective_to, '[]') @> tenant_today()) AS employee_count
       FROM leave_policies p
      ORDER BY p.status = 'archived', p.is_default DESC, p.name`,
  );
  return r.rows;
}

export async function getPolicy(tx: Tx, id: number) {
  const p = await tx.query(`SELECT * FROM leave_policies WHERE id = $1`, [id]);
  if (!p.rowCount) throw notFound('Leave policy');
  return { ...p.rows[0], entitlements: await listEntitlements(tx, id) };
}

export async function createPolicy(tx: Tx, auth: AuthContext, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  const r = await tx.query(
    `INSERT INTO leave_policies (tenant_id, code, name, description, effective_from, effective_to, status, is_default, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'draft', false, $7) RETURNING *`,
    [auth.tenantId, b.code, b.name, b.description ?? null, b.effectiveFrom, b.effectiveTo ?? null, auth.userId],
  );
  await leaveAudit(tx, auth, 'leave_policy.create', 'leave_policy', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function updatePolicy(tx: Tx, auth: AuthContext, id: number, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  return updateRow(tx, auth, 'leave_policies', 'leave_policy', id, b, {
    name: 'name', description: 'description', effectiveFrom: 'effective_from', effectiveTo: 'effective_to', isDefault: 'is_default',
  });
}

/** Warnings tell HR what activation will and will not do. They do not block it. */
export async function validatePolicyForActivation(tx: Tx, id: number) {
  const entitlements = await listEntitlements(tx, id);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!entitlements.length) errors.push('Add at least one leave type to this policy');
  for (const e of entitlements) {
    if (!e.leave_type_active) errors.push(`${e.leave_type_name} is deactivated`);
    if (e.annual_entitlement > 0 && !e.has_active_accrual) {
      warnings.push(`${e.leave_type_name}: no active accrual rule, so its ${e.annual_entitlement} days will not be credited automatically`);
    }
  }
  return { errors, warnings };
}

export async function activatePolicy(tx: Tx, auth: AuthContext, id: number) {
  const before = (await tx.query(`SELECT * FROM leave_policies WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Leave policy');
  if (before.status === 'archived') throw conflict('POLICY_ARCHIVED', 'An archived policy cannot be activated; create a new one');
  const { errors, warnings } = await validatePolicyForActivation(tx, id);
  if (errors.length) throw unprocessable('INVALID_POLICY', errors[0], { errors });
  const r = await tx.query(`UPDATE leave_policies SET status = 'active' WHERE id = $1 RETURNING *`, [id]);
  await leaveAudit(tx, auth, 'leave_policy.activate', 'leave_policy', id, before, r.rows[0]);
  return { policy: r.rows[0], warnings };
}

export async function archivePolicy(tx: Tx, auth: AuthContext, id: number) {
  const before = (await tx.query(`SELECT * FROM leave_policies WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Leave policy');
  const open = await tx.query(
    `SELECT count(*)::int AS n FROM leave_policy_assignments
      WHERE policy_id = $1 AND (effective_to IS NULL OR effective_to >= tenant_today())`,
    [id],
  );
  if (open.rows[0].n > 0) {
    throw conflict('POLICY_IN_USE', `${open.rows[0].n} employees are still assigned to this policy. Move them first.`);
  }
  const r = await tx.query(`UPDATE leave_policies SET status = 'archived', is_default = false WHERE id = $1 RETURNING *`, [id]);
  await leaveAudit(tx, auth, 'leave_policy.archive', 'leave_policy', id, before, r.rows[0]);
  return r.rows[0];
}

// ------------------------------------------------------------ entitlements ---

export async function listEntitlements(tx: Tx, policyId?: number) {
  const r = await tx.query(
    `SELECT en.*, lt.code AS leave_type_code, lt.name AS leave_type_name, lt.is_active AS leave_type_active,
            p.name AS policy_name, p.code AS policy_code,
            EXISTS (SELECT 1 FROM leave_accrual_rules a WHERE a.policy_entitlement_id = en.id AND a.status = 'active') AS has_active_accrual
       FROM leave_policy_entitlements en
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
       JOIN leave_policies p ON p.tenant_id = en.tenant_id AND p.id = en.policy_id
      WHERE ($1::bigint IS NULL OR en.policy_id = $1)
      ORDER BY p.name, lt.name`,
    [policyId ?? null],
  );
  return r.rows;
}

export async function createEntitlement(tx: Tx, auth: AuthContext, b: any) {
  const r = await tx.query(
    `INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id, annual_entitlement, allow_negative_balance,
                                            allow_carry_forward, allow_encashment, allow_half_day, max_consecutive_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [auth.tenantId, b.policyId, b.leaveTypeId, b.annualEntitlement ?? 0, b.allowNegativeBalance ?? false,
     b.allowCarryForward ?? false, b.allowEncashment ?? false, b.allowHalfDay ?? null, b.maxConsecutiveDays ?? null],
  );
  await leaveAudit(tx, auth, 'entitlement.create', 'entitlement', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export const updateEntitlement = (tx: Tx, auth: AuthContext, id: number, b: any) =>
  updateRow(tx, auth, 'leave_policy_entitlements', 'entitlement', id, b, {
    annualEntitlement: 'annual_entitlement', allowNegativeBalance: 'allow_negative_balance',
    allowCarryForward: 'allow_carry_forward', allowEncashment: 'allow_encashment',
    allowHalfDay: 'allow_half_day', maxConsecutiveDays: 'max_consecutive_days',
  });

export async function deleteEntitlement(tx: Tx, auth: AuthContext, id: number) {
  const before = (await tx.query(`SELECT * FROM leave_policy_entitlements WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Entitlement');
  const used = await tx.query(
    `SELECT 1 FROM leave_requests WHERE policy_id = $1 AND leave_type_id = $2 LIMIT 1`,
    [before.policy_id, before.leave_type_id],
  );
  if (used.rowCount) throw conflict('ENTITLEMENT_IN_USE', 'Requests have been made under this entitlement; it cannot be removed');
  const rules = await tx.query(
    `SELECT 1 FROM leave_accrual_rules WHERE policy_entitlement_id = $1
     UNION ALL SELECT 1 FROM leave_carry_forward_rules WHERE policy_entitlement_id = $1 LIMIT 1`,
    [id],
  );
  if (rules.rowCount) throw conflict('ENTITLEMENT_IN_USE', 'Accrual or carry-forward rules exist for this entitlement; it cannot be removed');
  await tx.query(`DELETE FROM leave_policy_entitlements WHERE id = $1`, [id]);
  await leaveAudit(tx, auth, 'entitlement.delete', 'entitlement', id, before, null);
}

// ------------------------------------------------------- holiday calendars ---

export async function listCalendars(tx: Tx, q: { year?: number } = {}) {
  const r = await tx.query(
    `SELECT c.*, (SELECT count(*)::int FROM leave_holidays h WHERE h.calendar_id = c.id) AS holiday_count,
            (SELECT count(*)::int FROM leave_calendar_assignments a
              WHERE a.calendar_id = c.id AND daterange(a.effective_from, a.effective_to, '[]') @> tenant_today()) AS employee_count
       FROM leave_holiday_calendars c
      WHERE ($1::int IS NULL OR c.calendar_year = $1)
      ORDER BY c.calendar_year DESC, c.status = 'archived', c.is_default DESC, c.name`,
    [q.year ?? null],
  );
  return r.rows;
}

export async function createCalendar(tx: Tx, auth: AuthContext, b: any) {
  const from = b.effectiveFrom ?? `${b.calendarYear}-01-01`;
  assertDates(from, b.effectiveTo);
  const r = await tx.query(
    `INSERT INTO leave_holiday_calendars (tenant_id, code, name, description, calendar_year, location, effective_from,
                                          effective_to, status, is_default, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'draft',false,$9) RETURNING *`,
    [auth.tenantId, b.code, b.name, b.description ?? null, b.calendarYear, b.location ?? null, from, b.effectiveTo ?? null, auth.userId],
  );
  await leaveAudit(tx, auth, 'holiday_calendar.create', 'holiday_calendar', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function updateCalendar(tx: Tx, auth: AuthContext, id: number, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  if (b.status === 'active') {
    const n = await tx.query(`SELECT count(*)::int AS n FROM leave_holidays WHERE calendar_id = $1`, [id]);
    if (n.rows[0].n === 0) throw unprocessable('EMPTY_CALENDAR', 'Add at least one holiday before activating this calendar');
  }
  return updateRow(tx, auth, 'leave_holiday_calendars', 'holiday_calendar', id, b, {
    name: 'name', description: 'description', location: 'location', effectiveFrom: 'effective_from',
    effectiveTo: 'effective_to', status: 'status', isDefault: 'is_default',
  });
}

export async function listHolidays(tx: Tx, q: { calendarId?: number; year?: number }) {
  const r = await tx.query(
    `SELECT h.*, c.name AS calendar_name, c.calendar_year
       FROM leave_holidays h
       JOIN leave_holiday_calendars c ON c.tenant_id = h.tenant_id AND c.id = h.calendar_id
      WHERE ($1::bigint IS NULL OR h.calendar_id = $1)
        AND ($2::int IS NULL OR c.calendar_year = $2)
      ORDER BY h.holiday_date`,
    [q.calendarId ?? null, q.year ?? null],
  );
  return r.rows;
}

export async function createHoliday(tx: Tx, auth: AuthContext, b: any) {
  const isOptional = b.holidayType === 'optional' ? true : b.isOptional ?? false;
  const r = await tx.query(
    `INSERT INTO leave_holidays (tenant_id, calendar_id, name, holiday_date, holiday_type, is_optional, description)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [auth.tenantId, b.calendarId, b.name, b.holidayDate, b.holidayType ?? 'organization', isOptional, b.description ?? null],
  );
  await leaveAudit(tx, auth, 'holiday.create', 'holiday', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function updateHoliday(tx: Tx, auth: AuthContext, id: number, b: any) {
  const patch = b.holidayType === 'optional' ? { ...b, isOptional: true } : b;
  return updateRow(tx, auth, 'leave_holidays', 'holiday', id, patch, {
    name: 'name', holidayDate: 'holiday_date', holidayType: 'holiday_type', isOptional: 'is_optional', description: 'description',
  });
}

export async function deleteHoliday(tx: Tx, auth: AuthContext, id: number) {
  const before = (await tx.query(`DELETE FROM leave_holidays WHERE id = $1 RETURNING *`, [id])).rows[0];
  if (!before) throw notFound('Holiday');
  await leaveAudit(tx, auth, 'holiday.delete', 'holiday', id, before, null);
}

// ------------------------------------------------- effective-dated assignments ---

interface AssignmentTable {
  table: string;
  targetColumn: string;
  audit: string;
}
const POLICY_ASSIGNMENT: AssignmentTable = { table: 'leave_policy_assignments', targetColumn: 'policy_id', audit: 'policy_assignment' };
const CALENDAR_ASSIGNMENT: AssignmentTable = { table: 'leave_calendar_assignments', targetColumn: 'calendar_id', audit: 'calendar_assignment' };

/**
 * A new assignment ends the employee's open-ended one the day before it starts.
 * A real overlap, such as a dated assignment inside the new period, is refused
 * by the exclusion constraint, so history is never rewritten silently.
 */
async function assign(
  tx: Tx,
  auth: AuthContext,
  t: AssignmentTable,
  input: { employeeIds: number[]; targetId: number; effectiveFrom: string; effectiveTo?: string | null; extra?: Record<string, unknown> },
) {
  assertDates(input.effectiveFrom, input.effectiveTo);
  const created = [];
  for (const employeeId of input.employeeIds) {
    await tx.query(
      `UPDATE ${t.table} SET effective_to = $2::date - 1
        WHERE employee_id = $1 AND effective_to IS NULL AND effective_from < $2::date`,
      [employeeId, input.effectiveFrom],
    );
    const extraKeys = Object.keys(input.extra ?? {});
    const r = await tx.query(
      `INSERT INTO ${t.table} (tenant_id, employee_id, ${t.targetColumn}, effective_from, effective_to, assigned_by${extraKeys.map((k) => `, ${k}`).join('')})
       VALUES ($1, $2, $3, $4, $5, $6${extraKeys.map((_, i) => `, $${7 + i}`).join('')})
       RETURNING *`,
      [auth.tenantId, employeeId, input.targetId, input.effectiveFrom, input.effectiveTo ?? null, auth.userId,
       ...extraKeys.map((k) => input.extra![k])],
    );
    await leaveAudit(tx, auth, `${t.audit}.create`, t.audit, r.rows[0].id, null, r.rows[0]);
    created.push(r.rows[0]);
  }
  return created;
}

async function endAssignment(tx: Tx, auth: AuthContext, t: AssignmentTable, id: number, effectiveTo: string | null) {
  const before = (await tx.query(`SELECT * FROM ${t.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Assignment');
  assertDates(before.effective_from, effectiveTo);
  const r = await tx.query(`UPDATE ${t.table} SET effective_to = $2 WHERE id = $1 RETURNING *`, [id, effectiveTo]);
  await leaveAudit(tx, auth, `${t.audit}.update`, t.audit, id, before, r.rows[0]);
  return r.rows[0];
}

async function deleteFutureAssignment(tx: Tx, auth: AuthContext, t: AssignmentTable, id: number) {
  const before = (await tx.query(`SELECT * FROM ${t.table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Assignment');
  if (before.effective_from <= (await today(tx))) {
    throw conflict('ASSIGNMENT_STARTED', 'This assignment has started and is kept as history. End it instead.');
  }
  await tx.query(`DELETE FROM ${t.table} WHERE id = $1`, [id]);
  await leaveAudit(tx, auth, `${t.audit}.delete`, t.audit, id, before, null);
}

export const assignPolicy = (tx: Tx, auth: AuthContext, b: any) =>
  assign(tx, auth, POLICY_ASSIGNMENT, {
    employeeIds: b.employeeIds, targetId: b.policyId, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo,
    extra: { assignment_reason: b.assignmentReason ?? null },
  });
export const assignCalendar = (tx: Tx, auth: AuthContext, b: any) =>
  assign(tx, auth, CALENDAR_ASSIGNMENT, {
    employeeIds: b.employeeIds, targetId: b.calendarId, effectiveFrom: b.effectiveFrom, effectiveTo: b.effectiveTo,
  });
export const endPolicyAssignment = (tx: Tx, auth: AuthContext, id: number, to: string | null) => endAssignment(tx, auth, POLICY_ASSIGNMENT, id, to);
export const endCalendarAssignment = (tx: Tx, auth: AuthContext, id: number, to: string | null) => endAssignment(tx, auth, CALENDAR_ASSIGNMENT, id, to);
export const deletePolicyAssignment = (tx: Tx, auth: AuthContext, id: number) => deleteFutureAssignment(tx, auth, POLICY_ASSIGNMENT, id);
export const deleteCalendarAssignment = (tx: Tx, auth: AuthContext, id: number) => deleteFutureAssignment(tx, auth, CALENDAR_ASSIGNMENT, id);

export async function listPolicyAssignments(tx: Tx, q: { employeeId?: number; policyId?: number }) {
  const r = await tx.query(
    `SELECT a.*, e.full_name AS employee_name, e.employee_code, p.name AS policy_name, u.full_name AS assigned_by_name
       FROM leave_policy_assignments a
       JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       JOIN leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id
       LEFT JOIN users u ON u.id = a.assigned_by
      WHERE ($1::bigint IS NULL OR a.employee_id = $1) AND ($2::bigint IS NULL OR a.policy_id = $2)
      ORDER BY a.effective_from DESC, a.id DESC`,
    [q.employeeId ?? null, q.policyId ?? null],
  );
  return r.rows;
}

export async function listCalendarAssignments(tx: Tx, q: { employeeId?: number; calendarId?: number }) {
  const r = await tx.query(
    `SELECT a.*, e.full_name AS employee_name, e.employee_code, c.name AS calendar_name, c.calendar_year, u.full_name AS assigned_by_name
       FROM leave_calendar_assignments a
       JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       JOIN leave_holiday_calendars c ON c.tenant_id = a.tenant_id AND c.id = a.calendar_id
       LEFT JOIN users u ON u.id = a.assigned_by
      WHERE ($1::bigint IS NULL OR a.employee_id = $1) AND ($2::bigint IS NULL OR a.calendar_id = $2)
      ORDER BY a.effective_from DESC, a.id DESC`,
    [q.employeeId ?? null, q.calendarId ?? null],
  );
  return r.rows;
}

/** What each employee is on today, whether explicitly assigned or through a default. */
export async function listEmployeeAssignments(
  tx: Tx,
  q: { search?: string; departmentId?: number; limit?: number; offset?: number },
) {
  const params: unknown[] = [q.search?.trim() ? likeTerm(q.search) : null, q.departmentId ?? null];
  const where = `e.status <> 'exited'
    AND ($1::text IS NULL OR e.full_name ILIKE $1 OR e.employee_code ILIKE $1)
    AND ($2::bigint IS NULL OR e.department_id = $2)`;
  const total = await tx.query(`SELECT count(*)::int AS n FROM employees e WHERE ${where}`, params);
  const limit = Math.min(q.limit ?? 25, 100);
  const offset = q.offset ?? 0;
  const r = await tx.query(
    `SELECT e.id, e.full_name, e.employee_code, e.employment_type, e.work_location, d.name AS department_name,
            COALESCE(pa.name, pd.name) AS policy_name, (pa.id IS NULL AND pd.id IS NOT NULL) AS policy_is_default,
            COALESCE(ca.name, cl.name, cd.name) AS calendar_name,
            CASE WHEN ca.id IS NOT NULL THEN 'assigned' WHEN cl.id IS NOT NULL THEN 'location'
                 WHEN cd.id IS NOT NULL THEN 'default' END AS calendar_source
       FROM employees e
       LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
       LEFT JOIN LATERAL (
         SELECT p.id, p.name FROM leave_policy_assignments a
           JOIN leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id AND p.status = 'active'
          WHERE a.employee_id = e.id AND daterange(a.effective_from, a.effective_to, '[]') @> tenant_today() LIMIT 1) pa ON true
       LEFT JOIN LATERAL (
         SELECT p.id, p.name FROM leave_policies p
          WHERE p.is_default AND p.status = 'active' AND daterange(p.effective_from, p.effective_to, '[]') @> tenant_today() LIMIT 1) pd ON true
       LEFT JOIN LATERAL (
         SELECT c.id, c.name FROM leave_calendar_assignments a
           JOIN leave_holiday_calendars c ON c.tenant_id = a.tenant_id AND c.id = a.calendar_id
            AND c.status = 'active' AND c.calendar_year = extract(year FROM tenant_today())::int
          WHERE a.employee_id = e.id AND daterange(a.effective_from, a.effective_to, '[]') @> tenant_today() LIMIT 1) ca ON true
       LEFT JOIN LATERAL (
         SELECT c.id, c.name FROM leave_holiday_calendars c
          WHERE c.status = 'active' AND c.calendar_year = extract(year FROM tenant_today())::int
            AND c.location IS NOT NULL AND lower(c.location) = lower(e.work_location) LIMIT 1) cl ON true
       LEFT JOIN LATERAL (
         SELECT c.id, c.name FROM leave_holiday_calendars c
          WHERE c.status = 'active' AND c.is_default AND c.calendar_year = extract(year FROM tenant_today())::int LIMIT 1) cd ON true
      WHERE ${where}
      ORDER BY e.full_name
      LIMIT $3 OFFSET $4`,
    [...params, limit, offset],
  );
  return { items: r.rows, total: total.rows[0].n, limit, offset };
}

// ----------------------------------------------------------- accrual rules ---

export async function listAccrualRules(tx: Tx, q: { policyId?: number } = {}) {
  const r = await tx.query(
    `SELECT r.*, en.policy_id, en.leave_type_id, en.annual_entitlement, p.name AS policy_name, lt.name AS leave_type_name
       FROM leave_accrual_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
       JOIN leave_policies p ON p.tenant_id = en.tenant_id AND p.id = en.policy_id
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
      WHERE ($1::bigint IS NULL OR en.policy_id = $1)
      ORDER BY r.status = 'archived', p.name, lt.name, r.effective_from DESC`,
    [q.policyId ?? null],
  );
  return r.rows;
}

export async function createAccrualRule(tx: Tx, auth: AuthContext, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  const r = await tx.query(
    `INSERT INTO leave_accrual_rules (tenant_id, policy_entitlement_id, accrual_frequency, accrual_amount, accrual_start_rule,
                                      credit_timing, proration_enabled, maximum_balance, effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [auth.tenantId, b.policyEntitlementId, b.accrualFrequency, b.accrualAmount ?? 0, b.accrualStartRule ?? 'joining_date',
     b.creditTiming ?? 'period_start', b.prorationEnabled ?? false, b.maximumBalance ?? null, b.effectiveFrom, b.effectiveTo ?? null],
  );
  await leaveAudit(tx, auth, 'accrual_rule.create', 'accrual_rule', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

async function assertDraft(tx: Tx, table: string, id: number, what: string) {
  const r = await tx.query(`SELECT status FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw notFound(what);
  if (r.rows[0].status !== 'draft') {
    throw conflict('RULE_NOT_DRAFT', 'Only draft rules can be edited. Archive this rule and create a new one; past credits stay as they are.');
  }
}

export async function updateAccrualRule(tx: Tx, auth: AuthContext, id: number, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  await assertDraft(tx, 'leave_accrual_rules', id, 'Accrual rule');
  return updateRow(tx, auth, 'leave_accrual_rules', 'accrual_rule', id, b, {
    accrualFrequency: 'accrual_frequency', accrualAmount: 'accrual_amount', accrualStartRule: 'accrual_start_rule',
    creditTiming: 'credit_timing', prorationEnabled: 'proration_enabled', maximumBalance: 'maximum_balance',
    effectiveFrom: 'effective_from', effectiveTo: 'effective_to',
  });
}

export const getAccrualImpact = async (tx: Tx, auth: AuthContext, id: number) => {
  const impact = await accrualRuleImpact(tx, auth.tenantId, id);
  if (!impact) throw notFound('Accrual rule');
  return impact;
};

async function setRuleStatus(tx: Tx, auth: AuthContext, table: string, audit: string, id: number, status: 'active' | 'archived') {
  const before = (await tx.query(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('Rule');
  if (before.status === 'archived') throw conflict('RULE_ARCHIVED', 'An archived rule cannot change; create a new one');
  const r = await tx.query(`UPDATE ${table} SET status = $2 WHERE id = $1 RETURNING *`, [id, status]);
  await leaveAudit(tx, auth, `${audit}.${status === 'active' ? 'activate' : 'archive'}`, audit, id, before, r.rows[0]);
  return r.rows[0];
}

export async function activateAccrualRule(tx: Tx, auth: AuthContext, id: number) {
  const rule = await setRuleStatus(tx, auth, 'leave_accrual_rules', 'accrual_rule', id, 'active');
  return { rule, impact: await accrualRuleImpact(tx, auth.tenantId, id) };
}
export const archiveAccrualRule = (tx: Tx, auth: AuthContext, id: number) =>
  setRuleStatus(tx, auth, 'leave_accrual_rules', 'accrual_rule', id, 'archived');

// ----------------------------------------------------- carry-forward rules ---

export async function listCarryForwardRules(tx: Tx, q: { policyId?: number } = {}) {
  const r = await tx.query(
    `SELECT r.*, en.policy_id, en.leave_type_id, en.allow_carry_forward, en.allow_encashment,
            p.name AS policy_name, lt.name AS leave_type_name
       FROM leave_carry_forward_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
       JOIN leave_policies p ON p.tenant_id = en.tenant_id AND p.id = en.policy_id
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
      WHERE ($1::bigint IS NULL OR en.policy_id = $1)
      ORDER BY r.status = 'archived', p.name, lt.name, r.effective_from DESC`,
    [q.policyId ?? null],
  );
  return r.rows;
}

export async function createCarryForwardRule(tx: Tx, auth: AuthContext, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  const r = await tx.query(
    `INSERT INTO leave_carry_forward_rules (tenant_id, policy_entitlement_id, is_enabled, maximum_carry_forward, maximum_balance,
                                            expiry_enabled, expiry_after_months, expiry_date_rule, encashment_allowed,
                                            effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [auth.tenantId, b.policyEntitlementId, b.isEnabled ?? true, b.maximumCarryForward ?? null, b.maximumBalance ?? null,
     b.expiryEnabled ?? false, b.expiryAfterMonths ?? null, b.expiryDateRule ?? 'months_after_carry',
     b.encashmentAllowed ?? false, b.effectiveFrom, b.effectiveTo ?? null],
  );
  await leaveAudit(tx, auth, 'carry_forward_rule.create', 'carry_forward_rule', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function updateCarryForwardRule(tx: Tx, auth: AuthContext, id: number, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  await assertDraft(tx, 'leave_carry_forward_rules', id, 'Carry-forward rule');
  return updateRow(tx, auth, 'leave_carry_forward_rules', 'carry_forward_rule', id, b, {
    isEnabled: 'is_enabled', maximumCarryForward: 'maximum_carry_forward', maximumBalance: 'maximum_balance',
    expiryEnabled: 'expiry_enabled', expiryAfterMonths: 'expiry_after_months', expiryDateRule: 'expiry_date_rule',
    encashmentAllowed: 'encashment_allowed', effectiveFrom: 'effective_from', effectiveTo: 'effective_to',
  });
}

export async function activateCarryForwardRule(tx: Tx, auth: AuthContext, id: number) {
  const en = await tx.query(
    `SELECT en.allow_carry_forward, lt.name FROM leave_carry_forward_rules r
       JOIN leave_policy_entitlements en ON en.tenant_id = r.tenant_id AND en.id = r.policy_entitlement_id
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
      WHERE r.id = $1`,
    [id],
  );
  if (!en.rowCount) throw notFound('Carry-forward rule');
  if (!en.rows[0].allow_carry_forward) {
    throw unprocessable('CARRY_FORWARD_NOT_ALLOWED', `The policy does not allow carry-forward of ${en.rows[0].name}. Change the entitlement first.`);
  }
  return setRuleStatus(tx, auth, 'leave_carry_forward_rules', 'carry_forward_rule', id, 'active');
}
export const archiveCarryForwardRule = (tx: Tx, auth: AuthContext, id: number) =>
  setRuleStatus(tx, auth, 'leave_carry_forward_rules', 'carry_forward_rule', id, 'archived');

// ---------------------------------------------------------- comp off rules ---

export async function listCompOffRules(tx: Tx) {
  const r = await tx.query(
    `SELECT r.*, lt.name AS leave_type_name, lt.code AS leave_type_code
       FROM leave_comp_off_rules r
       JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
      ORDER BY r.is_active DESC, lt.name, r.effective_from DESC`,
  );
  return r.rows;
}

export async function createCompOffRule(tx: Tx, auth: AuthContext, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  const r = await tx.query(
    `INSERT INTO leave_comp_off_rules (tenant_id, leave_type_id, minimum_work_hours, earned_days, eligible_work_day_type,
                                       approval_required, expiry_enabled, expiry_after_days, maximum_balance, effective_from, effective_to)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [auth.tenantId, b.leaveTypeId, b.minimumWorkHours, b.earnedDays, b.eligibleWorkDayType ?? 'non_working',
     b.approvalRequired ?? true, b.expiryEnabled ?? false, b.expiryAfterDays ?? null, b.maximumBalance ?? null,
     b.effectiveFrom, b.effectiveTo ?? null],
  );
  await leaveAudit(tx, auth, 'comp_off_rule.create', 'comp_off_rule', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function updateCompOffRule(tx: Tx, auth: AuthContext, id: number, b: any) {
  assertDates(b.effectiveFrom, b.effectiveTo);
  return updateRow(tx, auth, 'leave_comp_off_rules', 'comp_off_rule', id, b, {
    minimumWorkHours: 'minimum_work_hours', earnedDays: 'earned_days', eligibleWorkDayType: 'eligible_work_day_type',
    approvalRequired: 'approval_required', expiryEnabled: 'expiry_enabled', expiryAfterDays: 'expiry_after_days',
    maximumBalance: 'maximum_balance', effectiveFrom: 'effective_from', effectiveTo: 'effective_to', isActive: 'is_active',
  });
}

// ----------------------------------------------------------------- lookups ---

export async function getLookups(tx: Tx) {
  const departments = await tx.query(`SELECT id, name FROM departments WHERE is_active ORDER BY name`);
  const locations = await tx.query(`SELECT DISTINCT work_location AS name FROM employees WHERE work_location IS NOT NULL AND work_location <> '' ORDER BY 1`);
  const types = await tx.query(`SELECT id, code, name, category, is_active FROM leave_types ORDER BY name`);
  const policies = await tx.query(`SELECT id, code, name, status FROM leave_policies ORDER BY name`);
  const calendars = await tx.query(`SELECT id, code, name, calendar_year, status FROM leave_holiday_calendars ORDER BY calendar_year DESC, name`);
  return {
    departments: departments.rows,
    locations: locations.rows.map((r) => r.name),
    leaveTypes: types.rows,
    policies: policies.rows,
    calendars: calendars.rows,
  };
}

export async function searchEmployees(tx: Tx, q: { search?: string; limit?: number }) {
  const r = await tx.query(
    `SELECT e.id, e.user_id, e.full_name, e.employee_code, d.name AS department_name
       FROM employees e
       LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      WHERE e.status <> 'exited' AND ($1::text IS NULL OR e.full_name ILIKE $1 OR e.employee_code ILIKE $1)
      ORDER BY e.full_name
      LIMIT $2`,
    [q.search?.trim() ? likeTerm(q.search) : null, Math.min(q.limit ?? 50, 200)],
  );
  return r.rows;
}

const EMPLOYEE_CONDITION_FIELDS = [
  { field: 'employmentType', label: 'Employee category', type: 'string' },
  { field: 'departmentName', label: 'Department', type: 'string' },
  { field: 'departmentId', label: 'Department id', type: 'number' },
  { field: 'managerEmployeeId', label: 'Reporting manager (employee id)', type: 'number' },
];

const CONDITION_FIELDS: Record<string, { field: string; label: string; type: string }[]> = {
  leave: [
    { field: 'totalDays', label: 'Number of leave days', type: 'number' },
    { field: 'leaveTypeCode', label: 'Leave type code', type: 'string' },
    { field: 'leaveCategory', label: 'Leave category', type: 'string' },
    { field: 'isPaid', label: 'Paid leave', type: 'boolean' },
    ...EMPLOYEE_CONDITION_FIELDS,
  ],
  comp_off: [
    { field: 'hoursWorked', label: 'Hours worked', type: 'number' },
    { field: 'earnedDays', label: 'Days earned', type: 'number' },
    { field: 'workDayType', label: 'Day worked (weekly_off, holiday, working)', type: 'string' },
    { field: 'leaveTypeCode', label: 'Leave type code', type: 'string' },
    ...EMPLOYEE_CONDITION_FIELDS,
  ],
};

/** What the workflow builder needs for a module: roles to pick from and the fields conditions may use. */
export async function getWorkflowOptions(tx: Tx, module = 'leave') {
  const roles = await tx.query(`SELECT id, name FROM roles WHERE is_active ORDER BY name`);
  return {
    roles: roles.rows,
    requiredPermission: 'leave.request.approve',
    conditionFields: CONDITION_FIELDS[module] ?? CONDITION_FIELDS.leave,
  };
}

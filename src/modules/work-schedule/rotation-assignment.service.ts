import type { Tx } from '../../config/db';
import { conflict, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { assertFresh, lockRow } from './named-config.service';
import { LIVE } from './rotation.service';
import { resolveRotation, rotationLabel, type RotationRule } from './work-schedule-calculation';
import { diffFields, writeAudit, type EntityType } from './work-schedule.audit';
import {
  assignmentOverlap, fieldValidation, inactiveReference, invalidAssignmentState, type OverlapConflict,
} from './work-schedule.errors';
import type {
  AssignmentBulkEnd, AssignmentCreate, AssignmentListQuery, AssignmentPatch,
} from './work-schedule.schemas';

/**
 * Rotating shift and rotating work type assignments: one service, two tables.
 *
 * Only the assignment (employee, pattern, dates) is stored. The current entry,
 * the next switch and the next entry are computed from the start date and the
 * pattern for tenant "today" (resolveRotation), never saved.
 *
 * Nothing is deleted. End sets an end date; Cancel is for assignments that
 * have not started. Every write follows the module's transaction pattern:
 * lock the row, compare updatedAt, check the rules, write the change and its
 * audit row; any failure rolls all of it back.
 */

export interface AssignmentKind {
  slug: 'rotating-shift' | 'rotating-work-type';
  table: string;
  patternTable: string;
  itemTable: string;
  refTable: string;
  refColumn: string;
  entityType: EntityType;
  /** "Rotating shift", for messages. */
  patternLabel: string;
}

export const rotatingShiftAssignments: AssignmentKind = {
  slug: 'rotating-shift', table: 'rotating_shift_assignments', patternTable: 'rotating_shift_patterns',
  itemTable: 'rotating_shift_pattern_items', refTable: 'work_shifts', refColumn: 'shift_id',
  entityType: 'rotating_shift_assignment', patternLabel: 'Rotating shift',
};

export const rotatingWorkTypeAssignments: AssignmentKind = {
  slug: 'rotating-work-type', table: 'rotating_work_type_assignments', patternTable: 'rotating_work_type_patterns',
  itemTable: 'rotating_work_type_pattern_items', refTable: 'work_types', refColumn: 'work_type_id',
  entityType: 'rotating_work_type_assignment', patternLabel: 'Rotating work type',
};

export interface Entry { id: number; name: string }

export interface Assignment {
  id: number;
  employee: { id: number; name: string; code: string; jobTitle: string | null };
  pattern: { id: number; name: string; isActive: boolean };
  rotation: RotationRule;
  /** "Every 5 days", "Every Monday", "Monthly on the last day" */
  rotateLabel: string;
  /** "Morning > Night" */
  sequenceSummary: string;
  startDate: string;
  endDate: string | null;
  status: 'active' | 'ended' | 'cancelled';
  /** Where the assignment is today: computed, not stored. */
  phase: 'upcoming' | 'current' | 'completed' | 'cancelled';
  reason: string | null;
  assignedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
  current: Entry | null;
  nextSwitch: string | null;
  next: Entry | null;
}

export const MAX_EXPORT_ROWS = 5000;

function ruleFromRow(r: any): RotationRule {
  if (r.based_on === 'after') return { basedOn: 'after', afterDays: r.rotate_after_days };
  if (r.based_on === 'weekly') return { basedOn: 'weekly', weekday: r.rotate_weekday };
  if (r.based_on === 'monthly') return { basedOn: 'monthly', monthDay: r.rotate_last_day ? 'last' : r.rotate_month_day };
  throw new Error(`Assignment ${r.id} has no valid rotation rule (based_on=${r.based_on}); is the database migrated to 023?`);
}

/** [based_on, after_days, weekday, month_day, last_day] */
const ruleColumns = (rule: RotationRule): [string, number | null, number | null, number | null, boolean] =>
  rule.basedOn === 'after' ? ['after', rule.afterDays, null, null, false]
    : rule.basedOn === 'weekly' ? ['weekly', null, rule.weekday, null, false]
      : ['monthly', null, null, rule.monthDay === 'last' ? null : rule.monthDay, rule.monthDay === 'last'];

// ------------------------------------------------------------------ reads ---

export const tenantToday = async (tx: Tx): Promise<string> =>
  (await tx.query(`SELECT tenant_today()::text AS d`)).rows[0].d;

const baseSelect = (k: AssignmentKind) => `
  SELECT a.*, e.full_name AS employee_name, e.employee_code, e.job_title,
         p.name AS pattern_name, p.is_active AS pattern_active
    FROM ${k.table} a
    JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
    JOIN ${k.patternTable} p ON p.tenant_id = a.tenant_id AND p.id = a.pattern_id`;

const likeTerm = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const ORDER: Record<AssignmentListQuery['sort'], string> = {
  '-startDate': 'x.start_date DESC, lower(x.employee_name)',
  startDate: 'x.start_date ASC, lower(x.employee_name)',
  employee: 'lower(x.employee_name) ASC, x.start_date DESC',
  '-employee': 'lower(x.employee_name) DESC, x.start_date DESC',
};

/** Turn rows into API records, computing the rotation for today. */
async function hydrate(tx: Tx, k: AssignmentKind, rows: any[]): Promise<Assignment[]> {
  if (!rows.length) return [];
  const today = await tenantToday(tx);
  const patternIds = [...new Set(rows.map((r) => Number(r.pattern_id)))];
  const items = await tx.query(
    `SELECT i.pattern_id, x.id, x.name FROM ${k.itemTable} i
       JOIN ${k.refTable} x ON x.tenant_id = i.tenant_id AND x.id = i.${k.refColumn}
      WHERE i.pattern_id = ANY($1::bigint[]) ORDER BY i.pattern_id, i.sequence_order`,
    [patternIds],
  );
  const byPattern = new Map<number, Entry[]>();
  for (const it of items.rows) {
    const list = byPattern.get(Number(it.pattern_id)) ?? [];
    list.push({ id: Number(it.id), name: it.name });
    byPattern.set(Number(it.pattern_id), list);
  }
  return rows.map((r) => {
    const entries = byPattern.get(Number(r.pattern_id)) ?? [];
    const rule = ruleFromRow(r);
    const res = resolveRotation<Entry>({
      startDate: r.start_date, endDate: r.end_date, today, rule, items: entries,
    });
    const cancelled = r.status === 'cancelled';
    return {
      id: Number(r.id),
      employee: { id: Number(r.employee_id), name: r.employee_name, code: r.employee_code, jobTitle: r.job_title ?? null },
      pattern: {
        id: Number(r.pattern_id), name: r.pattern_name, isActive: r.pattern_active,
      },
      rotation: rule,
      rotateLabel: rotationLabel(rule),
      sequenceSummary: entries.map((e) => e.name).join(' > '),
      startDate: r.start_date,
      endDate: r.end_date ?? null,
      status: r.status,
      phase: cancelled ? 'cancelled' : res.state,
      reason: r.reason ?? null,
      assignedBy: r.assigned_by == null ? null : Number(r.assigned_by),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      // A cancelled assignment never takes effect, so it shows no rotation.
      current: cancelled ? null : res.current,
      nextSwitch: cancelled ? null : res.nextSwitch,
      next: cancelled ? null : res.next,
    };
  });
}

function listSql(k: AssignmentKind) {
  return `SELECT x.*, count(*) OVER ()::int AS total_count FROM (${baseSelect(k)}) x
           WHERE ($1::text IS NULL OR x.employee_name ILIKE $1 OR x.employee_code ILIKE $1)
             AND ($2::text = 'all' OR x.status = $2)
             AND ($3::bigint IS NULL OR x.pattern_id = $3)
             AND ($4::date IS NULL OR x.end_date IS NULL OR x.end_date >= $4)
             AND ($5::date IS NULL OR x.start_date <= $5)`;
}
const listParams = (q: AssignmentListQuery) =>
  [q.search ? likeTerm(q.search) : null, q.status, q.patternId ?? null, q.from ?? null, q.to ?? null];

export async function listAssignments(tx: Tx, k: AssignmentKind, q: AssignmentListQuery) {
  const r = await tx.query(
    `${listSql(k)} ORDER BY ${ORDER[q.sort]}, x.id LIMIT $6 OFFSET $7`,
    [...listParams(q), q.limit, (q.page - 1) * q.limit],
  );
  return { items: await hydrate(tx, k, r.rows), total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit };
}

export async function getAssignment(tx: Tx, k: AssignmentKind, id: number): Promise<Assignment> {
  const r = await tx.query(`SELECT x.* FROM (${baseSelect(k)}) x WHERE x.id = $1`, [id]);
  if (!r.rowCount) throw notFound('Assignment');
  return (await hydrate(tx, k, r.rows))[0];
}

async function getMany(tx: Tx, k: AssignmentKind, ids: number[]): Promise<Assignment[]> {
  const r = await tx.query(`SELECT x.* FROM (${baseSelect(k)}) x WHERE x.id = ANY($1::bigint[]) ORDER BY lower(x.employee_name), x.id`, [ids]);
  return hydrate(tx, k, r.rows);
}

// ------------------------------------------------------------------ export ---

/** Spreadsheet formula injection: a cell that starts with = + - @ is read as a formula. */
const csvCell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV of the filtered list (all pages, capped). */
export async function exportAssignmentsCsv(tx: Tx, k: AssignmentKind, q: AssignmentListQuery) {
  const r = await tx.query(`${listSql(k)} ORDER BY ${ORDER[q.sort]}, x.id LIMIT $6`, [...listParams(q), MAX_EXPORT_ROWS]);
  const rows = await hydrate(tx, k, r.rows);
  const header = ['Employee', 'Employee code', 'Pattern', 'Rotates', 'Sequence', 'Start date', 'End date', 'Status',
    'Current', 'Next switch', 'Next', 'Reason'];
  const lines = rows.map((a) => [
    a.employee.name, a.employee.code, a.pattern.name, a.rotateLabel, a.sequenceSummary, a.startDate, a.endDate ?? '',
    a.phase, a.current?.name ?? '', a.nextSwitch ?? '', a.next?.name ?? '', a.reason ?? '',
  ].map(csvCell).join(','));
  return { csv: [header.join(','), ...lines].join('\r\n') + '\r\n', truncated: (r.rows[0]?.total_count ?? 0) > MAX_EXPORT_ROWS };
}

// --------------------------------------------------------------- overlaps ---

/**
 * Live (non-cancelled) assignments of these employees whose dates overlap
 * [start, end]. The exclusion constraint is the backstop; this gives the
 * caller the names to show.
 */
async function findConflicts(
  tx: Tx, k: AssignmentKind, employeeIds: number[], start: string, end: string | null, exceptId?: number,
): Promise<OverlapConflict[]> {
  const r = await tx.query(
    `SELECT a.id, a.employee_id, e.full_name, p.name AS pattern_name, a.start_date, a.end_date
       FROM ${k.table} a
       JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
       JOIN ${k.patternTable} p ON p.tenant_id = a.tenant_id AND p.id = a.pattern_id
      WHERE a.employee_id = ANY($1::bigint[]) AND a.status <> 'cancelled'
        AND ($4::bigint IS NULL OR a.id <> $4)
        AND daterange(a.start_date, a.end_date, '[]') && daterange($2::date, $3::date, '[]')
      ORDER BY lower(e.full_name), a.start_date`,
    [employeeIds, start, end, exceptId ?? null],
  );
  return r.rows.map((x) => ({
    employeeId: Number(x.employee_id), employeeName: x.full_name, assignmentId: Number(x.id),
    patternName: x.pattern_name, startDate: x.start_date, endDate: x.end_date ?? null,
  }));
}

/** One bulk write at a time per tenant and kind, so the pre-check cannot race another request. */
const lockAssignments = (tx: Tx, k: AssignmentKind, tenantId: number) =>
  tx.query(`SELECT pg_advisory_xact_lock(hashtext($1), $2::int)`, [`ws-assign:${k.table}`, tenantId]);

/** The pattern must exist in this tenant and be active; FOR SHARE holds it until commit. */
async function lockUsablePattern(tx: Tx, k: AssignmentKind, patternId: number) {
  const r = await tx.query(`SELECT id, name, is_active FROM ${k.patternTable} WHERE id = $1 FOR SHARE`, [patternId]);
  if (!r.rowCount) throw fieldValidation(`Unknown ${k.patternLabel.toLowerCase()}`, { patternId: 'Choose a pattern' });
  if (!r.rows[0].is_active) {
    throw inactiveReference(`"${r.rows[0].name}" is deactivated. Choose an active pattern.`, 'patternId');
  }
  const items = await tx.query(`SELECT count(*)::int AS n FROM ${k.itemTable} WHERE pattern_id = $1`, [patternId]);
  if (items.rows[0].n < 2) throw fieldValidation('This pattern has fewer than 2 entries', { patternId: 'This pattern is incomplete' });
  return r.rows[0] as { id: number; name: string };
}

const auditView = (a: Assignment) => ({
  employeeId: a.employee.id, employeeName: a.employee.name, patternId: a.pattern.id, patternName: a.pattern.name,
  rotation: a.rotateLabel, startDate: a.startDate, endDate: a.endDate, status: a.status, reason: a.reason,
});

// ----------------------------------------------------------------- create ---

/** Bulk create: all employees or none. On any overlap nothing is saved and every clash is listed. */
export async function createAssignments(tx: Tx, auth: AuthContext, k: AssignmentKind, body: AssignmentCreate) {
  await lockAssignments(tx, k, auth.tenantId);
  const today = await tenantToday(tx);
  if (body.startDate < today && !body.reason?.trim()) {
    throw fieldValidation('A reason is required for a past start date', { reason: 'Give a reason for a past start date' });
  }
  const pattern = await lockUsablePattern(tx, k, body.patternId);

  const emp = await tx.query(`SELECT id, full_name, status FROM employees WHERE id = ANY($1::bigint[])`, [body.employeeIds]);
  const found = new Map(emp.rows.map((e) => [Number(e.id), e]));
  const ineligible = body.employeeIds.flatMap((id) => {
    const e = found.get(id);
    if (!e) return [{ id, name: `#${id}`, reason: 'Not found' }];
    return e.status === 'exited' ? [{ id, name: e.full_name as string, reason: 'Has left the organization' }] : [];
  });
  if (ineligible.length) {
    const message = 'Some employees cannot be assigned';
    throw unprocessable('VALIDATION_FAILED', message, { fieldErrors: { employeeIds: message }, ineligible });
  }

  const clashes = await findConflicts(tx, k, body.employeeIds, body.startDate, null);
  if (clashes.length) throw assignmentOverlap(clashes);

  const inserted = await tx.query(
    `INSERT INTO ${k.table} (tenant_id, employee_id, pattern_id, start_date, status, reason, assigned_by,
                              based_on, rotate_after_days, rotate_weekday, rotate_month_day, rotate_last_day)
     SELECT $1, e, $2, $3, 'active', $4, $5, $7, $8, $9, $10, $11 FROM unnest($6::bigint[]) AS e
     RETURNING id`,
    [auth.tenantId, pattern.id, body.startDate, body.reason?.trim() || null, auth.userId, body.employeeIds, ...ruleColumns(body.rotation)],
  );
  const created = await getMany(tx, k, inserted.rows.map((r) => Number(r.id)));
  for (const a of created) {
    await writeAudit(tx, auth, { action: 'created', entityType: k.entityType, entityId: a.id, before: null, after: auditView(a) });
  }
  return { items: created, total: created.length };
}

// ------------------------------------------------------------------- edit ---

/**
 * Before the start date: pattern, start date, end date and reason can change.
 * After it starts: only the end date and reason, because the computed current
 * entry must never change retroactively. To switch pattern, end the
 * assignment and create a new one from tomorrow.
 */
export async function updateAssignment(tx: Tx, auth: AuthContext, k: AssignmentKind, id: number, body: AssignmentPatch) {
  await lockAssignments(tx, k, auth.tenantId);
  const row = await lockRow(tx, k.table, id, 'Assignment');
  assertFresh(row, body.updatedAt);
  if (row.status !== 'active') throw invalidAssignmentState(`${row.status === 'ended' ? 'An ended' : 'A cancelled'} assignment cannot be edited`);

  const today = await tenantToday(tx);
  const started = row.start_date <= today;
  const patternId = body.patternId ?? Number(row.pattern_id);
  const startDate = body.startDate ?? row.start_date;
  const endDate = body.endDate !== undefined ? body.endDate : row.end_date;
  const reason = body.reason !== undefined ? body.reason : row.reason;

  const patternChanged = patternId !== Number(row.pattern_id);
  const startChanged = startDate !== row.start_date;
  const rule = body.rotation ?? ruleFromRow(row);
  const ruleChanged = JSON.stringify(rule) !== JSON.stringify(ruleFromRow(row));
  if (started && (patternChanged || startChanged || ruleChanged)) {
    throw invalidAssignmentState(
      'This assignment has started, so only the end date and reason can change. To switch pattern or rotation, end it and create a new one from tomorrow.',
      { ...(ruleChanged && { rotation: 'Cannot change after the start date' }), ...(patternChanged && { patternId: 'Cannot change after the start date' }), ...(startChanged && { startDate: 'Cannot change after the start date' }) },
    );
  }

  const errors: Record<string, string> = {};
  if (startChanged && startDate < today) errors.startDate = 'Start date cannot be in the past';
  if (endDate && endDate < startDate) errors.endDate = 'End date is before the start date';
  else if (endDate && endDate < today && endDate !== row.end_date) errors.endDate = 'End date cannot be in the past';
  if (Object.keys(errors).length) throw fieldValidation('The assignment is not valid', errors);

  const unchanged = !patternChanged && !startChanged && !ruleChanged && endDate === row.end_date && (reason ?? null) === (row.reason ?? null);
  const before = await getAssignment(tx, k, id);
  if (unchanged) return before;

  if (patternChanged) await lockUsablePattern(tx, k, patternId);
  if (startChanged || endDate !== row.end_date) {
    const clashes = await findConflicts(tx, k, [Number(row.employee_id)], startDate, endDate, id);
    if (clashes.length) throw assignmentOverlap(clashes);
  }

  await tx.query(
    `UPDATE ${k.table} SET pattern_id = $2, start_date = $3, end_date = $4, reason = $5,
            based_on = $6, rotate_after_days = $7, rotate_weekday = $8, rotate_month_day = $9, rotate_last_day = $10
      WHERE id = $1`,
    [id, patternId, startDate, endDate, reason?.toString().trim() || null, ...ruleColumns(rule)],
  );
  const after = await getAssignment(tx, k, id);
  const diff = diffFields({ ...auditView(before) }, { ...auditView(after) });
  if (diff) await writeAudit(tx, auth, { action: 'updated', entityType: k.entityType, entityId: id, ...diff });
  return after;
}

// -------------------------------------------------------------- end, cancel ---

function validateEnd(row: any, today: string, endDate: string | null) {
  if (row.status !== 'active') {
    throw invalidAssignmentState(`${row.status === 'ended' ? 'This assignment has already ended' : 'This assignment was cancelled'}`);
  }
  if (row.start_date > today) {
    throw invalidAssignmentState('This assignment has not started yet. Cancel it instead.');
  }
  const end = endDate ?? today;
  if (end < today) throw fieldValidation('The end date cannot be in the past', { endDate: 'End date cannot be in the past' });
  if (end < row.start_date) throw fieldValidation('The end date is before the start date', { endDate: 'End date is before the start date' });
  return end;
}

/** End a started assignment. The end date defaults to tenant today. */
export async function endAssignment(
  tx: Tx, auth: AuthContext, k: AssignmentKind, id: number, body: { endDate?: string | null; updatedAt: string },
) {
  const row = await lockRow(tx, k.table, id, 'Assignment');
  assertFresh(row, body.updatedAt);
  const today = await tenantToday(tx);
  const end = validateEnd(row, today, body.endDate ?? null);
  await tx.query(`UPDATE ${k.table} SET status = 'ended', end_date = $2 WHERE id = $1`, [id, end]);
  await writeAudit(tx, auth, {
    action: 'ended', entityType: k.entityType, entityId: id,
    before: { status: 'active', endDate: row.end_date ?? null }, after: { status: 'ended', endDate: end },
  });
  return getAssignment(tx, k, id);
}

/** Cancel an assignment that has not started. It never took effect, so it frees the employee. */
export async function cancelAssignment(
  tx: Tx, auth: AuthContext, k: AssignmentKind, id: number, body: { reason?: string | null; updatedAt: string },
) {
  const row = await lockRow(tx, k.table, id, 'Assignment');
  assertFresh(row, body.updatedAt);
  if (row.status !== 'active') {
    throw invalidAssignmentState(row.status === 'ended' ? 'An ended assignment cannot be cancelled' : 'This assignment is already cancelled');
  }
  const today = await tenantToday(tx);
  if (row.start_date <= today) {
    throw invalidAssignmentState('This assignment has started. End it instead of cancelling.');
  }
  const reason = body.reason?.trim() || row.reason || null;
  await tx.query(`UPDATE ${k.table} SET status = 'cancelled', reason = $2 WHERE id = $1`, [id, reason]);
  await writeAudit(tx, auth, {
    action: 'cancelled', entityType: k.entityType, entityId: id,
    before: { status: 'active' }, after: { status: 'cancelled', reason },
  });
  return getAssignment(tx, k, id);
}

/** End several assignments at once; if any cannot be ended, none is. */
export async function bulkEndAssignments(tx: Tx, auth: AuthContext, k: AssignmentKind, body: AssignmentBulkEnd) {
  const ids = [...body.ids].sort((a, b) => a - b); // fixed lock order: no deadlocks between two bulk ends
  const locked = await tx.query(`SELECT * FROM ${k.table} WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [ids]);
  const rows = new Map(locked.rows.map((r) => [Number(r.id), r]));
  const missing = ids.filter((id) => !rows.has(id));
  if (missing.length) throw notFound('Assignment');

  const today = await tenantToday(tx);
  const names = await tx.query(
    `SELECT a.id, e.full_name FROM ${k.table} a JOIN employees e ON e.tenant_id = a.tenant_id AND e.id = a.employee_id
      WHERE a.id = ANY($1::bigint[])`, [ids]);
  const nameOf = new Map(names.rows.map((n) => [Number(n.id), n.full_name as string]));

  const end = body.endDate ?? today;
  const problems: { id: number; employeeName: string; reason: string }[] = [];
  for (const id of ids) {
    const row = rows.get(id)!;
    const why = row.status === 'ended' ? 'Already ended'
      : row.status === 'cancelled' ? 'Cancelled'
        : row.start_date > today ? 'Not started yet (cancel it instead)'
          : end < today ? 'End date is in the past'
            : end < row.start_date ? 'End date is before the start date' : null;
    if (why) problems.push({ id, employeeName: nameOf.get(id) ?? `#${id}`, reason: why });
  }
  if (problems.length) {
    throw conflict('INVALID_ASSIGNMENT_STATE',
      `${problems.length} assignment${problems.length === 1 ? ' cannot' : 's cannot'} be ended. Nothing was changed.`, { problems });
  }

  await tx.query(`UPDATE ${k.table} SET status = 'ended', end_date = $2 WHERE id = ANY($1::bigint[])`, [ids, end]);
  for (const id of ids) {
    const row = rows.get(id)!;
    await writeAudit(tx, auth, {
      action: 'ended', entityType: k.entityType, entityId: id,
      before: { status: 'active', endDate: row.end_date ?? null }, after: { status: 'ended', endDate: end },
    });
  }
  const items = await getMany(tx, k, ids);
  return { items, total: items.length };
}

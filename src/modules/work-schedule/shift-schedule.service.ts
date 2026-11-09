import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import {
  assertFresh, assertNameFree, baseFields, getRecord, guardName, listRecords, lockRow, setStatus,
  type BaseRecord, type ResourceDef,
} from './named-config.service';
import {
  spanMinutes, summarizeWorkingDays, toHHMM, validateWeek, weeklyOffWarnings, type ScheduleDayInput,
} from './work-schedule-calculation';
import { businessFields, diffFields, writeAudit } from './work-schedule.audit';
import { fieldValidation, inactiveReference } from './work-schedule.errors';
import type { ListQuery, ScheduleCreate, ScheduleDay, SchedulePatch, StatusBody } from './work-schedule.schemas';

/**
 * A shift schedule and its seven day rows are always written together, in
 * one transaction with the audit row. Times are wall-clock in the tenant's
 * timezone; an end at or before the start runs past midnight.
 */

export interface ScheduleDayView {
  dayOfWeek: number;
  isWorkingDay: boolean;
  startTime: string | null;
  endTime: string | null;
  minimumWorkingMinutes: number;
  isNightShift: boolean;
  /** Length of the working window in minutes (0 on a day off). */
  spanMinutes: number;
}

export interface ShiftSchedule extends BaseRecord {
  shiftId: number;
  shiftName: string;
  shiftActive: boolean;
  defaultMinimumWorkingMinutes: number;
  /** Stored only: no job reads it in this release. */
  automaticCheckoutEnabled: boolean;
  days: ScheduleDayView[];
  /** "Mon-Fri" */
  workingDaysSummary: string;
}

const COLUMNS: Record<string, string> = {
  name: 'name',
  description: 'description',
  shiftId: 'shift_id',
  defaultMinimumWorkingMinutes: 'default_minimum_working_minutes',
  automaticCheckoutEnabled: 'automatic_checkout_enabled',
};

export const shiftScheduleDef: ResourceDef<ShiftSchedule> = {
  table: 'work_shift_schedules',
  entityType: 'shift_schedule',
  label: 'Shift schedule',
  nameIndex: 'uq_work_shift_schedules_name',
  select: `
    SELECT ws.*, s.name AS shift_name, s.is_active AS shift_active
      FROM work_shift_schedules ws
      JOIN work_shifts s ON s.tenant_id = ws.tenant_id AND s.id = ws.shift_id`,
  toApi: (row) => ({
    ...baseFields(row),
    shiftId: Number(row.shift_id),
    shiftName: row.shift_name,
    shiftActive: row.shift_active,
    defaultMinimumWorkingMinutes: row.default_minimum_working_minutes,
    automaticCheckoutEnabled: row.automatic_checkout_enabled,
    days: [],
    workingDaysSummary: '',
  }),
  attach: attachDays,
  // Nothing references a schedule yet (employee assignments are out of scope).
  dependents: undefined,
  activationCheck: (tx, row) => assertShiftUsable(tx, Number(row.shift_id)),
};

async function attachDays(tx: Tx, records: ShiftSchedule[]): Promise<ShiftSchedule[]> {
  const r = await tx.query(
    `SELECT schedule_id, day_of_week, is_working_day, start_time::text AS start_time, end_time::text AS end_time,
            minimum_working_minutes, is_night_shift
       FROM work_shift_schedule_days
      WHERE schedule_id = ANY($1::bigint[])
      ORDER BY schedule_id, day_of_week`,
    [records.map((s) => s.id)],
  );
  const bySchedule = new Map<number, ScheduleDayView[]>();
  for (const row of r.rows) {
    const start = toHHMM(row.start_time);
    const end = toHHMM(row.end_time);
    const list = bySchedule.get(Number(row.schedule_id)) ?? [];
    list.push({
      dayOfWeek: row.day_of_week,
      isWorkingDay: row.is_working_day,
      startTime: start,
      endTime: end,
      minimumWorkingMinutes: row.minimum_working_minutes,
      isNightShift: row.is_night_shift,
      spanMinutes: start && end ? spanMinutes(start, end) : 0,
    });
    bySchedule.set(Number(row.schedule_id), list);
  }
  return records.map((s) => {
    const days = bySchedule.get(s.id) ?? [];
    return { ...s, days, workingDaysSummary: summarizeWorkingDays(days.filter((d) => d.isWorkingDay).map((d) => d.dayOfWeek)) };
  });
}

export const listShiftSchedules = (tx: Tx, q: ListQuery) => listRecords(tx, shiftScheduleDef, q);
export const getShiftSchedule = (tx: Tx, id: number) => getRecord(tx, shiftScheduleDef, id);

// --------------------------------------------------------------- checks ---

/** The shift must exist in this tenant and be active; FOR SHARE holds it until commit. */
async function assertShiftUsable(tx: Tx, shiftId: number) {
  const r = await tx.query(`SELECT name, is_active FROM work_shifts WHERE id = $1 FOR SHARE`, [shiftId]);
  if (!r.rowCount) throw fieldValidation('Unknown shift', { shiftId: 'Choose a shift' });
  if (!r.rows[0].is_active) {
    throw inactiveReference(`Shift "${r.rows[0].name}" is deactivated. Choose an active shift.`, 'shiftId');
  }
}

/** Sorted Monday..Sunday, with day-off fields cleared and missing minimums defaulted. */
function normalizeDays(days: ScheduleDay[], defaultMinimum: number): ScheduleDayInput[] {
  return [...days]
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => ({
      dayOfWeek: d.dayOfWeek,
      isWorkingDay: d.isWorkingDay,
      startTime: d.startTime ?? null,
      endTime: d.endTime ?? null,
      minimumWorkingMinutes: d.minimumWorkingMinutes ?? (d.isWorkingDay ? defaultMinimum : 0),
    }));
}

function assertWeek(days: ScheduleDay[], defaultMinimum: number) {
  // Validate in request order so error keys (days.N.field) point at what the client sent.
  const errors = validateWeek(days, defaultMinimum);
  if (Object.keys(errors).length) throw fieldValidation('The weekly schedule is not valid', errors);
}

async function writeDays(tx: Tx, tenantId: number, scheduleId: number, days: ScheduleDayInput[]) {
  for (const d of days) {
    await tx.query(
      `INSERT INTO work_shift_schedule_days
         (tenant_id, schedule_id, day_of_week, is_working_day, start_time, end_time, minimum_working_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, schedule_id, day_of_week) DO UPDATE
         SET is_working_day = EXCLUDED.is_working_day,
             start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time,
             minimum_working_minutes = EXCLUDED.minimum_working_minutes`,
      [tenantId, scheduleId, d.dayOfWeek, d.isWorkingDay,
       d.isWorkingDay ? d.startTime : null, d.isWorkingDay ? d.endTime : null,
       d.isWorkingDay ? d.minimumWorkingMinutes : 0],
    );
  }
}

async function tenantWeeklyOffs(tx: Tx): Promise<number[]> {
  const r = await tx.query(`SELECT weekly_offs FROM tenants WHERE id = current_tenant_id()`);
  return (r.rows[0]?.weekly_offs ?? []).map(Number);
}

const withWarnings = async (tx: Tx, s: ShiftSchedule) => ({ ...s, warnings: weeklyOffWarnings(s.days, await tenantWeeklyOffs(tx)) });

// ---------------------------------------------------------------- writes ---

export async function createShiftSchedule(tx: Tx, auth: AuthContext, body: ScheduleCreate) {
  const def = shiftScheduleDef;
  assertWeek(body.days, body.defaultMinimumWorkingMinutes);
  await assertNameFree(tx, def.table, def.label, body.name);
  await assertShiftUsable(tx, body.shiftId);

  const r = await guardName(def, () => tx.query(
    `INSERT INTO work_shift_schedules
       (tenant_id, shift_id, name, description, default_minimum_working_minutes, automatic_checkout_enabled,
        created_by, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
    [auth.tenantId, body.shiftId, body.name, body.description ?? null, body.defaultMinimumWorkingMinutes,
     body.automaticCheckoutEnabled, auth.userId],
  ));
  const id = Number(r.rows[0].id);
  await writeDays(tx, auth.tenantId, id, normalizeDays(body.days, body.defaultMinimumWorkingMinutes));

  const created = await getRecord(tx, def, id);
  await writeAudit(tx, auth, {
    action: 'created', entityType: def.entityType, entityId: id, before: null, after: auditView(created),
  });
  return withWarnings(tx, created);
}

export async function updateShiftSchedule(tx: Tx, auth: AuthContext, id: number, body: SchedulePatch) {
  const def = shiftScheduleDef;
  const row = await lockRow(tx, def.table, id, def.label);
  assertFresh(row, body.updatedAt);
  const before = await getRecord(tx, def, id);

  const changes: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(COLUMNS)) {
    const next = (body as Record<string, unknown>)[key];
    if (next === undefined) continue;
    const current = column === 'shift_id' ? Number(row[column]) : row[column];
    if (JSON.stringify(current ?? null) !== JSON.stringify(next ?? null)) changes[column] = next;
  }

  const defaultMinimum = body.defaultMinimumWorkingMinutes ?? row.default_minimum_working_minutes;
  let nextDays: ScheduleDayInput[] | null = null;
  if (body.days) {
    assertWeek(body.days, defaultMinimum);
    nextDays = normalizeDays(body.days, defaultMinimum);
    const currentDays = before.days.map((d) => ({
      dayOfWeek: d.dayOfWeek, isWorkingDay: d.isWorkingDay, startTime: d.startTime, endTime: d.endTime,
      minimumWorkingMinutes: d.minimumWorkingMinutes,
    }));
    if (JSON.stringify(currentDays) === JSON.stringify(nextDays)) nextDays = null;
  }
  if (!Object.keys(changes).length && !nextDays) return withWarnings(tx, before);

  if (changes.name !== undefined) await assertNameFree(tx, def.table, def.label, String(changes.name), id);
  if (changes.shift_id !== undefined) await assertShiftUsable(tx, Number(changes.shift_id));
  if (nextDays) await writeDays(tx, auth.tenantId, id, nextDays);

  // Always touch the parent, so updated_at (the lock token) moves when only days changed.
  const sets = Object.keys(changes);
  await guardName(def, () => tx.query(
    `UPDATE ${def.table}
        SET ${[...sets.map((c, i) => `${c} = $${i + 2}`), `updated_by = $${sets.length + 2}`].join(', ')}
      WHERE id = $1`,
    [id, ...sets.map((c) => changes[c]), auth.userId],
  ));

  const after = await getRecord(tx, def, id);
  const diff = diffFields(auditView(before), auditView(after));
  if (diff) await writeAudit(tx, auth, { action: 'updated', entityType: def.entityType, entityId: id, ...diff });
  return withWarnings(tx, after);
}

export const setShiftScheduleStatus = (tx: Tx, auth: AuthContext, id: number, body: StatusBody) =>
  setStatus(tx, auth, shiftScheduleDef, id, body);

/** Audit stores the business shape: no live shift flag, no derived span. */
function auditView(s: ShiftSchedule): Record<string, unknown> {
  const { shiftActive: _a, ...rest } = s;
  return businessFields({
    ...rest,
    days: s.days.map(({ spanMinutes: _s, ...d }) => d),
  });
}

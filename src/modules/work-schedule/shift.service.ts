import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import {
  activeOptions, baseFields, createRecord, getRecord, listRecords, patchRecord, setStatus,
  type BaseRecord, type ResourceDef,
} from './named-config.service';
import { MAX_BLOCKERS } from './work-schedule.errors';
import type { ListQuery, StatusBody } from './work-schedule.schemas';

export interface Shift extends BaseRecord {
  graceTimeMinutes: number;
  usage: { activeSchedules: number; activeRotations: number };
}

const COLUMNS = { name: 'name', description: 'description', graceTimeMinutes: 'grace_time_minutes' };

export const shiftDef: ResourceDef<Shift> = {
  table: 'work_shifts',
  entityType: 'shift',
  label: 'Shift',
  nameIndex: 'uq_work_shifts_name',
  select: `
    SELECT s.*,
           (SELECT count(*) FROM work_shift_schedules ws
             WHERE ws.tenant_id = s.tenant_id AND ws.shift_id = s.id AND ws.is_active)::int AS active_schedules,
           (SELECT count(DISTINCT p.id) FROM rotating_shift_pattern_items i
              JOIN rotating_shift_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
             WHERE i.tenant_id = s.tenant_id AND i.shift_id = s.id AND p.is_active)::int AS active_rotations
      FROM work_shifts s`,
  toApi: (row) => ({
    ...baseFields(row),
    graceTimeMinutes: row.grace_time_minutes,
    usage: { activeSchedules: row.active_schedules ?? 0, activeRotations: row.active_rotations ?? 0 },
  }),
  /** Active schedules and active rotations that use this shift. */
  async dependents(tx, id) {
    const r = await tx.query(
      `SELECT x.type, x.id, x.name, count(*) OVER ()::int AS total FROM (
         SELECT 'shift_schedule' AS type, ws.id, ws.name FROM work_shift_schedules ws
          WHERE ws.shift_id = $1 AND ws.is_active
         UNION
         SELECT 'rotating_shift', p.id, p.name FROM rotating_shift_pattern_items i
           JOIN rotating_shift_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
          WHERE i.shift_id = $1 AND p.is_active
       ) x ORDER BY x.type, lower(x.name), x.id LIMIT $2`,
      [id, MAX_BLOCKERS],
    );
    return {
      total: r.rows[0]?.total ?? 0,
      items: r.rows.map((x) => ({ type: x.type, id: Number(x.id), name: x.name })),
    };
  },
};

export const listShifts = (tx: Tx, q: ListQuery) => listRecords(tx, shiftDef, q);
export const getShift = (tx: Tx, id: number) => getRecord(tx, shiftDef, id);
export const createShift = (tx: Tx, auth: AuthContext, body: Record<string, unknown>) =>
  createRecord(tx, auth, shiftDef, COLUMNS, body);
export const updateShift = (tx: Tx, auth: AuthContext, id: number, body: Record<string, unknown> & { updatedAt: string }) =>
  patchRecord(tx, auth, shiftDef, COLUMNS, id, body);
export const setShiftStatus = (tx: Tx, auth: AuthContext, id: number, body: StatusBody) =>
  setStatus(tx, auth, shiftDef, id, body);

/** Active shifts for the schedule and rotation pickers. */
export async function shiftOptions(tx: Tx) {
  const rows = await activeOptions(tx, 'work_shifts', 'grace_time_minutes');
  return rows.map((r) => ({ id: Number(r.id), name: r.name, graceTimeMinutes: r.grace_time_minutes }));
}

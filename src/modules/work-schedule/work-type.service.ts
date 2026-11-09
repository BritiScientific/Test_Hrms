import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import {
  activeOptions, baseFields, createRecord, getRecord, listRecords, patchRecord, setStatus,
  type BaseRecord, type ResourceDef,
} from './named-config.service';
import { MAX_BLOCKERS } from './work-schedule.errors';
import type { ListQuery, StatusBody } from './work-schedule.schemas';

export interface WorkType extends BaseRecord {
  usage: { activeRotations: number };
}

const COLUMNS = { name: 'name', description: 'description' };

export const workTypeDef: ResourceDef<WorkType> = {
  table: 'work_types',
  entityType: 'work_type',
  label: 'Work type',
  nameIndex: 'uq_work_types_name',
  select: `
    SELECT w.*,
           (SELECT count(DISTINCT p.id) FROM rotating_work_type_pattern_items i
              JOIN rotating_work_type_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
             WHERE i.tenant_id = w.tenant_id AND i.work_type_id = w.id AND p.is_active)::int AS active_rotations
      FROM work_types w`,
  toApi: (row) => ({ ...baseFields(row), usage: { activeRotations: row.active_rotations ?? 0 } }),
  /** Active rotating work types that use this work type. */
  async dependents(tx, id) {
    const r = await tx.query(
      `SELECT DISTINCT p.id, p.name, count(*) OVER ()::int AS total
         FROM rotating_work_type_pattern_items i
         JOIN rotating_work_type_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
        WHERE i.work_type_id = $1 AND p.is_active
        ORDER BY p.name, p.id LIMIT $2`,
      [id, MAX_BLOCKERS],
    );
    return {
      total: r.rows[0]?.total ?? 0,
      items: r.rows.map((x) => ({ type: 'rotating_work_type' as const, id: Number(x.id), name: x.name })),
    };
  },
};

export const listWorkTypes = (tx: Tx, q: ListQuery) => listRecords(tx, workTypeDef, q);
export const getWorkType = (tx: Tx, id: number) => getRecord(tx, workTypeDef, id);
export const createWorkType = (tx: Tx, auth: AuthContext, body: Record<string, unknown>) =>
  createRecord(tx, auth, workTypeDef, COLUMNS, body);
export const updateWorkType = (tx: Tx, auth: AuthContext, id: number, body: Record<string, unknown> & { updatedAt: string }) =>
  patchRecord(tx, auth, workTypeDef, COLUMNS, id, body);
export const setWorkTypeStatus = (tx: Tx, auth: AuthContext, id: number, body: StatusBody) =>
  setStatus(tx, auth, workTypeDef, id, body);

/** Active work types for the rotation picker. */
export async function workTypeOptions(tx: Tx) {
  const rows = await activeOptions(tx, 'work_types');
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

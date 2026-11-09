import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import {
  activeOptions, baseFields, createRecord, getRecord, listRecords, patchRecord, setStatus,
  type BaseRecord, type ResourceDef,
} from './named-config.service';
import { baseCategoryInUse, MAX_BLOCKERS } from './work-schedule.errors';
import type { ListQuery, StatusBody } from './work-schedule.schemas';

export type BaseCategory = 'full_time' | 'part_time' | 'contract' | 'intern';

export interface EmployeeType extends BaseRecord {
  baseCategory: BaseCategory;
  /** Current (non-exited) employees holding this type. */
  employeeCount: number;
}

const COLUMNS = { name: 'name', description: 'description', baseCategory: 'base_category' };

export const employeeTypeDef: ResourceDef<EmployeeType> = {
  table: 'employee_types',
  entityType: 'employee_type',
  label: 'Employee type',
  nameIndex: 'uq_employee_types_name',
  select: `
    SELECT et.*,
           (SELECT count(*) FROM employees e
             WHERE e.tenant_id = et.tenant_id AND e.employee_type_id = et.id AND e.status <> 'exited')::int AS employee_count
      FROM employee_types et`,
  toApi: (row) => ({ ...baseFields(row), baseCategory: row.base_category, employeeCount: row.employee_count ?? 0 }),
  async dependents(tx, id) {
    const r = await tx.query(
      `SELECT e.id, e.full_name AS name, count(*) OVER ()::int AS total
         FROM employees e
        WHERE e.employee_type_id = $1 AND e.status <> 'exited'
        ORDER BY lower(e.full_name), e.id
        LIMIT $2`,
      [id, MAX_BLOCKERS],
    );
    return {
      total: r.rows[0]?.total ?? 0,
      items: r.rows.map((x) => ({ type: 'employee' as const, id: Number(x.id), name: x.name })),
    };
  },
};

export const listEmployeeTypes = (tx: Tx, q: ListQuery) => listRecords(tx, employeeTypeDef, q);
export const getEmployeeType = (tx: Tx, id: number) => getRecord(tx, employeeTypeDef, id);
export const setEmployeeTypeStatus = (tx: Tx, auth: AuthContext, id: number, body: StatusBody) =>
  setStatus(tx, auth, employeeTypeDef, id, body);

export const createEmployeeType = (tx: Tx, auth: AuthContext, body: Record<string, unknown>) =>
  createRecord(tx, auth, employeeTypeDef, COLUMNS, body);

/**
 * The base category is what employment_type is copied from. Once any employee
 * (current or exited) holds the type, moving it would silently disagree with
 * those employees' employment_type, so it is locked.
 */
export const updateEmployeeType = (tx: Tx, auth: AuthContext, id: number, body: Record<string, unknown> & { updatedAt: string }) =>
  patchRecord(tx, auth, employeeTypeDef, COLUMNS, id, body, async (_row, changes) => {
    if (changes.base_category === undefined) return;
    const r = await tx.query(`SELECT count(*)::int AS n FROM employees WHERE employee_type_id = $1`, [id]);
    if (r.rows[0].n > 0) throw baseCategoryInUse(r.rows[0].n);
  });

/** Active types for the employee form dropdown. */
export async function employeeTypeOptions(tx: Tx) {
  const rows = await activeOptions(tx, 'employee_types', 'base_category');
  return rows.map((r) => ({ id: Number(r.id), name: r.name, baseCategory: r.base_category as BaseCategory }));
}

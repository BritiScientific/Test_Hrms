import type { Tx } from '../../config/db';
import { LIVE } from './rotation.service';
import type { AssignmentKind } from './rotation-assignment.service';
import type { PickerQuery } from './work-schedule.schemas';

/**
 * Read-only employee query for the assignment picker. It lives here, not in
 * the employee module, so the employee list is not extended and needs no
 * employee.* permission: whoever may manage a kind of assignment may pick
 * from current (non-exited) employees.
 */

/** "Select all matching" is capped so a single request stays small. */
export const MAX_SELECT_ALL = 500;

const likeTerm = (s: string) => `%${s.trim().replace(/[\%_]/g, (c) => `\${c}`)}%`;
const today = 'tenant_today()';

export async function pickEmployees(tx: Tx, k: AssignmentKind, q: PickerQuery) {
  const r = await tx.query(
    `WITH x AS (
       SELECT e.id, e.full_name, e.employee_code, e.job_title, d.name AS department_name, et.name AS employee_type_name,
              EXISTS (SELECT 1 FROM ${k.table} a WHERE a.tenant_id = e.tenant_id AND a.employee_id = e.id AND ${LIVE('a')}) AS assigned
         FROM employees e
         LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
         LEFT JOIN employee_types et ON et.tenant_id = e.tenant_id AND et.id = e.employee_type_id
        WHERE e.status <> 'exited'
          AND ($1::text IS NULL OR e.full_name ILIKE $1 OR e.employee_code ILIKE $1)
          AND ($2::bigint IS NULL OR e.department_id = $2)
          AND ($3::text IS NULL OR e.job_title = $3)
          AND ($4::bigint IS NULL OR e.employee_type_id = $4)
          AND ($5::bigint IS NULL OR EXISTS (
                SELECT 1 FROM user_roles ur
                 WHERE ur.tenant_id = e.tenant_id AND ur.user_id = e.user_id AND ur.role_id = $5
                   AND ur.revoked_at IS NULL AND daterange(ur.effective_from, ur.effective_to, '[]') @> ${today}))
          AND ($6::bigint IS NULL OR EXISTS (
                SELECT 1 FROM employee_reporting er
                 WHERE er.tenant_id = e.tenant_id AND er.employee_id = e.id AND er.manager_id = $6
                   AND daterange(er.effective_from, er.effective_to, '[]') @> ${today}))
          AND ($7::date IS NULL OR e.date_of_joining >= $7)
          AND ($8::date IS NULL OR e.date_of_joining <= $8)
     )
     SELECT x.*, count(*) OVER ()::int AS total_count FROM x
      WHERE ($9::text IS NULL OR ($9 = 'assigned') = x.assigned)
      ORDER BY lower(x.full_name), x.id
      LIMIT $10 OFFSET $11`,
    [q.search ? likeTerm(q.search) : null, q.departmentId ?? null, q.jobTitle ?? null, q.employeeTypeId ?? null,
     q.roleId ?? null, q.managerId ?? null, q.joinedFrom ?? null, q.joinedTo ?? null, q.assignment ?? null,
     q.idsOnly ? MAX_SELECT_ALL : q.limit, q.idsOnly ? 0 : (q.page - 1) * q.limit],
  );
  const total: number = r.rows[0]?.total_count ?? 0;
  if (q.idsOnly) {
    return { ids: r.rows.map((x) => Number(x.id)), total, truncated: total > MAX_SELECT_ALL };
  }
  return {
    items: r.rows.map((x) => ({
      id: Number(x.id),
      name: x.full_name as string,
      code: x.employee_code as string,
      jobTitle: (x.job_title ?? null) as string | null,
      department: (x.department_name ?? null) as string | null,
      employeeType: (x.employee_type_name ?? null) as string | null,
      assigned: x.assigned as boolean,
    })),
    total,
    page: q.page,
    limit: q.limit,
  };
}

/** Values for the picker's filter dropdowns. */
export async function pickerOptions(tx: Tx) {
  const [titles, departments, types, roles, managers] = await Promise.all([
    tx.query(`SELECT DISTINCT job_title FROM employees WHERE job_title IS NOT NULL AND status <> 'exited' ORDER BY 1`),
    tx.query(`SELECT id, name FROM departments WHERE is_active ORDER BY lower(name)`),
    tx.query(`SELECT id, name FROM employee_types ORDER BY is_active DESC, lower(name)`),
    tx.query(`SELECT id, name FROM roles WHERE is_active ORDER BY lower(name)`),
    tx.query(
      `SELECT DISTINCT m.id, m.full_name AS name FROM employee_reporting er
         JOIN employees m ON m.tenant_id = er.tenant_id AND m.id = er.manager_id
        WHERE daterange(er.effective_from, er.effective_to, '[]') @> tenant_today() AND m.status <> 'exited'
        ORDER BY 2`),
  ]);
  const pair = (rows: any[]) => rows.map((x) => ({ id: Number(x.id), name: x.name as string }));
  return {
    jobTitles: titles.rows.map((x) => x.job_title as string),
    departments: pair(departments.rows),
    employeeTypes: pair(types.rows),
    roles: pair(roles.rows),
    managers: pair(managers.rows),
  };
}

import type { Tx } from '../../config/db';
import type { WorkflowInstanceRow } from './handler-registry';

export interface StepRow {
  id: number;
  workflow_id: number;
  step_order: number;
  name: string;
  approver_type: 'reporting_manager' | 'second_level_manager' | 'department_head' | 'role' | 'specific_user';
  approver_role_id: number | null;
  specific_user_id: number | null;
  required_permission_code: string;
  approval_mode: 'any' | 'all';
  allow_reject: boolean;
  allow_return: boolean;
  on_no_approver: 'fail' | 'skip' | 'fallback_role';
  fallback_role_id: number | null;
  condition: any | null;
  sla_hours: number | null;
}

export interface ResolvedApprovers {
  userIds: number[];
  source: 'primary' | 'fallback' | 'none';
}

/**
 * Resolve WHO must act on a step, then keep only users who
 *   (a) are active members with an active login,
 *   (b) currently hold the step's required permission, and
 *   (c) are neither the submitter nor the employee the request is for
 *       (separation of duties — the original design let an HR Admin's own
 *       leave land in their own HR-approval inbox).
 * Hierarchy is between EMPLOYEES; tasks are assigned to USERS — the join
 * through employees.user_id is the step the original doc skipped.
 */
export async function resolveEligibleApprovers(
  tx: Tx,
  step: StepRow,
  inst: WorkflowInstanceRow,
): Promise<ResolvedApprovers> {
  const primary = await filterEligible(tx, await resolveCandidates(tx, step, inst), step, inst);
  if (primary.length) return { userIds: primary, source: 'primary' };

  if (step.on_no_approver === 'fallback_role' && step.fallback_role_id) {
    const fb = await filterEligible(tx, await roleMembers(tx, step.fallback_role_id), step, inst);
    if (fb.length) return { userIds: fb, source: 'fallback' };
  }
  return { userIds: [], source: 'none' };
}

async function resolveCandidates(tx: Tx, step: StepRow, inst: WorkflowInstanceRow): Promise<number[]> {
  const emp = inst.requested_for_employee_id;
  switch (step.approver_type) {
    case 'reporting_manager':
      return managerUsers(tx, emp, 1);
    case 'second_level_manager':
      return managerUsers(tx, emp, 2);
    case 'department_head': {
      const r = await tx.query(
        `SELECT h.user_id
           FROM employees e
           JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id AND d.is_active
           JOIN employees h   ON h.tenant_id = d.tenant_id AND h.id = d.head_employee_id
          WHERE e.id = $1 AND h.status = 'active' AND h.user_id IS NOT NULL`,
        [emp],
      );
      return r.rows.map((x) => x.user_id);
    }
    case 'role':
      return roleMembers(tx, step.approver_role_id!);
    case 'specific_user':
      return [step.specific_user_id!];
  }
}

/** Manager `levels` hops up, as of the tenant's today. Exclusion constraint guarantees <= 1 row per hop. */
async function managerUsers(tx: Tx, employeeId: number, levels: 1 | 2): Promise<number[]> {
  const r = await tx.query(
    `WITH RECURSIVE up(emp_id, lvl) AS (
       SELECT $1::bigint, 0
       UNION ALL
       SELECT er.manager_id, up.lvl + 1
         FROM up
         JOIN employee_reporting er
           ON er.employee_id = up.emp_id
          AND daterange(er.effective_from, er.effective_to, '[]') @> tenant_today()
        WHERE up.lvl < $2
     )
     SELECT m.user_id
       FROM up JOIN employees m ON m.id = up.emp_id
      WHERE up.lvl = $2 AND m.status = 'active' AND m.user_id IS NOT NULL`,
    [employeeId, levels],
  );
  return r.rows.map((x) => x.user_id);
}

async function roleMembers(tx: Tx, roleId: number): Promise<number[]> {
  const r = await tx.query(
    `SELECT DISTINCT ur.user_id
       FROM user_roles ur
       JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id AND r.is_active
      WHERE ur.role_id = $1
        AND ur.revoked_at IS NULL
        AND ur.effective_from <= tenant_today()
        AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today())`,
    [roleId],
  );
  return r.rows.map((x) => x.user_id);
}

async function filterEligible(
  tx: Tx,
  candidates: number[],
  step: StepRow,
  inst: WorkflowInstanceRow,
): Promise<number[]> {
  if (!candidates.length) return [];
  const r = await tx.query(
    `SELECT DISTINCT v.user_id
       FROM v_effective_permissions v
      WHERE v.user_id = ANY($1::bigint[])
        AND v.permission_code = $2
        AND v.user_id <> $3
        AND NOT EXISTS (SELECT 1 FROM employees e WHERE e.id = $4 AND e.user_id = v.user_id)
      ORDER BY v.user_id`,
    [candidates, step.required_permission_code, inst.requested_by, inst.requested_for_employee_id],
  );
  return r.rows.map((x) => x.user_id);
}

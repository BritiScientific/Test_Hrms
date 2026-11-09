import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';

export const LEAVE_MODULE = 'leave';
export const COMP_OFF_MODULE = 'comp_off';
/** Modules whose approval tasks belong in the leave approvals screens. */
export const LEAVE_WORKFLOW_MODULES: readonly string[] = [LEAVE_MODULE, COMP_OFF_MODULE];

/** Permission codes used by this module. Scope (whose data) is enforced in the services. */
export const P = {
  dashboardSelf: 'leave.dashboard.view_self',
  requestCreateSelf: 'leave.request.create_self',
  requestViewSelf: 'leave.request.view_self',
  requestCancelSelf: 'leave.request.cancel_self',
  balanceViewSelf: 'leave.balance.view_self',
  calendarViewSelf: 'leave.calendar.view_self',
  dashboardTeam: 'leave.dashboard.view_team',
  requestViewTeam: 'leave.request.view_team',
  requestApprove: 'leave.request.approve',
  requestReject: 'leave.request.reject',
  requestReturn: 'leave.request.return',
  historyTeam: 'leave.approval_history.view_team',
  dashboardAll: 'leave.dashboard.view_all',
  requestViewAll: 'leave.request.view_all',
  requestManage: 'leave.request.manage',
  calendarAll: 'leave.calendar.view_all',
  reports: 'leave.reports.view',
  configView: 'leave.configuration.view',
  configManage: 'leave.configuration.manage',
  policyAssign: 'leave.policy.assign',
  balanceAdjust: 'leave.balance.adjust',
} as const;

export const today = async (tx: Tx): Promise<string> =>
  (await tx.query(`SELECT tenant_today()::text AS d`)).rows[0].d;

export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const yearOf = (iso: string): number => Number(iso.slice(0, 4));

export const roundDays = (n: number): number => Math.round(n * 100) / 100;

/** Escape a user-supplied ILIKE search term. */
export const likeTerm = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Direct and indirect reports of an employee as of the tenant's today (cycle-safe). */
export const teamSubtreeSql = (managerParam: string) => `
  WITH RECURSIVE team(emp_id, depth) AS (
    SELECT er.employee_id, 1 FROM employee_reporting er
     WHERE er.manager_id = ${managerParam}
       AND daterange(er.effective_from, er.effective_to, '[]') @> tenant_today()
    UNION
    SELECT er.employee_id, t.depth + 1 FROM team t
      JOIN employee_reporting er ON er.manager_id = t.emp_id
       AND daterange(er.effective_from, er.effective_to, '[]') @> tenant_today()
     WHERE t.depth < 20
  ) SELECT DISTINCT emp_id FROM team`;

/** Employee facts that workflow step conditions can use, shared by leave and comp off. */
export async function employeeWorkflowContext(tx: Tx, employeeId: number) {
  const r = await tx.query(
    `SELECT e.employment_type, e.department_id, d.name AS department_name,
            (SELECT er.manager_id FROM employee_reporting er
              WHERE er.employee_id = e.id AND daterange(er.effective_from, er.effective_to, '[]') @> tenant_today()
              LIMIT 1) AS manager_id
       FROM employees e
       LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      WHERE e.id = $1`,
    [employeeId],
  );
  const row = r.rows[0];
  return {
    employmentType: row.employment_type as string,
    departmentId: (row.department_id ?? 0) as number,
    departmentName: (row.department_name ?? '') as string,
    managerEmployeeId: (row.manager_id ?? 0) as number,
  };
}

/**
 * The comment of the decision that just happened, to keep with the business record.
 * Only approver decisions count: the engine logs 'complete' after the final approval.
 */
export async function latestWorkflowComment(tx: Tx, instanceId: number): Promise<string | null> {
  const r = await tx.query(
    `SELECT comments FROM workflow_action_logs
      WHERE workflow_instance_id = $1 AND action IN ('approve', 'reject', 'return')
      ORDER BY at DESC, id DESC LIMIT 1`,
    [instanceId],
  );
  return r.rows[0]?.comments ?? null;
}

/** snake_case row keys -> camelCase, so every leave response has one naming style. */
export function toCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamel);
  if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof Map) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
      toCamel(v),
    ]),
  );
}

/** Append-only record of configuration changes and HR actions. */
export async function leaveAudit(
  tx: Tx,
  auth: AuthContext,
  action: string,
  targetType: string,
  targetId: number | null,
  before: unknown,
  after: unknown,
) {
  await tx.query(
    `INSERT INTO leave_audit_log (tenant_id, actor_user_id, action, target_type, target_id, before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [auth.tenantId, auth.userId, action, targetType, targetId,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), auth.requestId ?? null],
  );
}

/**
 * One background job at a time per tenant. A second accrual run waits here, then
 * finds every period already posted, so it credits nothing.
 */
export async function lockLeaveJobs(tx: Tx, tenantId: number) {
  await tx.query(`SELECT pg_advisory_xact_lock($1::int, hashtext('leave-jobs'))`, [tenantId]);
}

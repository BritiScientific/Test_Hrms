import { registerWorkflowHandler, hasWorkflowHandler } from '../workflow/handler-registry';
import { COMP_OFF_MODULE, LEAVE_MODULE, P } from './leave-common';
import { onCompOffApproved, onCompOffRejected, onCompOffReturned } from './leave-comp-off.service';
import { onLeaveApproved, onLeaveRejected, onLeaveReturned } from './leave-request.service';

/** Employee facts every leave-related workflow can branch on. */
const EMPLOYEE_FIELDS = {
  employmentType: 'string',
  departmentId: 'number',
  departmentName: 'string',
  managerEmployeeId: 'number',
} as const;

const actionPermission = (action: 'approve' | 'reject' | 'return') =>
  ({ approve: P.requestApprove, reject: P.requestReject, return: P.requestReturn })[action];

/** Plug leave requests and comp off claims into the generic workflow engine. Call once at startup. */
export function registerLeaveWorkflow() {
  if (!hasWorkflowHandler(LEAVE_MODULE)) {
    registerWorkflowHandler({
      module: LEAVE_MODULE,
      // Fields step conditions may use, e.g. { "field": "totalDays", "op": "gt", "value": 3 }
      contextSchema: {
        totalDays: 'number',
        leaveTypeCode: 'string',
        leaveCategory: 'string',
        isPaid: 'boolean',
        ...EMPLOYEE_FIELDS,
      },
      onApproved: onLeaveApproved,
      onRejected: onLeaveRejected,
      onReturned: (tx, inst) => onLeaveReturned(tx, inst),
      canViewAll: (auth) => auth.permissions.has(P.requestViewAll),
      actionPermission,
      async summarize(tx, ids) {
        const r = await tx.query(
          `SELECT lr.id, lr.employee_id, e.full_name AS employee_name, e.employee_code, d.name AS department_name,
                  lt.name AS leave_type, lt.code AS leave_type_code, lr.start_date, lr.end_date, lr.duration_type,
                  lr.half_day_session, lr.total_days, lr.reason, lr.created_at AS submitted_at,
                  b.available AS balance_available, b.pending AS balance_pending
             FROM leave_requests lr
             JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
             JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
             LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
             LEFT JOIN leave_balances b ON b.tenant_id = lr.tenant_id AND b.employee_id = lr.employee_id
                  AND b.leave_type_id = lr.leave_type_id AND b.leave_year = lr.leave_year
            WHERE lr.id = ANY($1::bigint[])`,
          [ids],
        );
        return new Map(r.rows.map((x) => [x.id, x]));
      },
    });
  }

  if (!hasWorkflowHandler(COMP_OFF_MODULE)) {
    registerWorkflowHandler({
      module: COMP_OFF_MODULE,
      contextSchema: {
        hoursWorked: 'number',
        earnedDays: 'number',
        workDayType: 'string',
        leaveTypeCode: 'string',
        ...EMPLOYEE_FIELDS,
      },
      onApproved: onCompOffApproved,
      onRejected: onCompOffRejected,
      onReturned: (tx, inst) => onCompOffReturned(tx, inst),
      canViewAll: (auth) => auth.permissions.has(P.requestViewAll),
      actionPermission,
      // Same shape as a leave summary, so one approvals list shows both.
      async summarize(tx, ids) {
        const r = await tx.query(
          `SELECT cl.id, cl.employee_id, e.full_name AS employee_name, e.employee_code, d.name AS department_name,
                  lt.name AS leave_type, lt.code AS leave_type_code, cl.work_date AS start_date, cl.work_date AS end_date,
                  'full_day' AS duration_type, NULL AS half_day_session, cl.earned_days AS total_days, cl.reason,
                  cl.created_at AS submitted_at, cl.hours_worked, cl.work_day_type
             FROM leave_comp_off_claims cl
             JOIN employees e ON e.tenant_id = cl.tenant_id AND e.id = cl.employee_id
             JOIN leave_comp_off_rules r ON r.tenant_id = cl.tenant_id AND r.id = cl.rule_id
             JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
             LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
            WHERE cl.id = ANY($1::bigint[])`,
          [ids],
        );
        return new Map(r.rows.map((x) => [x.id, x]));
      },
    });
  }
}

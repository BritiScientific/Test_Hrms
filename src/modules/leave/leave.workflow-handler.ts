import { registerWorkflowHandler, hasWorkflowHandler } from '../workflow/handler-registry';
import { LEAVE_MODULE, onLeaveApproved, onLeaveRejected, onLeaveReturned } from './leave.service';

/** Plug Leave Management into the generic workflow engine. Call once at startup. */
export function registerLeaveWorkflow() {
  if (hasWorkflowHandler(LEAVE_MODULE)) return;
  registerWorkflowHandler({
    module: LEAVE_MODULE,
    // Fields step conditions may use, e.g. { "field": "totalDays", "op": "gt", "value": 3 }
    contextSchema: { totalDays: 'number', leaveTypeCode: 'string' },
    onApproved: onLeaveApproved,
    onRejected: onLeaveRejected,
    onReturned: (tx, inst) => onLeaveReturned(tx, inst),
    canViewAll: (auth) => auth.permissions.has('leave.view.all'),
    async summarize(tx, ids) {
      const r = await tx.query(
        `SELECT lr.id, e.full_name AS employee_name, lt.name AS leave_type, lr.start_date, lr.end_date,
                lr.start_session, lr.end_session, lr.total_days, lr.reason, b.available AS balance_available
           FROM leave_requests lr
           JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
           JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
           LEFT JOIN leave_balances b ON b.tenant_id = lr.tenant_id AND b.employee_id = lr.employee_id
                AND b.leave_type_id = lr.leave_type_id AND b.period_year = lr.period_year
          WHERE lr.id = ANY($1::bigint[])`,
        [ids],
      );
      return new Map(r.rows.map((x) => [x.id, x]));
    },
  });
}

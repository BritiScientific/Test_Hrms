import type { Tx } from '../../config/db';
import { unprocessable } from '../../shared/errors';

/**
 * Tabular reports. Each returns columns + rows, so the page renders and exports
 * every report the same way. Day figures come from leave_request_days, so a monthly
 * report splits leave that crosses a month correctly and is not changed by later
 * edits to a holiday calendar.
 */

export const REPORT_TYPES = [
  'balance', 'department', 'utilization', 'leave_type', 'monthly', 'annual',
  'pending', 'accrual', 'carry_forward', 'encashment', 'audit',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export interface ReportQuery {
  type: ReportType;
  year: number;
  departmentId?: number;
  leaveTypeId?: number;
}

interface Column {
  key: string;
  label: string;
  kind?: 'text' | 'days' | 'number' | 'percent' | 'date' | 'datetime';
}

const days = (key: string, label: string): Column => ({ key, label, kind: 'days' });

const LEDGER_REPORT = (txnTypes: string[]) => `
  SELECT e.employee_code, e.full_name AS employee_name, COALESCE(d.name, '—') AS department_name, lt.name AS leave_type_name,
         t.txn_type, t.days, t.effective_date, t.expires_on, t.note, t.created_at
    FROM leave_balance_transactions t
    JOIN leave_balances b ON b.tenant_id = t.tenant_id AND b.id = t.balance_id
    JOIN employees e ON e.tenant_id = b.tenant_id AND e.id = b.employee_id
    JOIN leave_types lt ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
    LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
   WHERE b.leave_year = $1 AND t.txn_type IN (${txnTypes.map((x) => `'${x}'`).join(', ')})
     AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR b.leave_type_id = $3)
   ORDER BY e.full_name, lt.name, t.effective_date, t.id`;

const LEDGER_COLUMNS: Column[] = [
  { key: 'employeeCode', label: 'Code' }, { key: 'employeeName', label: 'Employee' }, { key: 'departmentName', label: 'Department' },
  { key: 'leaveTypeName', label: 'Leave type' }, days('days', 'Days'), { key: 'effectiveDate', label: 'Effective', kind: 'date' },
  { key: 'note', label: 'Note' },
];

export async function runReport(tx: Tx, q: ReportQuery): Promise<{ type: ReportType; year: number; columns: Column[]; rows: any[] }> {
  const params = [q.year, q.departmentId ?? null, q.leaveTypeId ?? null];
  const finish = async (columns: Column[], sql: string, p: unknown[] = params) => ({
    type: q.type, year: q.year, columns, rows: (await tx.query(sql, p)).rows,
  });

  switch (q.type) {
    case 'balance':
      return finish(
        [{ key: 'employeeCode', label: 'Code' }, { key: 'employeeName', label: 'Employee' }, { key: 'departmentName', label: 'Department' },
          { key: 'leaveTypeName', label: 'Leave type' }, days('opening', 'Opening'), days('accrued', 'Accrued'),
          days('carriedForward', 'Carried in'), days('adjusted', 'Adjusted'), days('compOff', 'Comp off'), days('used', 'Used'),
          days('pending', 'Pending'), days('expired', 'Expired'), days('encashed', 'Encashed'), days('available', 'Available')],
        `SELECT e.employee_code, e.full_name AS employee_name, COALESCE(d.name, '—') AS department_name, lt.name AS leave_type_name,
                b.opening, b.accrued, b.carried_forward, b.adjusted, b.comp_off, b.used, b.pending, b.expired, b.encashed, b.available
           FROM leave_balances b
           JOIN employees e ON e.tenant_id = b.tenant_id AND e.id = b.employee_id
           JOIN leave_types lt ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
           LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
          WHERE b.leave_year = $1 AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR b.leave_type_id = $3)
          ORDER BY e.full_name, lt.name`,
      );
    case 'department':
      return finish(
        [{ key: 'departmentName', label: 'Department' }, { key: 'employees', label: 'Employees on leave', kind: 'number' },
          { key: 'requests', label: 'Requests', kind: 'number' }, days('days', 'Days taken')],
        `SELECT COALESCE(d.name, 'No department') AS department_name, count(DISTINCT lr.employee_id)::int AS employees,
                count(DISTINCT lr.id)::int AS requests, COALESCE(sum(ld.chargeable_days), 0) AS days
           FROM leave_requests lr
           JOIN leave_request_days ld ON ld.tenant_id = lr.tenant_id AND ld.leave_request_id = lr.id
           JOIN employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
           LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
          WHERE lr.status = 'approved' AND lr.leave_year = $1
            AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR lr.leave_type_id = $3)
          GROUP BY 1 ORDER BY days DESC`,
      );
    case 'utilization':
      return finish(
        [{ key: 'employeeName', label: 'Employee' }, { key: 'departmentName', label: 'Department' }, { key: 'leaveTypeName', label: 'Leave type' },
          days('credited', 'Credited'), days('used', 'Used'), days('available', 'Available'),
          { key: 'utilizationPercent', label: 'Utilization', kind: 'percent' }],
        `SELECT e.full_name AS employee_name, COALESCE(d.name, '—') AS department_name, lt.name AS leave_type_name,
                (b.opening + b.accrued + b.carried_forward + b.adjusted + b.comp_off) AS credited, b.used, b.available,
                CASE WHEN (b.opening + b.accrued + b.carried_forward + b.adjusted + b.comp_off) > 0
                     THEN round(b.used * 100 / (b.opening + b.accrued + b.carried_forward + b.adjusted + b.comp_off), 1) ELSE 0 END AS utilization_percent
           FROM leave_balances b
           JOIN employees e ON e.tenant_id = b.tenant_id AND e.id = b.employee_id
           JOIN leave_types lt ON lt.tenant_id = b.tenant_id AND lt.id = b.leave_type_id
           LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
          WHERE b.leave_year = $1 AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR b.leave_type_id = $3)
          ORDER BY utilization_percent DESC, e.full_name`,
      );
    case 'leave_type':
      return finish(
        [{ key: 'leaveTypeName', label: 'Leave type' }, { key: 'requests', label: 'Approved requests', kind: 'number' },
          { key: 'employees', label: 'Employees', kind: 'number' }, days('days', 'Days taken'),
          { key: 'pendingRequests', label: 'Pending requests', kind: 'number' }, { key: 'rejectedRequests', label: 'Rejected requests', kind: 'number' }],
        `SELECT lt.name AS leave_type_name,
                count(*) FILTER (WHERE lr.status = 'approved')::int AS requests,
                count(DISTINCT lr.employee_id) FILTER (WHERE lr.status = 'approved')::int AS employees,
                COALESCE(sum(lr.total_days) FILTER (WHERE lr.status = 'approved'), 0) AS days,
                count(*) FILTER (WHERE lr.status IN ('pending', 'returned'))::int AS pending_requests,
                count(*) FILTER (WHERE lr.status = 'rejected')::int AS rejected_requests
           FROM leave_requests lr
           JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
           JOIN employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
          WHERE lr.leave_year = $1 AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR lr.leave_type_id = $3)
          GROUP BY lt.name ORDER BY days DESC`,
      );
    case 'monthly':
      return finish(
        [{ key: 'month', label: 'Month' }, { key: 'leaveTypeName', label: 'Leave type' },
          { key: 'employees', label: 'Employees', kind: 'number' }, days('days', 'Days taken')],
        `SELECT to_char(ld.leave_date, 'YYYY-MM') AS month, lt.name AS leave_type_name,
                count(DISTINCT lr.employee_id)::int AS employees, sum(ld.chargeable_days) AS days
           FROM leave_request_days ld
           JOIN leave_requests lr ON lr.tenant_id = ld.tenant_id AND lr.id = ld.leave_request_id
           JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
           JOIN employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
          WHERE lr.status = 'approved' AND lr.leave_year = $1 AND ld.chargeable_days > 0
            AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR lr.leave_type_id = $3)
          GROUP BY 1, 2 ORDER BY 1, 2`,
      );
    case 'annual':
      return finish(
        [{ key: 'employeeCode', label: 'Code' }, { key: 'employeeName', label: 'Employee' }, { key: 'departmentName', label: 'Department' },
          { key: 'requests', label: 'Approved requests', kind: 'number' }, days('days', 'Days taken'), days('unpaidDays', 'Unpaid days')],
        `SELECT e.employee_code, e.full_name AS employee_name, COALESCE(d.name, '—') AS department_name,
                count(lr.id)::int AS requests, COALESCE(sum(lr.total_days), 0) AS days,
                COALESCE(sum(lr.total_days) FILTER (WHERE NOT lt.is_paid), 0) AS unpaid_days
           FROM employees e
           LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           LEFT JOIN leave_requests lr ON lr.tenant_id = e.tenant_id AND lr.employee_id = e.id
                AND lr.status = 'approved' AND lr.leave_year = $1 AND ($3::bigint IS NULL OR lr.leave_type_id = $3)
           LEFT JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
          WHERE e.status <> 'exited' AND ($2::bigint IS NULL OR e.department_id = $2)
          GROUP BY e.tenant_id, e.id, d.name ORDER BY e.full_name`,
      );
    case 'pending':
      return finish(
        [{ key: 'employeeName', label: 'Employee' }, { key: 'departmentName', label: 'Department' }, { key: 'leaveTypeName', label: 'Leave type' },
          { key: 'startDate', label: 'From', kind: 'date' }, { key: 'endDate', label: 'To', kind: 'date' }, days('totalDays', 'Days'),
          { key: 'status', label: 'Status' }, { key: 'currentStep', label: 'Waiting on' }, { key: 'createdAt', label: 'Submitted', kind: 'date' }],
        `SELECT e.full_name AS employee_name, COALESCE(d.name, '—') AS department_name, lt.name AS leave_type_name,
                lr.start_date, lr.end_date, lr.total_days, lr.status, lr.created_at, s.name AS current_step
           FROM leave_requests lr
           JOIN employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
           JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
           LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
           LEFT JOIN workflow_instances i ON i.tenant_id = lr.tenant_id AND i.id = lr.workflow_instance_id
           LEFT JOIN workflow_steps s ON s.tenant_id = i.tenant_id AND s.workflow_id = i.workflow_id AND s.step_order = i.current_step_order
          WHERE lr.status IN ('pending', 'returned') AND lr.leave_year = $1
            AND ($2::bigint IS NULL OR e.department_id = $2) AND ($3::bigint IS NULL OR lr.leave_type_id = $3)
          ORDER BY lr.created_at`,
      );
    case 'accrual':
      return finish(LEDGER_COLUMNS, LEDGER_REPORT(['OPENING_BALANCE', 'ACCRUAL', 'MANUAL_CREDIT', 'COMP_OFF_CREDIT']));
    case 'carry_forward':
      return finish(
        [...LEDGER_COLUMNS.slice(0, 6), { key: 'expiresOn', label: 'Expires', kind: 'date' }, { key: 'txnType', label: 'Type' }, { key: 'note', label: 'Note' }],
        LEDGER_REPORT(['CARRY_FORWARD', 'CARRY_FORWARD_OUT', 'EXPIRY']),
      );
    case 'encashment':
      return finish(LEDGER_COLUMNS, LEDGER_REPORT(['ENCASHMENT']));
    case 'audit':
      return finish(
        [{ key: 'at', label: 'When', kind: 'datetime' }, { key: 'actorName', label: 'By' }, { key: 'action', label: 'Action' },
          { key: 'targetType', label: 'Target' }, { key: 'targetId', label: 'Id', kind: 'number' }],
        `SELECT a.at, u.full_name AS actor_name, a.action, a.target_type, a.target_id
           FROM leave_audit_log a JOIN users u ON u.id = a.actor_user_id
          WHERE extract(year FROM a.at)::int = $1
          ORDER BY a.at DESC, a.id DESC LIMIT 1000`,
        [q.year],
      );
    default:
      throw unprocessable('UNKNOWN_REPORT', 'Unknown report');
  }
}

import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { listMyTasks } from '../workflow/workflow-engine.service';
import { listBalances } from './leave-balance.service';
import { loadEmployeeHolidays, loadWeeklyOffs } from './leave-calculation';
import { LEAVE_WORKFLOW_MODULES, addDays, likeTerm, teamSubtreeSql, today, yearOf } from './leave-common';

const REQUEST_ROW = `
  lr.id, lr.employee_id, e.full_name AS employee_name, d.name AS department_name, lt.name AS leave_type_name,
  lr.start_date, lr.end_date, lr.duration_type, lr.half_day_session, lr.total_days, lr.status, lr.created_at`;
const REQUEST_FROM = `
  FROM leave_requests lr
  JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
  JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
  LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id`;

// ---------------------------------------------------------------- employee ---

export async function employeeDashboard(tx: Tx, auth: AuthContext) {
  const now = await today(tx);
  const year = yearOf(now);
  if (!auth.employeeId) {
    return { hasEmployeeRecord: false, year, totals: null, balances: [], upcomingLeaves: [], recentRequests: [], upcomingHolidays: [] };
  }
  const balances = await listBalances(tx, auth.employeeId, year);
  const sum = (key: string) => balances.reduce((s: number, b: any) => s + Number(b[key]), 0);
  // Unpaid leave has no entitlement to count against; showing its negative balance would mislead.
  const paid = balances.filter((b: any) => b.is_paid);
  const paidSum = (key: string) => paid.reduce((s: number, b: any) => s + Number(b[key]), 0);

  const upcoming = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.employee_id = $1 AND lr.status = 'approved' AND lr.end_date >= $2::date
      ORDER BY lr.start_date LIMIT 5`,
    [auth.employeeId, now],
  );
  const recent = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.employee_id = $1 ORDER BY lr.created_at DESC, lr.id DESC LIMIT 5`,
    [auth.employeeId],
  );
  const holidays = await loadEmployeeHolidays(tx, auth.employeeId, now, addDays(now, 120));

  return {
    hasEmployeeRecord: true,
    year,
    totals: {
      entitlement: paidSum('annual_entitlement'),
      available: paidSum('available'),
      used: sum('used'),
      pending: sum('pending'),
    },
    balances,
    upcomingLeaves: upcoming.rows,
    recentRequests: recent.rows,
    upcomingHolidays: holidays.slice(0, 5),
  };
}

// ----------------------------------------------------------------- manager ---

export async function teamDashboard(tx: Tx, auth: AuthContext) {
  const now = await today(tx);
  const year = yearOf(now);
  const team = auth.employeeId
    ? (await tx.query(`${teamSubtreeSql('$1')}`, [auth.employeeId])).rows.map((r) => r.emp_id as number)
    : [];
  const pendingApprovals = (await listMyTasks(tx, auth)).filter((t: any) => LEAVE_WORKFLOW_MODULES.includes(t.module) && t.summary).length;
  if (!team.length) {
    return {
      year, teamSize: 0, pendingApprovals, onLeaveToday: [], upcomingAbsences: [],
      approvedStats: { requests: 0, days: 0 }, byType: [], availability: { available: 0, onLeave: 0, availablePercent: 100 },
    };
  }

  const onLeave = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.employee_id = ANY($1::bigint[]) AND lr.status = 'approved'
        AND lr.start_date <= $2::date AND lr.end_date >= $2::date
      ORDER BY e.full_name`,
    [team, now],
  );
  const upcoming = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.employee_id = ANY($1::bigint[]) AND lr.status = 'approved'
        AND lr.start_date > $2::date AND lr.start_date <= $3::date
      ORDER BY lr.start_date LIMIT 10`,
    [team, now, addDays(now, 30)],
  );
  const stats = await tx.query(
    `SELECT count(*)::int AS requests, COALESCE(sum(total_days), 0) AS days
       FROM leave_requests WHERE employee_id = ANY($1::bigint[]) AND status = 'approved' AND leave_year = $2`,
    [team, year],
  );
  const byType = await tx.query(
    `SELECT lt.name AS leave_type_name, count(*)::int AS requests, sum(lr.total_days) AS days
       FROM leave_requests lr JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
      WHERE lr.employee_id = ANY($1::bigint[]) AND lr.status = 'approved' AND lr.leave_year = $2
      GROUP BY lt.name ORDER BY days DESC`,
    [team, year],
  );
  const absent = new Set(onLeave.rows.map((r) => r.employee_id)).size;
  return {
    year,
    teamSize: team.length,
    pendingApprovals,
    onLeaveToday: onLeave.rows,
    upcomingAbsences: upcoming.rows,
    approvedStats: stats.rows[0],
    byType: byType.rows,
    availability: {
      available: team.length - absent,
      onLeave: absent,
      availablePercent: Math.round(((team.length - absent) / team.length) * 100),
    },
  };
}

export async function listTeamMembers(tx: Tx, auth: AuthContext) {
  if (!auth.employeeId) return [];
  const r = await tx.query(
    `SELECT e.id, e.full_name, e.employee_code, d.name AS department_name
       FROM (${teamSubtreeSql('$1')}) t(emp_id)
       JOIN employees e ON e.id = t.emp_id
       LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      ORDER BY e.full_name`,
    [auth.employeeId],
  );
  return r.rows;
}

// ------------------------------------------------------------------- admin ---

export async function adminDashboard(tx: Tx) {
  const now = await today(tx);
  const year = yearOf(now);
  const employees = await tx.query(`SELECT count(*)::int AS n FROM employees WHERE status <> 'exited'`);
  const onLeave = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.status = 'approved' AND lr.start_date <= $1::date AND lr.end_date >= $1::date
      ORDER BY e.full_name LIMIT 50`,
    [now],
  );
  const counts = await tx.query(
    `SELECT status, count(*)::int AS n FROM leave_requests WHERE leave_year = $1 GROUP BY status`,
    [year],
  );
  const byDepartment = await tx.query(
    `SELECT COALESCE(d.name, 'No department') AS department_name, count(DISTINCT lr.id)::int AS requests,
            COALESCE(sum(ld.chargeable_days), 0) AS days
       FROM leave_requests lr
       JOIN leave_request_days ld ON ld.tenant_id = lr.tenant_id AND ld.leave_request_id = lr.id
       JOIN employees e ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
       LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      WHERE lr.status = 'approved' AND lr.leave_year = $1
      GROUP BY 1 ORDER BY days DESC`,
    [year],
  );
  const byType = await tx.query(
    `SELECT lt.name AS leave_type_name, count(*)::int AS requests, COALESCE(sum(lr.total_days), 0) AS days
       FROM leave_requests lr JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
      WHERE lr.status = 'approved' AND lr.leave_year = $1
      GROUP BY lt.name ORDER BY days DESC`,
    [year],
  );
  const upcomingLeaves = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.status = 'approved' AND lr.start_date > $1::date AND lr.start_date <= $2::date
      ORDER BY lr.start_date LIMIT 10`,
    [now, addDays(now, 30)],
  );
  const upcomingHolidays = await tx.query(
    `SELECT DISTINCT ON (h.holiday_date, h.name) h.holiday_date, h.name, h.holiday_type, h.is_optional, c.name AS calendar_name
       FROM leave_holidays h
       JOIN leave_holiday_calendars c ON c.tenant_id = h.tenant_id AND c.id = h.calendar_id AND c.status = 'active'
      WHERE h.holiday_date >= $1::date AND h.holiday_date <= $2::date
      ORDER BY h.holiday_date, h.name LIMIT 8`,
    [now, addDays(now, 120)],
  );
  const status = Object.fromEntries(counts.rows.map((r) => [r.status, r.n]));
  return {
    year,
    totalEmployees: employees.rows[0].n,
    onLeaveToday: onLeave.rows,
    counts: {
      pending: (status.pending ?? 0) + (status.returned ?? 0),
      approved: status.approved ?? 0,
      rejected: status.rejected ?? 0,
      cancelled: (status.cancelled ?? 0) + (status.withdrawn ?? 0),
    },
    byDepartment: byDepartment.rows,
    byType: byType.rows,
    upcomingLeaves: upcomingLeaves.rows,
    upcomingHolidays: upcomingHolidays.rows,
  };
}

// ---------------------------------------------------------------- calendars ---

/** An employee's own calendar: their holidays, their weekly offs, their leave. */
export async function myCalendar(tx: Tx, auth: AuthContext, q: { from: string; to: string }) {
  const weeklyOffs = await loadWeeklyOffs(tx);
  if (!auth.employeeId) return { weeklyOffs, calendarName: null, holidays: [], leaves: [] };
  const holidays = await loadEmployeeHolidays(tx, auth.employeeId, q.from, q.to);
  const leaves = await tx.query(
    `SELECT ${REQUEST_ROW} ${REQUEST_FROM}
      WHERE lr.employee_id = $1 AND lr.status IN ('pending', 'returned', 'approved')
        AND lr.end_date >= $2::date AND lr.start_date <= $3::date
      ORDER BY lr.start_date`,
    [auth.employeeId, q.from, q.to],
  );
  return { weeklyOffs, calendarName: holidays[0]?.calendar_name ?? null, holidays, leaves: leaves.rows };
}

export async function organizationCalendar(
  tx: Tx,
  q: { from: string; to: string; departmentId?: number; location?: string; employeeId?: number; search?: string },
) {
  const params: unknown[] = [q.from, q.to];
  const push = (v: unknown) => `$${params.push(v)}`;
  let where = `lr.status = 'approved' AND lr.end_date >= $1::date AND lr.start_date <= $2::date`;
  if (q.departmentId) where += ` AND e.department_id = ${push(q.departmentId)}`;
  if (q.location) where += ` AND lower(e.work_location) = lower(${push(q.location)})`;
  if (q.employeeId) where += ` AND lr.employee_id = ${push(q.employeeId)}`;
  if (q.search?.trim()) where += ` AND e.full_name ILIKE ${push(likeTerm(q.search))}`;
  const leaves = await tx.query(
    `SELECT ${REQUEST_ROW}, e.work_location ${REQUEST_FROM} WHERE ${where} ORDER BY lr.start_date, e.full_name LIMIT 500`,
    params,
  );
  const holidays = await tx.query(
    `SELECT h.holiday_date::text AS day, h.name, h.holiday_type, h.is_optional, c.name AS calendar_name, c.location
       FROM leave_holidays h
       JOIN leave_holiday_calendars c ON c.tenant_id = h.tenant_id AND c.id = h.calendar_id AND c.status = 'active'
      WHERE h.holiday_date BETWEEN $1::date AND $2::date
        AND ($3::text IS NULL OR c.is_default OR lower(c.location) = lower($3))
      ORDER BY h.holiday_date`,
    [q.from, q.to, q.location ?? null],
  );
  return { weeklyOffs: await loadWeeklyOffs(tx), leaves: leaves.rows, holidays: holidays.rows };
}

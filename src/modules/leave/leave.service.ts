import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { enqueueEvent } from '../outbox/outbox';
import {
  canViewInstance,
  cancelWorkflow,
  getInstanceHistory,
  resubmitWorkflow,
  startWorkflow,
} from '../workflow/workflow-engine.service';
import type { WorkflowInstanceRow } from '../workflow/handler-registry';
import { lockBalance, postLedger } from './leave-balance.service';
import { calculateLeaveDays, type EndSession, type StartSession } from './leave-days';

/**
 * LOCK HIERARCHY (all leave paths): workflow_instance -> leave_request -> leave_balance.
 * The approval path enters through the engine (instance first), so withdraw /
 * resubmit also lock the instance before the request to avoid deadlocks.
 */

export const LEAVE_MODULE = 'leave';
const MAX_BACKDATE_DAYS = 30;

export interface ApplyLeaveInput {
  leaveTypeCode: string;
  startDate: string;
  endDate: string;
  startSession?: StartSession;
  endSession?: EndSession;
  reason?: string | null;
  idempotencyKey?: string | null;
}

interface LeaveRequestRow {
  id: number;
  tenant_id: number;
  employee_id: number;
  leave_type_id: number;
  start_date: string;
  end_date: string;
  total_days: number;
  period_year: number;
  status: string;
  workflow_instance_id: number | null;
  applied_by: number;
}

export async function applyLeave(tx: Tx, auth: AuthContext, input: ApplyLeaveInput) {
  if (!auth.employeeId) throw forbidden('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record');
  const employeeId = auth.employeeId;

  // Idempotent replay: same key -> same request, no second reservation.
  if (input.idempotencyKey) {
    const prev = await tx.query(
      `SELECT id FROM leave_requests WHERE employee_id = $1 AND idempotency_key = $2`,
      [employeeId, input.idempotencyKey],
    );
    if (prev.rowCount) return { replayed: true, request: await getLeaveRequest(tx, auth, prev.rows[0].id) };
  }

  const startSession = input.startSession ?? 'full';
  const endSession = input.endSession ?? 'full';
  if (input.endDate < input.startDate) throw unprocessable('INVALID_DATES', 'End date is before start date');
  const year = Number(input.startDate.slice(0, 4));
  if (Number(input.endDate.slice(0, 4)) !== year) {
    throw unprocessable('SPANS_PERIODS', 'Leave cannot span two leave years; split it into two requests');
  }
  const today = (await tx.query(`SELECT tenant_today()::text AS d`)).rows[0].d as string;
  const earliest = new Date(Date.parse(today) - MAX_BACKDATE_DAYS * 86400000).toISOString().slice(0, 10);
  if (input.startDate < earliest) throw unprocessable('TOO_FAR_BACK', `Leave cannot start more than ${MAX_BACKDATE_DAYS} days ago`);

  const lt = await tx.query(
    `SELECT id, code, allow_half_day, allow_negative, max_negative, max_days_per_request
       FROM leave_types WHERE code = $1 AND is_active`,
    [input.leaveTypeCode],
  );
  if (!lt.rowCount) throw unprocessable('UNKNOWN_LEAVE_TYPE', 'Unknown or inactive leave type');
  const type = lt.rows[0];
  if (!type.allow_half_day && (startSession !== 'full' || endSession !== 'full')) {
    throw unprocessable('HALF_DAY_NOT_ALLOWED', 'This leave type does not allow half days');
  }

  const { totalDays } = await calculateLeaveDays(tx, input.startDate, input.endDate, startSession, endSession);
  if (totalDays <= 0) throw unprocessable('NO_WORKING_DAYS', 'The selected dates contain no working days');
  if (type.max_days_per_request && totalDays > type.max_days_per_request) {
    throw unprocessable('TOO_MANY_DAYS', `Maximum ${type.max_days_per_request} days per request`);
  }

  // Lock the balance row: concurrent submissions for the same balance serialise here.
  const bal = await lockBalance(tx, employeeId, type.id, year);
  const floor = type.allow_negative ? -type.max_negative : 0;
  if (bal.available - totalDays < floor) {
    throw unprocessable('INSUFFICIENT_BALANCE', 'Insufficient leave balance', {
      available: bal.available, requested: totalDays,
    });
  }

  const ins = await tx.query(
    `INSERT INTO leave_requests
       (tenant_id, employee_id, leave_type_id, start_date, end_date, start_session, end_session,
        total_days, period_year, reason, applied_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [auth.tenantId, employeeId, type.id, input.startDate, input.endDate, startSession, endSession,
     totalDays, year, input.reason ?? null, auth.userId, input.idempotencyKey ?? null],
  );
  const requestId: number = ins.rows[0].id;

  await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: bal.id, type: 'reserve', leaveRequestId: requestId,
    pending: totalDays, actorUserId: auth.userId, note: 'Reserved on submit',
  });

  const inst = await startWorkflow(tx, auth.tenantId, {
    module: LEAVE_MODULE,
    entityId: requestId,
    requestedBy: auth.userId,
    requestedForEmployeeId: employeeId,
    context: buildContext(totalDays, type.code),
  });
  await tx.query(`UPDATE leave_requests SET workflow_instance_id = $2 WHERE id = $1`, [requestId, inst.id]);
  await enqueueEvent(tx, auth.tenantId, 'leave.submitted', 'leave_request', requestId, { employeeId, totalDays });

  return { replayed: false, request: await getLeaveRequest(tx, auth, requestId) };
}

export async function resubmitLeave(tx: Tx, auth: AuthContext, id: number, input: { reason?: string | null }) {
  const req = await getOwnRequest(tx, auth, id);
  if (req.status !== 'returned') throw conflict('NOT_RETURNED', 'Only returned requests can be resubmitted');
  const lt = await tx.query(`SELECT code FROM leave_types WHERE id = $1`, [req.leave_type_id]);

  await resubmitWorkflow(tx, LEAVE_MODULE, id, auth.userId, buildContext(req.total_days, lt.rows[0].code));
  await tx.query(
    `UPDATE leave_requests SET status = 'pending', reason = COALESCE($2, reason) WHERE id = $1`,
    [id, input.reason ?? null],
  );
  return getLeaveRequest(tx, auth, id);
}

export async function withdrawLeave(tx: Tx, auth: AuthContext, id: number, reason?: string | null) {
  const req = await getOwnRequest(tx, auth, id);
  if (!['pending', 'returned'].includes(req.status)) {
    throw conflict('NOT_WITHDRAWABLE', `A ${req.status} request cannot be withdrawn`);
  }
  await cancelWorkflow(tx, LEAVE_MODULE, id, auth.userId, reason); // locks instance first
  const locked = await lockRequest(tx, id);
  if (!['pending', 'returned'].includes(locked.status)) {
    throw conflict('NOT_WITHDRAWABLE', `A ${locked.status} request cannot be withdrawn`);
  }
  const bal = await lockBalance(tx, locked.employee_id, locked.leave_type_id, locked.period_year);
  await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: bal.id, type: 'release', leaveRequestId: id,
    pending: -locked.total_days, actorUserId: auth.userId, note: 'Withdrawn',
  });
  await tx.query(`UPDATE leave_requests SET status = 'withdrawn' WHERE id = $1`, [id]);
  return getLeaveRequest(tx, auth, id);
}

// --------------------------------------------- workflow hooks (same tx) ------

export async function onLeaveApproved(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number | null) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  const bal = await lockBalance(tx, req.employee_id, req.leave_type_id, req.period_year);
  await postLedger(tx, {
    tenantId: inst.tenant_id, balanceId: bal.id, type: 'release', leaveRequestId: req.id,
    pending: -req.total_days, actorUserId, note: 'Released on approval',
  });
  await postLedger(tx, {
    tenantId: inst.tenant_id, balanceId: bal.id, type: 'debit', leaveRequestId: req.id,
    used: req.total_days, actorUserId, note: 'Approved leave',
  });
  await tx.query(`UPDATE leave_requests SET status = 'approved' WHERE id = $1`, [req.id]);
}

export async function onLeaveRejected(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  const bal = await lockBalance(tx, req.employee_id, req.leave_type_id, req.period_year);
  await postLedger(tx, {
    tenantId: inst.tenant_id, balanceId: bal.id, type: 'release', leaveRequestId: req.id,
    pending: -req.total_days, actorUserId, note: 'Released on rejection',
  });
  await tx.query(`UPDATE leave_requests SET status = 'rejected' WHERE id = $1`, [req.id]);
}

export async function onLeaveReturned(tx: Tx, inst: WorkflowInstanceRow) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  // Reservation is kept while the employee corrects the request.
  await tx.query(`UPDATE leave_requests SET status = 'returned' WHERE id = $1`, [req.id]);
}

// -------------------------------------------------------------------- reads ---

export type LeaveScope = 'own' | 'team' | 'all';

export async function listLeaveRequests(
  tx: Tx,
  auth: AuthContext,
  q: { scope: LeaveScope; status?: string; limit?: number; offset?: number },
) {
  const params: unknown[] = [];
  let where: string;
  if (q.scope === 'own') {
    if (!auth.permissions.has('leave.view.own')) throw forbidden('MISSING_PERMISSION', 'Requires leave.view.own');
    if (!auth.employeeId) return [];
    params.push(auth.employeeId);
    where = `lr.employee_id = $${params.length}`;
  } else if (q.scope === 'team') {
    if (!auth.permissions.has('leave.view.team')) throw forbidden('MISSING_PERMISSION', 'Requires leave.view.team');
    if (!auth.employeeId) return [];
    params.push(auth.employeeId);
    where = `lr.employee_id IN (${TEAM_SUBTREE_SQL(`$${params.length}`)})`;
  } else {
    if (!auth.permissions.has('leave.view.all')) throw forbidden('MISSING_PERMISSION', 'Requires leave.view.all');
    where = 'true';
  }
  if (q.status) {
    params.push(q.status);
    where += ` AND lr.status = $${params.length}`;
  }
  params.push(Math.min(q.limit ?? 50, 200), q.offset ?? 0);
  const r = await tx.query(
    `SELECT lr.id, lr.employee_id, e.full_name AS employee_name, lt.code AS leave_type,
            lr.start_date, lr.end_date, lr.start_session, lr.end_session, lr.total_days,
            lr.status, lr.reason, lr.workflow_instance_id, lr.created_at
       FROM leave_requests lr
       JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
       JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
      WHERE ${where}
      ORDER BY lr.start_date DESC, lr.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return r.rows;
}

export async function getLeaveRequest(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(
    `SELECT lr.*, e.full_name AS employee_name, lt.code AS leave_type, lt.name AS leave_type_name
       FROM leave_requests lr
       JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
       JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
      WHERE lr.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('Leave request');
  const row = r.rows[0];
  if (!(await canViewLeave(tx, auth, row))) throw notFound('Leave request');

  const workflow = row.workflow_instance_id
    ? await getInstanceHistory(tx, auth, row.workflow_instance_id, { preAuthorized: true })
    : null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name,
    leaveType: row.leave_type,
    startDate: row.start_date,
    endDate: row.end_date,
    startSession: row.start_session,
    endSession: row.end_session,
    totalDays: row.total_days,
    status: row.status,
    reason: row.reason,
    createdAt: row.created_at,
    workflow,
  };
}

async function canViewLeave(tx: Tx, auth: AuthContext, row: any): Promise<boolean> {
  if (row.employee_id === auth.employeeId && auth.permissions.has('leave.view.own')) return true;
  if (auth.permissions.has('leave.view.all')) return true;
  if (auth.permissions.has('leave.view.team') && auth.employeeId) {
    const t = await tx.query(`SELECT 1 FROM (${TEAM_SUBTREE_SQL('$1')}) s(emp_id) WHERE emp_id = $2`, [auth.employeeId, row.employee_id]);
    if (t.rowCount) return true;
  }
  if (row.workflow_instance_id) {
    const i = await tx.query<WorkflowInstanceRow>(`SELECT * FROM workflow_instances WHERE id = $1`, [row.workflow_instance_id]);
    if (i.rowCount && (await canViewInstance(tx, auth, i.rows[0]))) return true;
  }
  return false;
}

/** Direct and indirect reports of an employee as of the tenant's today (cycle-safe). */
const TEAM_SUBTREE_SQL = (managerParam: string) => `
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

// ------------------------------------------------------------------ helpers ---

function buildContext(totalDays: number, leaveTypeCode: string) {
  return { totalDays, leaveTypeCode };
}

async function getOwnRequest(tx: Tx, auth: AuthContext, id: number): Promise<LeaveRequestRow> {
  const r = await tx.query<LeaveRequestRow>(`SELECT * FROM leave_requests WHERE id = $1`, [id]);
  if (!r.rowCount || r.rows[0].employee_id !== auth.employeeId) throw notFound('Leave request');
  return r.rows[0];
}

async function lockRequest(tx: Tx, id: number): Promise<LeaveRequestRow> {
  const r = await tx.query<LeaveRequestRow>(`SELECT * FROM leave_requests WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw notFound('Leave request');
  return r.rows[0];
}

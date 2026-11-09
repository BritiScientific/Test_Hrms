import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { enqueueEvent } from '../outbox/outbox';
import {
  canViewInstance, cancelWorkflow, getInstanceHistory, listMyTasks, resubmitWorkflow, startWorkflow,
} from '../workflow/workflow-engine.service';
import type { WorkflowInstanceRow } from '../workflow/handler-registry';
import { lockBalance, postLedger, type BalanceRow } from './leave-balance.service';
import { calculateLeaveDays, type HalfDaySession, type LeaveDay } from './leave-calculation';
import {
  COMP_OFF_MODULE, LEAVE_MODULE, LEAVE_WORKFLOW_MODULES, P, addDays, employeeWorkflowContext, leaveAudit, likeTerm,
  teamSubtreeSql, today, yearOf,
} from './leave-common';
import { getEntitlement, resolvePolicy } from './leave-policy.service';

/**
 * LOCK HIERARCHY (all leave paths): workflow_instance -> leave_request -> leave_balance.
 * The approval path enters through the engine (instance first), so withdraw and
 * cancel of an in-flight request also lock the instance before the request.
 *
 * Submission never deducts: it places a hold, and the deduction happens in
 * onLeaveApproved, inside the transaction of the final approval.
 */

export interface ApplyLeaveInput {
  leaveTypeCode: string;
  startDate: string;
  endDate: string;
  durationType?: 'full_day' | 'half_day';
  halfDaySession?: HalfDaySession | null;
  reason: string;
  contactDetails?: string | null;
  attachmentIds?: number[];
  idempotencyKey?: string | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, unknown>;
}

interface LeaveRequestRow {
  id: number;
  tenant_id: number;
  employee_id: number;
  leave_type_id: number;
  leave_year: number;
  start_date: string;
  end_date: string;
  total_days: number;
  status: string;
  workflow_instance_id: number | null;
  applied_by: number;
}

const KEY = {
  hold: (id: number) => `leave:${id}:hold`,
  release: (id: number) => `leave:${id}:release`,
  consume: (id: number) => `leave:${id}:consume`,
  reversal: (id: number) => `leave:${id}:reversal`,
};

const SELECT_LIST = `
  lr.id, lr.employee_id, e.full_name AS employee_name, e.employee_code, e.department_id,
  d.name AS department_name, e.work_location, lr.leave_type_id, lt.code AS leave_type_code,
  lt.name AS leave_type_name, lt.category AS leave_category, lr.leave_year, lr.start_date, lr.end_date,
  lr.duration_type, lr.half_day_session, lr.total_days, lr.reason, lr.status, lr.workflow_instance_id,
  lr.decided_at, lr.created_at`;

const FROM_LIST = `
  FROM leave_requests lr
  JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
  JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
  LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id`;

// ------------------------------------------------------------- validation ---

interface Evaluation {
  issues: ValidationIssue[];
  warnings: string[];
  type: any | null;
  policy: Awaited<ReturnType<typeof resolvePolicy>>;
  entitlement: Awaited<ReturnType<typeof getEntitlement>>;
  balance: BalanceRow | null;
  totalDays: number;
  days: LeaveDay[];
}

/**
 * Every rule for a leave application. The form's preview and the real submission
 * both run this, so they can never disagree. `balance` must be locked by the
 * caller for a real submission.
 */
async function evaluateApplication(
  tx: Tx,
  auth: AuthContext,
  input: Omit<ApplyLeaveInput, 'idempotencyKey'>,
  balance: BalanceRow | null,
): Promise<Evaluation> {
  const issues: ValidationIssue[] = [];
  const warnings: string[] = [];
  const out: Evaluation = { issues, warnings, type: null, policy: null, entitlement: null, balance, totalDays: 0, days: [] };
  const add = (code: string, message: string, field?: string, details?: Record<string, unknown>) =>
    issues.push({ code, message, field, details });

  const employeeId = auth.employeeId!;
  const emp = (await tx.query(`SELECT status, date_of_joining FROM employees WHERE id = $1`, [employeeId])).rows[0];
  if (emp?.status === 'exited') add('EMPLOYEE_EXITED', 'Exited employees cannot apply for leave');

  const halfDay = input.durationType === 'half_day';
  if (input.endDate < input.startDate) {
    add('INVALID_DATES', 'The end date is before the start date', 'endDate');
    return out;
  }
  if (yearOf(input.startDate) !== yearOf(input.endDate)) {
    add('SPANS_LEAVE_YEARS', 'Leave cannot span two leave years. Split it into two requests.', 'endDate');
    return out;
  }
  if (halfDay && input.startDate !== input.endDate) {
    add('HALF_DAY_SINGLE_DATE', 'A half day must start and end on the same date', 'endDate');
    return out;
  }
  if (halfDay && !input.halfDaySession) add('HALF_DAY_SESSION_REQUIRED', 'Choose the first or second half', 'halfDaySession');
  if (emp?.date_of_joining && input.startDate < emp.date_of_joining) {
    add('BEFORE_JOINING', 'Leave cannot start before your date of joining', 'startDate');
  }

  const t = await tx.query(`SELECT * FROM leave_types WHERE code = $1 AND is_active`, [input.leaveTypeCode]);
  if (!t.rowCount) {
    add('UNKNOWN_LEAVE_TYPE', 'This leave type does not exist or is no longer active', 'leaveTypeCode');
    return out;
  }
  const type = t.rows[0];
  out.type = type;

  out.policy = await resolvePolicy(tx, employeeId, input.startDate);
  if (!out.policy) {
    add('NO_LEAVE_POLICY', 'No leave policy applies to you on these dates. Contact HR.');
    return out;
  }
  out.entitlement = await getEntitlement(tx, out.policy.id, type.id);
  if (!out.entitlement) {
    add('NOT_IN_POLICY', `${type.name} is not part of your leave policy`, 'leaveTypeCode');
    return out;
  }
  if (halfDay && !out.entitlement.effective_allow_half_day) {
    add('HALF_DAY_NOT_ALLOWED', `${type.name} cannot be taken as a half day`, 'durationType');
  }

  const calc = await calculateLeaveDays(tx, employeeId, {
    startDate: input.startDate,
    endDate: input.endDate,
    includeNonWorkingDays: type.include_non_working_days,
    halfDaySession: halfDay ? input.halfDaySession ?? 'first_half' : null,
  });
  out.totalDays = calc.totalDays;
  out.days = calc.days;
  if (calc.totalDays <= 0) add('NO_WORKING_DAYS', 'The selected dates are all weekly offs or holidays', 'startDate');

  const now = await today(tx);
  if (input.startDate < now) {
    if (!type.allow_backdated) {
      add('BACKDATED_NOT_ALLOWED', `${type.name} cannot be applied for past dates`, 'startDate');
    } else if (type.max_backdated_days != null && input.startDate < addDays(now, -type.max_backdated_days)) {
      add('TOO_FAR_BACK', `${type.name} can be backdated by at most ${type.max_backdated_days} days`, 'startDate');
    }
  } else if (type.min_notice_days > 0 && input.startDate < addDays(now, type.min_notice_days)) {
    add('INSUFFICIENT_NOTICE', `${type.name} needs at least ${type.min_notice_days} days of notice`, 'startDate',
      { minNoticeDays: type.min_notice_days });
  }

  const maxDays = out.entitlement.effective_max_consecutive_days;
  if (maxDays != null && calc.totalDays > maxDays) {
    add('MAX_CONSECUTIVE_EXCEEDED', `${type.name} is limited to ${maxDays} consecutive days`, 'endDate', { maxConsecutiveDays: maxDays });
  }
  if (type.requires_contact_details && !input.contactDetails?.trim()) {
    add('CONTACT_REQUIRED', 'Contact details during leave are required', 'contactDetails');
  }
  if (type.requires_attachment && !input.attachmentIds?.length) {
    add('ATTACHMENT_REQUIRED', `${type.name} requires a supporting document`, 'attachment');
  }

  const overlap = await tx.query(
    `SELECT id, start_date, end_date, status FROM leave_requests
      WHERE employee_id = $1 AND status IN ('pending', 'returned', 'approved')
        AND leave_slot_range(start_date, end_date, half_day_session) && leave_slot_range($2::date, $3::date, $4::varchar)
      ORDER BY start_date LIMIT 1`,
    [employeeId, input.startDate, input.endDate, halfDay ? input.halfDaySession ?? 'first_half' : null],
  );
  if (overlap.rowCount) {
    add('OVERLAPPING_REQUEST', 'You already have leave applied for some of these dates', 'startDate', { requestId: overlap.rows[0].id });
  }

  if (!out.balance) {
    const b = await tx.query<BalanceRow>(
      `SELECT * FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`,
      [employeeId, type.id, yearOf(input.startDate)],
    );
    out.balance = b.rows[0] ?? null;
  }
  const available = out.balance?.available ?? 0;
  if (!out.entitlement.allow_negative_balance && available - calc.totalDays < 0) {
    add('INSUFFICIENT_BALANCE', `Only ${available} days of ${type.name} are available`, 'leaveTypeCode',
      { available, requested: calc.totalDays });
  }
  if (!type.is_paid) warnings.push(`${type.name} is unpaid.`);
  return out;
}

/** Live check for the application form. Reports problems; changes nothing. */
export async function previewApplication(tx: Tx, auth: AuthContext, input: Omit<ApplyLeaveInput, 'idempotencyKey'>) {
  requireEmployee(auth);
  const ev = await evaluateApplication(tx, auth, input, null);
  const available = ev.balance?.available ?? 0;
  return {
    ok: ev.issues.length === 0,
    issues: ev.issues,
    warnings: ev.warnings,
    totalDays: ev.totalDays,
    days: ev.days,
    policy: ev.policy,
    balance: ev.type ? { available, afterRequest: available - ev.totalDays } : null,
  };
}

function requireEmployee(auth: AuthContext) {
  if (!auth.employeeId) throw forbidden('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record');
}

async function buildWorkflowContext(tx: Tx, employeeId: number, totalDays: number, type: { code: string; category: string; is_paid: boolean }) {
  return {
    totalDays,
    leaveTypeCode: type.code,
    leaveCategory: type.category,
    isPaid: type.is_paid,
    ...(await employeeWorkflowContext(tx, employeeId)),
  };
}

// ------------------------------------------------------------------ writes ---

export async function applyLeave(tx: Tx, auth: AuthContext, input: ApplyLeaveInput) {
  requireEmployee(auth);
  const employeeId = auth.employeeId!;

  const replay = async () => {
    if (!input.idempotencyKey) return null;
    const prev = await tx.query(
      `SELECT id FROM leave_requests WHERE employee_id = $1 AND idempotency_key = $2`,
      [employeeId, input.idempotencyKey],
    );
    return prev.rowCount ? { replayed: true, request: await getLeaveRequest(tx, auth, prev.rows[0].id) } : null;
  };
  const first = await replay();
  if (first) return first;

  // Lock the balance before the checks: concurrent requests for one balance serialise here,
  // and each one sees the holds of the requests that committed before it.
  const t = await tx.query(`SELECT id FROM leave_types WHERE code = $1 AND is_active`, [input.leaveTypeCode]);
  let locked: BalanceRow | null = null;
  if (t.rowCount && /^\d{4}/.test(input.startDate) && input.endDate >= input.startDate
      && yearOf(input.startDate) === yearOf(input.endDate)) {
    locked = await lockBalance(tx, auth.tenantId, employeeId, t.rows[0].id, yearOf(input.startDate));
    const second = await replay();
    if (second) return second;
  }

  const ev = await evaluateApplication(tx, auth, input, locked);
  if (ev.issues.length) {
    const i = ev.issues[0];
    throw new AppError(422, i.code, i.message, {
      ...i.details,
      issues: ev.issues,
      fieldErrors: Object.fromEntries(ev.issues.filter((x) => x.field).map((x) => [x.field, x.message])),
    });
  }
  const type = ev.type;
  const halfDay = input.durationType === 'half_day';

  const ins = await tx.query(
    `INSERT INTO leave_requests
       (tenant_id, employee_id, leave_type_id, policy_id, leave_year, start_date, end_date, duration_type,
        half_day_session, total_days, reason, contact_details, applied_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING id`,
    [auth.tenantId, employeeId, type.id, ev.policy!.id, yearOf(input.startDate), input.startDate, input.endDate,
     halfDay ? 'half_day' : 'full_day', halfDay ? input.halfDaySession : null, ev.totalDays,
     input.reason, input.contactDetails?.trim() || null, auth.userId, input.idempotencyKey ?? null],
  );
  const requestId: number = ins.rows[0].id;

  await tx.query(
    `INSERT INTO leave_request_days (tenant_id, leave_request_id, leave_date, day_type, chargeable_days, holiday_name)
     SELECT $1, $2, x.date::date, x.day_type, x.days, x.holiday
       FROM jsonb_to_recordset($3::jsonb) AS x(date text, day_type text, days numeric, holiday text)`,
    [auth.tenantId, requestId, JSON.stringify(ev.days.map((d) => ({
      date: d.date, day_type: d.dayType, days: d.chargeableDays, holiday: d.holidayName,
    })))],
  );

  if (input.attachmentIds?.length) {
    const linked = await tx.query(
      `UPDATE leave_request_attachments SET leave_request_id = $1
        WHERE id = ANY($2::bigint[]) AND employee_id = $3 AND leave_request_id IS NULL`,
      [requestId, input.attachmentIds, employeeId],
    );
    if (linked.rowCount !== input.attachmentIds.length) {
      throw unprocessable('INVALID_ATTACHMENT', 'An attachment was not found or already belongs to another request');
    }
  }

  await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: locked!.id, type: 'LEAVE_HOLD', days: ev.totalDays,
    effectiveDate: input.startDate, leaveRequestId: requestId, idempotencyKey: KEY.hold(requestId),
    actorUserId: auth.userId, note: 'Held on submission (not deducted)',
  });

  const inst = await startWorkflow(tx, auth.tenantId, {
    module: LEAVE_MODULE,
    entityId: requestId,
    requestedBy: auth.userId,
    requestedForEmployeeId: employeeId,
    context: await buildWorkflowContext(tx, employeeId, ev.totalDays, type),
  });
  await tx.query(`UPDATE leave_requests SET workflow_instance_id = $2 WHERE id = $1`, [requestId, inst.id]);
  await enqueueEvent(tx, auth.tenantId, 'leave.submitted', 'leave_request', requestId, {
    employeeId, leaveTypeCode: type.code, totalDays: ev.totalDays, startDate: input.startDate, endDate: input.endDate,
  });

  return { replayed: false, request: await getLeaveRequest(tx, auth, requestId) };
}

export async function resubmitLeave(
  tx: Tx,
  auth: AuthContext,
  id: number,
  input: { reason?: string | null; contactDetails?: string | null },
) {
  const req = await getOwnRequest(tx, auth, id);
  if (req.status !== 'returned') throw conflict('NOT_RETURNED', 'Only returned requests can be resubmitted');
  const t = (await tx.query(`SELECT code, category, is_paid FROM leave_types WHERE id = $1`, [req.leave_type_id])).rows[0];

  await resubmitWorkflow(tx, LEAVE_MODULE, id, auth.userId, await buildWorkflowContext(tx, req.employee_id, req.total_days, t));
  await tx.query(
    `UPDATE leave_requests
        SET status = 'pending', reason = COALESCE($2, reason), contact_details = COALESCE($3, contact_details)
      WHERE id = $1`,
    [id, input.reason?.trim() || null, input.contactDetails?.trim() || null],
  );
  return getLeaveRequest(tx, auth, id);
}

/** Employee takes back a request that is still in approval. The hold is released. */
export async function withdrawLeave(tx: Tx, auth: AuthContext, id: number, reason?: string | null) {
  const req = await getOwnRequest(tx, auth, id);
  if (!['pending', 'returned'].includes(req.status)) {
    throw conflict('NOT_WITHDRAWABLE', `A ${req.status} request cannot be withdrawn`);
  }
  await cancelWorkflow(tx, LEAVE_MODULE, id, auth.userId, reason); // locks the instance first
  const locked = await lockRequest(tx, id);
  if (!['pending', 'returned'].includes(locked.status)) {
    throw conflict('NOT_WITHDRAWABLE', `A ${locked.status} request cannot be withdrawn`);
  }
  await releaseHold(tx, auth.tenantId, locked, auth.userId, 'Withdrawn by the employee');
  await tx.query(`UPDATE leave_requests SET status = 'withdrawn', decided_at = now() WHERE id = $1`, [id]);
  await enqueueEvent(tx, auth.tenantId, 'leave.withdrawn', 'leave_request', id, { employeeId: locked.employee_id });
  return getLeaveRequest(tx, auth, id);
}

/** Employee cancels approved leave that has not started. Afterwards only HR can. */
export async function cancelOwnLeave(tx: Tx, auth: AuthContext, id: number, reason: string) {
  const req = await getOwnRequest(tx, auth, id);
  if (req.status !== 'approved') throw conflict('NOT_CANCELLABLE', `A ${req.status} request cannot be cancelled`);
  if (req.start_date <= (await today(tx))) {
    throw conflict('CANCEL_WINDOW_CLOSED', 'This leave has already started. Ask HR to cancel it.');
  }
  await cancelApproved(tx, auth, id, reason, false);
  return getLeaveRequest(tx, auth, id);
}

/** HR action at any stage. Audited, and the employee is notified through the outbox. */
export async function cancelByHr(tx: Tx, auth: AuthContext, id: number, reason: string) {
  const r = await tx.query<LeaveRequestRow>(`SELECT * FROM leave_requests WHERE id = $1`, [id]);
  if (!r.rowCount) throw notFound('Leave request');
  const req = r.rows[0];
  if (req.employee_id === auth.employeeId) {
    throw forbidden('SELF_APPROVAL', 'You cannot use an HR action on your own request');
  }
  if (req.status === 'approved') {
    await cancelApproved(tx, auth, id, reason, true);
  } else if (['pending', 'returned'].includes(req.status)) {
    await cancelWorkflow(tx, LEAVE_MODULE, id, auth.userId, reason);
    const locked = await lockRequest(tx, id);
    if (!['pending', 'returned'].includes(locked.status)) {
      throw conflict('NOT_CANCELLABLE', `A ${locked.status} request cannot be cancelled`);
    }
    await releaseHold(tx, auth.tenantId, locked, auth.userId, 'Cancelled by HR');
    await tx.query(`UPDATE leave_requests SET status = 'cancelled', decided_at = now() WHERE id = $1`, [id]);
    await recordCancellation(tx, auth, locked, 0, reason, true);
    await enqueueEvent(tx, auth.tenantId, 'leave.cancelled', 'leave_request', id, { employeeId: locked.employee_id, reason });
  } else {
    throw conflict('NOT_CANCELLABLE', `A ${req.status} request cannot be cancelled`);
  }
  await leaveAudit(tx, auth, 'leave_request.cancel', 'leave_request', id, { status: req.status }, { status: 'cancelled', reason });
  return getLeaveRequest(tx, auth, id);
}

async function cancelApproved(tx: Tx, auth: AuthContext, id: number, reason: string, isHr: boolean) {
  const req = await lockRequest(tx, id);
  if (req.status !== 'approved') throw conflict('NOT_CANCELLABLE', `A ${req.status} request cannot be cancelled`);
  const bal = await lockBalance(tx, auth.tenantId, req.employee_id, req.leave_type_id, req.leave_year);
  await postLedger(tx, {
    tenantId: auth.tenantId, balanceId: bal.id, type: 'LEAVE_REVERSAL', days: req.total_days,
    effectiveDate: await today(tx), leaveRequestId: id, idempotencyKey: KEY.reversal(id),
    actorUserId: auth.userId, note: reason,
  });
  await tx.query(`UPDATE leave_requests SET status = 'cancelled', decided_at = now() WHERE id = $1`, [id]);
  await recordCancellation(tx, auth, req, req.total_days, reason, isHr);
  await enqueueEvent(tx, auth.tenantId, 'leave.cancelled', 'leave_request', id, {
    employeeId: req.employee_id, reason, daysReversed: req.total_days,
  });
}

async function recordCancellation(tx: Tx, auth: AuthContext, req: LeaveRequestRow, days: number, reason: string, isHr: boolean) {
  await tx.query(
    `INSERT INTO leave_request_cancellations
       (tenant_id, leave_request_id, previous_status, days_reversed, reason, is_hr_action, cancelled_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [auth.tenantId, req.id, req.status, days, reason, isHr, auth.userId],
  );
}

async function releaseHold(tx: Tx, tenantId: number, req: LeaveRequestRow, actorUserId: number | null, note: string) {
  const bal = await lockBalance(tx, tenantId, req.employee_id, req.leave_type_id, req.leave_year);
  await postLedger(tx, {
    tenantId, balanceId: bal.id, type: 'LEAVE_HOLD_RELEASE', days: req.total_days,
    effectiveDate: req.start_date, leaveRequestId: req.id, idempotencyKey: KEY.release(req.id), actorUserId, note,
  });
  return bal;
}

// --------------------------------------------- workflow hooks (same tx) ------

export async function onLeaveApproved(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number | null) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  const bal = await releaseHold(tx, inst.tenant_id, req, actorUserId, 'Released on final approval');
  await postLedger(tx, {
    tenantId: inst.tenant_id, balanceId: bal.id, type: 'LEAVE_CONSUMPTION', days: req.total_days,
    effectiveDate: req.start_date, leaveRequestId: req.id, idempotencyKey: KEY.consume(req.id), actorUserId,
    note: 'Deducted on final approval',
  });
  await tx.query(`UPDATE leave_requests SET status = 'approved', decided_at = now() WHERE id = $1`, [req.id]);
  await enqueueEvent(tx, inst.tenant_id, 'leave.approved', 'leave_request', req.id, {
    employeeId: req.employee_id, requestedBy: req.applied_by, totalDays: req.total_days,
    startDate: req.start_date, endDate: req.end_date,
  });
}

export async function onLeaveRejected(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  await releaseHold(tx, inst.tenant_id, req, actorUserId, 'Released on rejection');
  await tx.query(`UPDATE leave_requests SET status = 'rejected', decided_at = now() WHERE id = $1`, [req.id]);
  await enqueueEvent(tx, inst.tenant_id, 'leave.rejected', 'leave_request', req.id, {
    employeeId: req.employee_id, requestedBy: req.applied_by,
  });
}

export async function onLeaveReturned(tx: Tx, inst: WorkflowInstanceRow) {
  const req = await lockRequest(tx, inst.entity_id);
  if (req.status !== 'pending') throw conflict('LEAVE_NOT_PENDING', `Leave request is ${req.status}`);
  // The hold stays while the employee answers.
  await tx.query(`UPDATE leave_requests SET status = 'returned' WHERE id = $1`, [req.id]);
  await enqueueEvent(tx, inst.tenant_id, 'leave.returned', 'leave_request', req.id, {
    employeeId: req.employee_id, requestedBy: req.applied_by,
  });
}

// ------------------------------------------------------------------- reads ---

export type LeaveScope = 'own' | 'team' | 'all';

export interface ListRequestsQuery {
  scope: LeaveScope;
  status?: string;
  leaveTypeId?: number;
  employeeId?: number;
  departmentId?: number;
  location?: string;
  from?: string;
  to?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/** Team = reporting subtree, plus requests with a workflow task assigned to or acted on by this user. */
const teamWhere = (employeeParam: string, userParam: string) => `(
  lr.employee_id IN (${teamSubtreeSql(employeeParam)})
  OR EXISTS (SELECT 1 FROM workflow_tasks t
              WHERE t.workflow_instance_id = lr.workflow_instance_id
                AND (t.assigned_to = ${userParam} OR t.acted_by = ${userParam}))
)`;

export async function listLeaveRequests(tx: Tx, auth: AuthContext, q: ListRequestsQuery) {
  const params: unknown[] = [];
  const push = (v: unknown) => `$${params.push(v)}`;
  let where: string;
  if (q.scope === 'own') {
    if (!auth.employeeId) return { items: [], total: 0, limit: q.limit ?? 25, offset: q.offset ?? 0 };
    where = `lr.employee_id = ${push(auth.employeeId)}`;
  } else if (q.scope === 'team') {
    where = teamWhere(push(auth.employeeId ?? 0), push(auth.userId));
    if (auth.employeeId) where += ` AND lr.employee_id <> ${push(auth.employeeId)}`;
  } else {
    where = 'true';
  }
  if (q.status) where += ` AND lr.status = ${push(q.status)}`;
  if (q.leaveTypeId) where += ` AND lr.leave_type_id = ${push(q.leaveTypeId)}`;
  if (q.employeeId) where += ` AND lr.employee_id = ${push(q.employeeId)}`;
  if (q.departmentId) where += ` AND e.department_id = ${push(q.departmentId)}`;
  if (q.location) where += ` AND lower(e.work_location) = lower(${push(q.location)})`;
  if (q.from) where += ` AND lr.end_date >= ${push(q.from)}::date`;
  if (q.to) where += ` AND lr.start_date <= ${push(q.to)}::date`;
  if (q.search?.trim()) {
    const term = push(likeTerm(q.search));
    where += ` AND (e.full_name ILIKE ${term} OR e.employee_code ILIKE ${term} OR lt.name ILIKE ${term} OR lr.reason ILIKE ${term})`;
  }
  const total = await tx.query(`SELECT count(*)::int AS n ${FROM_LIST} WHERE ${where}`, params);
  const limit = Math.min(q.limit ?? 25, 100);
  const offset = q.offset ?? 0;
  const r = await tx.query(
    `SELECT ${SELECT_LIST} ${FROM_LIST} WHERE ${where}
      ORDER BY lr.start_date DESC, lr.id DESC
      LIMIT ${push(limit)} OFFSET ${push(offset)}`,
    params,
  );
  return { items: r.rows, total: total.rows[0].n, limit, offset };
}

export async function getLeaveRequest(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(
    `SELECT ${SELECT_LIST}, lr.contact_details, lr.applied_by, lr.policy_id, p.name AS policy_name
       ${FROM_LIST}
       JOIN leave_policies p ON p.tenant_id = lr.tenant_id AND p.id = lr.policy_id
      WHERE lr.id = $1`,
    [id],
  );
  if (!r.rowCount) throw notFound('Leave request');
  const row = r.rows[0];
  if (!(await canViewLeave(tx, auth, row))) throw notFound('Leave request'); // never reveal it exists

  const workflow = row.workflow_instance_id
    ? await getInstanceHistory(tx, auth, row.workflow_instance_id, { preAuthorized: true })
    : null;
  const days = await tx.query(
    `SELECT leave_date, day_type, chargeable_days, holiday_name FROM leave_request_days
      WHERE leave_request_id = $1 ORDER BY leave_date`,
    [id],
  );
  const attachments = await tx.query(
    `SELECT id, file_name, content_type, byte_size, created_at FROM leave_request_attachments
      WHERE leave_request_id = $1 ORDER BY id`,
    [id],
  );
  const balance = await tx.query(
    `SELECT opening, accrued, carried_forward, adjusted, comp_off, used, pending, expired, encashed, carried_out, available
       FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`,
    [row.employee_id, row.leave_type_id, row.leave_year],
  );
  const ledger = await tx.query(
    `SELECT id, txn_type, days, effective_date, note, created_at FROM leave_balance_transactions
      WHERE leave_request_id = $1 ORDER BY created_at, id`,
    [id],
  );
  const cancellation = await tx.query(
    `SELECT c.previous_status, c.days_reversed, c.reason, c.is_hr_action, c.cancelled_at, u.full_name AS cancelled_by_name
       FROM leave_request_cancellations c JOIN users u ON u.id = c.cancelled_by
      WHERE c.leave_request_id = $1`,
    [id],
  );
  const myTask = (await listMyTasks(tx, auth)).find((t: any) => t.module === LEAVE_MODULE && t.entity_id === id) ?? null;

  const own = row.employee_id === auth.employeeId;
  const now = await today(tx);
  return {
    ...row,
    days: days.rows,
    attachments: attachments.rows,
    balance: balance.rows[0] ?? null,
    ledger: ledger.rows,
    cancellation: cancellation.rows[0] ?? null,
    workflow,
    my_task: myTask,
    actions: {
      can_withdraw: own && ['pending', 'returned'].includes(row.status) && auth.permissions.has(P.requestCancelSelf),
      can_cancel: own && row.status === 'approved' && row.start_date > now && auth.permissions.has(P.requestCancelSelf),
      can_resubmit: own && row.status === 'returned' && auth.permissions.has(P.requestCreateSelf),
      can_hr_cancel: !own && ['pending', 'returned', 'approved'].includes(row.status) && auth.permissions.has(P.requestManage),
    },
  };
}

async function canViewLeave(tx: Tx, auth: AuthContext, row: any): Promise<boolean> {
  if (row.employee_id === auth.employeeId && auth.permissions.has(P.requestViewSelf)) return true;
  if (auth.permissions.has(P.requestViewAll)) return true;
  if (auth.permissions.has(P.requestViewTeam) && auth.employeeId) {
    const t = await tx.query(`SELECT 1 FROM (${teamSubtreeSql('$1')}) s(emp_id) WHERE emp_id = $2`, [auth.employeeId, row.employee_id]);
    if (t.rowCount) return true;
  }
  if (row.workflow_instance_id) {
    const i = await tx.query<WorkflowInstanceRow>(`SELECT * FROM workflow_instances WHERE id = $1`, [row.workflow_instance_id]);
    if (i.rowCount && (await canViewInstance(tx, auth, i.rows[0]))) return true;
  }
  return false;
}

export async function canViewLeaveById(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(`SELECT id, employee_id, workflow_instance_id FROM leave_requests WHERE id = $1`, [id]);
  return r.rowCount ? canViewLeave(tx, auth, r.rows[0]) : false;
}

/**
 * My open approval tasks for leave requests and comp off claims (the engine
 * resolves delegation and current-step rules). `module` tells them apart.
 */
export async function listPendingApprovals(tx: Tx, auth: AuthContext) {
  const tasks = await listMyTasks(tx, auth);
  return tasks.filter((t: any) => LEAVE_WORKFLOW_MODULES.includes(t.module) && t.summary);
}

/**
 * What this approver decided, including as someone's delegate. Leave requests
 * and comp off claims in one list; `kind` tells them apart.
 */
export async function listApprovalHistory(
  tx: Tx,
  auth: AuthContext,
  q: { action?: string; from?: string; to?: string; search?: string; limit?: number; offset?: number },
) {
  const params: unknown[] = [auth.userId];
  const push = (v: unknown) => `$${params.push(v)}`;
  let where = `l.action IN ('approve', 'reject', 'return') AND (l.actor_user_id = $1 OR l.on_behalf_of_user_id = $1)`;
  if (q.action) where += ` AND l.action = ${push(q.action)}`;
  if (q.from) where += ` AND l.at >= ${push(q.from)}::date`;
  if (q.to) where += ` AND l.at < ${push(q.to)}::date + 1`;
  const search = q.search?.trim() ? push(likeTerm(q.search)) : null;
  const decisions = `
    SELECT l.id, l.action, l.comments, l.at, l.step_order, s.name AS step_name, l.cycle,
           b.full_name AS on_behalf_of_name, x.kind, x.request_id, x.request_status,
           x.start_date, x.end_date, x.total_days, x.employee_name, x.leave_type_name
      FROM workflow_action_logs l
      JOIN workflow_instances i ON i.tenant_id = l.tenant_id AND i.id = l.workflow_instance_id
      JOIN (
        SELECT 'leave' AS kind, lr.tenant_id, lr.workflow_instance_id, lr.id AS request_id, lr.status AS request_status,
               lr.start_date, lr.end_date, lr.total_days, e.full_name AS employee_name, lt.name AS leave_type_name
          FROM leave_requests lr
          JOIN employees e    ON e.tenant_id = lr.tenant_id AND e.id = lr.employee_id
          JOIN leave_types lt ON lt.tenant_id = lr.tenant_id AND lt.id = lr.leave_type_id
        UNION ALL
        SELECT 'comp_off', cl.tenant_id, cl.workflow_instance_id, cl.id, cl.status,
               cl.work_date, cl.work_date, cl.earned_days, e.full_name, lt.name
          FROM leave_comp_off_claims cl
          JOIN employees e ON e.tenant_id = cl.tenant_id AND e.id = cl.employee_id
          JOIN leave_comp_off_rules r ON r.tenant_id = cl.tenant_id AND r.id = cl.rule_id
          JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
      ) x ON x.tenant_id = i.tenant_id AND x.workflow_instance_id = i.id
      LEFT JOIN workflow_steps s ON s.tenant_id = i.tenant_id AND s.workflow_id = i.workflow_id AND s.step_order = l.step_order
      LEFT JOIN users b          ON b.id = l.on_behalf_of_user_id
     WHERE ${where} AND i.module IN ('${LEAVE_MODULE}', '${COMP_OFF_MODULE}')
       ${search ? `AND x.employee_name ILIKE ${search}` : ''}`;
  const total = await tx.query(`SELECT count(*)::int AS n FROM (${decisions}) d`, params);
  const limit = Math.min(q.limit ?? 25, 100);
  const offset = q.offset ?? 0;
  const r = await tx.query(
    `SELECT * FROM (${decisions}) d ORDER BY d.at DESC, d.id DESC LIMIT ${push(limit)} OFFSET ${push(offset)}`,
    params,
  );
  return { items: r.rows, total: total.rows[0].n, limit, offset };
}

// ------------------------------------------------------------------ helpers ---

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

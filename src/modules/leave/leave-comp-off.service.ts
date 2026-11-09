import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { enqueueEvent } from '../outbox/outbox';
import type { WorkflowInstanceRow } from '../workflow/handler-registry';
import { cancelWorkflow, resubmitWorkflow, startWorkflow } from '../workflow/workflow-engine.service';
import { lockBalance, postLedger } from './leave-balance.service';
import { calculateLeaveDays } from './leave-calculation';
import { COMP_OFF_MODULE, addDays, employeeWorkflowContext, latestWorkflowComment, today, yearOf } from './leave-common';

/**
 * Comp off is credited only after the worked day is approved. When the rule
 * requires approval, a claim goes through the workflow engine (module
 * 'comp_off') with its own published approval chain, so it reaches the
 * reporting manager, HR or whoever that chain names. The credit happens in the
 * engine's transaction on final approval. LOCK ORDER: instance -> claim -> balance.
 */

export interface CompOffClaimInput {
  leaveTypeId: number;
  workDate: string;
  hoursWorked: number;
  reason: string;
}

interface ClaimRow {
  id: number;
  tenant_id: number;
  employee_id: number;
  rule_id: number;
  work_date: string;
  work_day_type: string;
  hours_worked: number;
  earned_days: number;
  status: string;
  claimed_by: number;
  workflow_instance_id: number | null;
}

async function workflowContext(tx: Tx, claim: ClaimRow) {
  const t = (await tx.query(
    `SELECT lt.code FROM leave_comp_off_rules r JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
      WHERE r.id = $1`,
    [claim.rule_id],
  )).rows[0];
  return {
    hoursWorked: Number(claim.hours_worked),
    earnedDays: Number(claim.earned_days),
    workDayType: claim.work_day_type,
    leaveTypeCode: t.code as string,
    ...(await employeeWorkflowContext(tx, claim.employee_id)),
  };
}

/** Start approval for a claim. Also used to route claims made before claims had a workflow. */
export async function startClaimWorkflow(tx: Tx, tenantId: number, claimId: number) {
  const claim = (await tx.query<ClaimRow>(`SELECT * FROM leave_comp_off_claims WHERE id = $1 FOR UPDATE`, [claimId])).rows[0];
  if (!claim) throw notFound('Comp off claim');
  if (claim.status !== 'pending' || claim.workflow_instance_id) throw conflict('CLAIM_ALREADY_ROUTED', 'This claim is already in approval or decided');
  let inst: WorkflowInstanceRow;
  try {
    inst = await startWorkflow(tx, tenantId, {
      module: COMP_OFF_MODULE,
      entityId: claim.id,
      requestedBy: claim.claimed_by,
      requestedForEmployeeId: claim.employee_id,
      context: await workflowContext(tx, claim),
    });
  } catch (e) {
    if (e instanceof AppError && e.code === 'WORKFLOW_NOT_CONFIGURED') {
      throw unprocessable('WORKFLOW_NOT_CONFIGURED', 'No comp off approval workflow is published yet. Ask HR to set one up under Approval Workflows.');
    }
    throw e;
  }
  await tx.query(`UPDATE leave_comp_off_claims SET workflow_instance_id = $2 WHERE id = $1`, [claim.id, inst.id]);
  return inst;
}

export async function createClaim(tx: Tx, auth: AuthContext, input: CompOffClaimInput) {
  if (!auth.employeeId) throw forbidden('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record');
  const now = await today(tx);
  if (input.workDate > now) throw unprocessable('FUTURE_WORK_DATE', 'You can only claim for days already worked');

  const r = await tx.query(
    `SELECT * FROM leave_comp_off_rules
      WHERE leave_type_id = $1 AND is_active AND daterange(effective_from, effective_to, '[]') @> $2::date
      LIMIT 1`,
    [input.leaveTypeId, input.workDate],
  );
  if (!r.rowCount) throw unprocessable('NO_COMP_OFF_RULE', 'No comp off rule applies to that date');
  const rule = r.rows[0];

  const { days } = await calculateLeaveDays(tx, auth.employeeId, {
    startDate: input.workDate, endDate: input.workDate, includeNonWorkingDays: false,
  });
  const dayType = days[0].dayType;
  const eligible = rule.eligible_work_day_type === 'any'
    || (rule.eligible_work_day_type === 'non_working' && dayType !== 'working')
    || rule.eligible_work_day_type === dayType;
  if (!eligible) throw unprocessable('DAY_NOT_ELIGIBLE', `Comp off cannot be earned for work on a ${dayType.replace('_', ' ')} day`);
  if (input.hoursWorked < rule.minimum_work_hours) {
    throw unprocessable('NOT_ENOUGH_HOURS', `At least ${rule.minimum_work_hours} hours of work are required`);
  }

  const expiresOn = rule.expiry_enabled ? addDays(input.workDate, rule.expiry_after_days) : null;
  const ins = await tx.query(
    `INSERT INTO leave_comp_off_claims
       (tenant_id, employee_id, rule_id, work_date, work_day_type, hours_worked, earned_days, reason, expires_on, claimed_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [auth.tenantId, auth.employeeId, rule.id, input.workDate, dayType, input.hoursWorked, rule.earned_days,
     input.reason, expiresOn, auth.userId],
  );
  const id: number = ins.rows[0].id;
  if (rule.approval_required) await startClaimWorkflow(tx, auth.tenantId, id);
  else await credit(tx, auth.tenantId, id, null, 'Credited without approval (rule setting)');
  await enqueueEvent(tx, auth.tenantId, 'leave.comp_off_claimed', 'leave_comp_off_claim', id, { employeeId: auth.employeeId });
  return getClaim(tx, id);
}

async function lockClaim(tx: Tx, id: number): Promise<ClaimRow> {
  const c = (await tx.query<ClaimRow>(`SELECT * FROM leave_comp_off_claims WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!c) throw notFound('Comp off claim');
  return c;
}

async function credit(tx: Tx, tenantId: number, claimId: number, actorUserId: number | null, note: string | null) {
  const c = (await tx.query(
    `SELECT cl.*, r.leave_type_id, r.maximum_balance
       FROM leave_comp_off_claims cl
       JOIN leave_comp_off_rules r ON r.tenant_id = cl.tenant_id AND r.id = cl.rule_id
      WHERE cl.id = $1 FOR UPDATE OF cl`,
    [claimId],
  )).rows[0];
  if (!c) throw notFound('Comp off claim');
  if (c.status !== 'pending') throw conflict('CLAIM_ALREADY_DECIDED', `This claim is already ${c.status}`);

  const creditDate = await today(tx);
  const bal = await lockBalance(tx, tenantId, c.employee_id, c.leave_type_id, yearOf(creditDate));
  if (c.maximum_balance != null && bal.available + bal.pending + c.earned_days > c.maximum_balance) {
    throw unprocessable('COMP_OFF_CAP_REACHED', `This would exceed the maximum comp off balance of ${c.maximum_balance} days`);
  }
  await postLedger(tx, {
    tenantId, balanceId: bal.id, type: 'COMP_OFF_CREDIT', days: c.earned_days, effectiveDate: creditDate,
    expiresOn: c.expires_on, idempotencyKey: `comp-off:${claimId}`, actorUserId,
    note: `Worked on ${c.work_date}`,
  });
  await tx.query(
    `UPDATE leave_comp_off_claims SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
    [claimId, actorUserId, note],
  );
  return c;
}

// --------------------------------------------- workflow hooks (same tx) ------

export async function onCompOffApproved(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number | null) {
  const claim = await credit(tx, inst.tenant_id, inst.entity_id, actorUserId, await latestWorkflowComment(tx, inst.id));
  await enqueueEvent(tx, inst.tenant_id, 'leave.comp_off_approved', 'leave_comp_off_claim', inst.entity_id, {
    employeeId: claim.employee_id, requestedBy: claim.claimed_by, earnedDays: claim.earned_days,
  });
}

export async function onCompOffRejected(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number) {
  const c = await lockClaim(tx, inst.entity_id);
  if (c.status !== 'pending') throw conflict('CLAIM_NOT_PENDING', `Comp off claim is ${c.status}`);
  await tx.query(
    `UPDATE leave_comp_off_claims SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`,
    [c.id, actorUserId, await latestWorkflowComment(tx, inst.id)],
  );
  await enqueueEvent(tx, inst.tenant_id, 'leave.comp_off_rejected', 'leave_comp_off_claim', c.id, { employeeId: c.employee_id, requestedBy: c.claimed_by });
}

export async function onCompOffReturned(tx: Tx, inst: WorkflowInstanceRow) {
  const c = await lockClaim(tx, inst.entity_id);
  if (c.status !== 'pending') throw conflict('CLAIM_NOT_PENDING', `Comp off claim is ${c.status}`);
  await tx.query(`UPDATE leave_comp_off_claims SET status = 'returned', decision_note = $2 WHERE id = $1`,
    [c.id, await latestWorkflowComment(tx, inst.id)]);
  await enqueueEvent(tx, inst.tenant_id, 'leave.comp_off_returned', 'leave_comp_off_claim', c.id, { employeeId: c.employee_id, requestedBy: c.claimed_by });
}

// ------------------------------------------------------- employee actions ----

async function ownClaim(tx: Tx, auth: AuthContext, id: number): Promise<ClaimRow> {
  const c = (await tx.query<ClaimRow>(`SELECT * FROM leave_comp_off_claims WHERE id = $1`, [id])).rows[0];
  if (!c || c.employee_id !== auth.employeeId) throw notFound('Comp off claim');
  return c;
}

/** Answer a claim that was sent back. Approval starts again from the first step. */
export async function resubmitClaim(tx: Tx, auth: AuthContext, id: number, input: { reason: string }) {
  const c = await ownClaim(tx, auth, id);
  if (c.status !== 'returned') throw conflict('NOT_RETURNED', 'Only a returned claim can be resubmitted');
  await resubmitWorkflow(tx, COMP_OFF_MODULE, id, auth.userId, await workflowContext(tx, c)); // locks the instance first
  await tx.query(`UPDATE leave_comp_off_claims SET status = 'pending', reason = $2, decision_note = NULL WHERE id = $1`, [id, input.reason]);
  return getClaim(tx, id);
}

/** Take back a claim that is still in approval. Nothing was credited, so nothing is reversed. */
export async function withdrawClaim(tx: Tx, auth: AuthContext, id: number) {
  const c = await ownClaim(tx, auth, id);
  if (!['pending', 'returned'].includes(c.status)) throw conflict('NOT_WITHDRAWABLE', `A ${c.status} claim cannot be withdrawn`);
  if (c.workflow_instance_id) await cancelWorkflow(tx, COMP_OFF_MODULE, id, auth.userId, 'Withdrawn by the employee');
  const locked = await lockClaim(tx, id);
  if (!['pending', 'returned'].includes(locked.status)) throw conflict('NOT_WITHDRAWABLE', `A ${locked.status} claim cannot be withdrawn`);
  await tx.query(`UPDATE leave_comp_off_claims SET status = 'withdrawn', decided_by = $2, decided_at = now() WHERE id = $1`, [id, auth.userId]);
  return getClaim(tx, id);
}

// ------------------------------------------------------------------- reads ---

const SELECT_CLAIM = `
  SELECT cl.id, cl.employee_id, e.full_name AS employee_name, e.employee_code, cl.work_date, cl.work_day_type,
         cl.hours_worked, cl.earned_days, cl.reason, cl.status, cl.expires_on, cl.decided_at, cl.decision_note,
         cl.created_at, cl.workflow_instance_id, lt.name AS leave_type_name, u.full_name AS decided_by_name,
         s.name AS current_step,
         (SELECT string_agg(au.full_name, ', ' ORDER BY au.full_name)
            FROM workflow_tasks t JOIN users au ON au.id = t.assigned_to
           WHERE t.workflow_instance_id = i.id AND t.status = 'pending' AND t.cycle = i.cycle) AS waiting_on
    FROM leave_comp_off_claims cl
    JOIN employees e ON e.tenant_id = cl.tenant_id AND e.id = cl.employee_id
    JOIN leave_comp_off_rules r ON r.tenant_id = cl.tenant_id AND r.id = cl.rule_id
    JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id
    LEFT JOIN users u ON u.id = cl.decided_by
    LEFT JOIN workflow_instances i ON i.tenant_id = cl.tenant_id AND i.id = cl.workflow_instance_id
    LEFT JOIN workflow_steps s ON s.tenant_id = i.tenant_id AND s.workflow_id = i.workflow_id
                              AND s.step_order = i.current_step_order AND i.status = 'pending'`;

async function getClaim(tx: Tx, id: number) {
  return (await tx.query(`${SELECT_CLAIM} WHERE cl.id = $1`, [id])).rows[0];
}

export async function listClaims(
  tx: Tx,
  q: { employeeId?: number; status?: string; limit?: number; offset?: number },
) {
  const params: unknown[] = [q.employeeId ?? null, q.status ?? null];
  const where = `($1::bigint IS NULL OR cl.employee_id = $1) AND ($2::text IS NULL OR cl.status = $2)`;
  const total = await tx.query(`SELECT count(*)::int AS n FROM leave_comp_off_claims cl WHERE ${where}`, params);
  const limit = Math.min(q.limit ?? 25, 100);
  const offset = q.offset ?? 0;
  const r = await tx.query(`${SELECT_CLAIM} WHERE ${where} ORDER BY cl.created_at DESC, cl.id DESC LIMIT $3 OFFSET $4`, [...params, limit, offset]);
  return { items: r.rows, total: total.rows[0].n, limit, offset };
}

/** Comp off types the employee can claim against today. */
export async function listClaimableTypes(tx: Tx) {
  const r = await tx.query(
    `SELECT lt.id AS leave_type_id, lt.name AS leave_type_name, r.minimum_work_hours, r.earned_days,
            r.eligible_work_day_type, r.approval_required, r.expiry_enabled, r.expiry_after_days
       FROM leave_comp_off_rules r
       JOIN leave_types lt ON lt.tenant_id = r.tenant_id AND lt.id = r.leave_type_id AND lt.is_active
      WHERE r.is_active AND daterange(r.effective_from, r.effective_to, '[]') @> tenant_today()
      ORDER BY lt.name`,
  );
  return r.rows;
}

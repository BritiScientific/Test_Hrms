import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import { enqueueEvent } from '../outbox/outbox';
import { userHasPermission } from '../rbac/rbac.service';
import { resolveEligibleApprovers, type StepRow } from './approver-resolver';
import { assertContextMatchesSchema, evaluateCondition } from './condition-evaluator';
import { getWorkflowHandler, type WorkflowInstanceRow } from './handler-registry';

/**
 * Workflow engine. Every public function must be called inside withTenantTx():
 * the caller's business change, task transitions, audit rows, next-task
 * creation, module hooks and outbox events commit atomically.
 *
 * Concurrency: LOCK ORDER IS ALWAYS instance -> task(s). Two approvers acting
 * on the same instance serialise on the instance row lock; the second one sees
 * the updated state and gets a 409 instead of advancing the workflow twice.
 */

export type TaskAction = 'approve' | 'reject' | 'return';

const TASK_STATUS: Record<TaskAction, 'approved' | 'rejected' | 'returned'> = {
  approve: 'approved',
  reject: 'rejected',
  return: 'returned',
};

// ------------------------------------------------------------------ start ---

export interface StartWorkflowInput {
  module: string;
  entityId: number;
  requestedBy: number;
  requestedForEmployeeId: number;
  context: Record<string, unknown>;
}

export async function startWorkflow(
  tx: Tx,
  tenantId: number,
  input: StartWorkflowInput,
): Promise<WorkflowInstanceRow> {
  const handler = getWorkflowHandler(input.module);
  assertContextMatchesSchema(input.context, handler.contextSchema);

  // FOR SHARE blocks a concurrent archive/publish while we bind to this version.
  const def = await tx.query(
    `SELECT id FROM workflow_definitions WHERE module = $1 AND status = 'published' FOR SHARE`,
    [input.module],
  );
  if (!def.rowCount) {
    throw unprocessable('WORKFLOW_NOT_CONFIGURED', `No published ${input.module} approval workflow`);
  }

  const ins = await tx.query<WorkflowInstanceRow>(
    `INSERT INTO workflow_instances
       (tenant_id, workflow_id, module, entity_id, requested_by, requested_for_employee_id, context)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [tenantId, def.rows[0].id, input.module, input.entityId, input.requestedBy,
     input.requestedForEmployeeId, JSON.stringify(input.context)],
  );
  const inst = ins.rows[0];
  await log(tx, inst, { action: 'submit', actor: input.requestedBy, from: null, to: 'pending' });
  return advance(tx, inst, 0, input.requestedBy);
}

// ---------------------------------------------------------------- advance ---

/** Create tasks for the next applicable step after `afterStepOrder`, or complete. */
async function advance(
  tx: Tx,
  inst: WorkflowInstanceRow,
  afterStepOrder: number,
  actorUserId: number | null,
): Promise<WorkflowInstanceRow> {
  const steps = await tx.query<StepRow>(
    `SELECT * FROM workflow_steps WHERE workflow_id = $1 AND step_order > $2 ORDER BY step_order`,
    [inst.workflow_id, afterStepOrder],
  );

  for (const step of steps.rows) {
    if (step.condition && !evaluateCondition(step.condition, inst.context)) {
      await log(tx, inst, { action: 'auto_skip', stepOrder: step.step_order, metadata: { reason: 'condition_not_met' } });
      continue;
    }

    const resolved = await resolveEligibleApprovers(tx, step, inst);
    if (resolved.source === 'none') {
      if (step.on_no_approver === 'skip') {
        await log(tx, inst, { action: 'auto_skip', stepOrder: step.step_order, metadata: { reason: 'no_eligible_approver' } });
        continue;
      }
      // Fail the whole transaction: at submit the employee gets a clear 422,
      // at approval time the approver's action does not commit. No instance is
      // ever left "pending" with nobody able to act on it.
      throw new AppError(422, 'NO_ELIGIBLE_APPROVER',
        `No eligible approver for step "${step.name}". Ask HR to check the reporting line or role assignments.`,
        { stepOrder: step.step_order });
    }

    const tasks = await tx.query(
      `INSERT INTO workflow_tasks
         (tenant_id, workflow_instance_id, workflow_id, workflow_step_id, step_order, cycle, assigned_to, due_at)
       SELECT $1, $2, $3, $4, $5, $6, u,
              CASE WHEN $8::int IS NULL THEN NULL ELSE now() + make_interval(hours => $8::int) END
         FROM unnest($7::bigint[]) AS u
       RETURNING id, assigned_to`,
      [inst.tenant_id, inst.id, inst.workflow_id, step.id, step.step_order, inst.cycle,
       resolved.userIds, step.sla_hours],
    );
    const upd = await tx.query<WorkflowInstanceRow>(
      `UPDATE workflow_instances SET current_step_order = $2 WHERE id = $1 RETURNING *`,
      [inst.id, step.step_order],
    );
    if (resolved.source === 'fallback') {
      await log(tx, upd.rows[0], {
        action: 'escalate', stepOrder: step.step_order,
        metadata: { reason: 'primary_approver_unavailable', fallbackRoleId: step.fallback_role_id },
      });
    }
    for (const t of tasks.rows) {
      await enqueueEvent(tx, inst.tenant_id, 'workflow.task_assigned', 'workflow_task', t.id, {
        taskId: t.id, instanceId: inst.id, module: inst.module, entityId: inst.entity_id,
        assignedTo: t.assigned_to, stepName: step.name,
      });
    }
    return upd.rows[0];
  }

  return complete(tx, inst, actorUserId);
}

async function complete(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number | null) {
  const upd = await tx.query<WorkflowInstanceRow>(
    `UPDATE workflow_instances SET status = 'approved', completed_at = now()
      WHERE id = $1 RETURNING *`,
    [inst.id],
  );
  const done = upd.rows[0];
  await log(tx, done, { action: 'complete', actor: null, from: 'pending', to: 'approved' });
  await getWorkflowHandler(done.module).onApproved(tx, done, actorUserId);
  await enqueueEvent(tx, done.tenant_id, 'workflow.approved', 'workflow_instance', done.id, {
    module: done.module, entityId: done.entity_id, requestedBy: done.requested_by,
  });
  return done;
}

// -------------------------------------------------------------------- act ---

export async function actOnTask(
  tx: Tx,
  auth: AuthContext,
  taskId: number,
  action: TaskAction,
  comments?: string | null,
) {
  const ref = await tx.query(`SELECT workflow_instance_id FROM workflow_tasks WHERE id = $1`, [taskId]);
  if (!ref.rowCount) throw notFound('Task');

  const instR = await tx.query<WorkflowInstanceRow>(
    `SELECT * FROM workflow_instances WHERE id = $1 FOR UPDATE`,
    [ref.rows[0].workflow_instance_id],
  );
  const inst = instR.rows[0];
  const tR = await tx.query(
    `SELECT t.*, row_to_json(s.*) AS step
       FROM workflow_tasks t
       JOIN workflow_steps s ON s.tenant_id = t.tenant_id AND s.id = t.workflow_step_id
      WHERE t.id = $1
      FOR UPDATE OF t`,
    [taskId],
  );
  const task = tR.rows[0];
  const step: StepRow = task.step;

  // 1. Ownership: assignee, or an active delegate of the assignee.
  let onBehalfOf: number | null = null;
  if (task.assigned_to !== auth.userId) {
    const d = await tx.query(
      `SELECT 1 FROM workflow_delegations
        WHERE delegator_user_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL
          AND valid_during @> now() AND (module IS NULL OR module = $3)`,
      [task.assigned_to, auth.userId, inst.module],
    );
    if (!d.rowCount) throw notFound('Task'); // do not reveal other people's tasks
    onBehalfOf = task.assigned_to;
  }

  // 2. State: task pending, instance pending, task belongs to the CURRENT step & cycle.
  if (task.status !== 'pending') throw conflict('TASK_ALREADY_ACTED', `Task is already ${task.status}`);
  if (inst.status !== 'pending') throw conflict('INSTANCE_NOT_PENDING', `Request is ${inst.status}`);
  if (task.cycle !== inst.cycle || task.step_order !== inst.current_step_order) {
    throw conflict('TASK_NOT_CURRENT', 'This task is no longer the active approval step');
  }

  // 3. Separation of duties (also covers "I delegated to the requester").
  if (auth.userId === inst.requested_by || auth.employeeId === inst.requested_for_employee_id) {
    throw forbidden('SELF_APPROVAL', 'You cannot act on your own request');
  }

  // 4. Permission from the STEP (not a hard-coded leave.approve), re-read inside this tx.
  const code = step.required_permission_code;
  if (!(await userHasPermission(tx, auth.userId, code))) {
    throw forbidden('MISSING_PERMISSION', `This step requires ${code}`);
  }
  if (onBehalfOf && !(await userHasPermission(tx, onBehalfOf, code))) {
    throw forbidden('DELEGATOR_LOST_PERMISSION', `The delegating approver no longer holds ${code}`);
  }

  // 5. Step rules.
  if (action === 'reject' && !step.allow_reject) throw unprocessable('ACTION_NOT_ALLOWED', 'This step cannot reject');
  if (action === 'return' && !step.allow_return) throw unprocessable('ACTION_NOT_ALLOWED', 'This step cannot return');
  if (action !== 'approve' && !comments?.trim()) {
    throw unprocessable('COMMENT_REQUIRED', 'A comment is required to reject or return');
  }

  const taskStatus = TASK_STATUS[action];
  await tx.query(
    `UPDATE workflow_tasks
        SET status = $2, acted_by = $3, on_behalf_of = $4, comments = $5, acted_at = now()
      WHERE id = $1`,
    [taskId, taskStatus, auth.userId, onBehalfOf, comments ?? null],
  );
  await log(tx, inst, {
    action, taskId, actor: auth.userId, onBehalfOf, stepOrder: task.step_order,
    from: 'pending', to: taskStatus, comments,
  });

  let result: WorkflowInstanceRow;
  if (action === 'approve') {
    if (step.approval_mode === 'any') {
      await cancelPendingTasks(tx, inst, task.step_order, taskId);
      result = await advance(tx, inst, task.step_order, auth.userId);
    } else {
      const remaining = await tx.query(
        `SELECT count(*)::int AS n FROM workflow_tasks
          WHERE workflow_instance_id = $1 AND cycle = $2 AND step_order = $3 AND status = 'pending'`,
        [inst.id, inst.cycle, task.step_order],
      );
      result = remaining.rows[0].n > 0 ? inst : await advance(tx, inst, task.step_order, auth.userId);
    }
  } else {
    await cancelPendingTasks(tx, inst, task.step_order, taskId);
    const upd = await tx.query<WorkflowInstanceRow>(
      action === 'reject'
        ? `UPDATE workflow_instances SET status = 'rejected', completed_at = now() WHERE id = $1 RETURNING *`
        : `UPDATE workflow_instances SET status = 'returned' WHERE id = $1 RETURNING *`,
      [inst.id],
    );
    result = upd.rows[0];
    const handler = getWorkflowHandler(inst.module);
    if (action === 'reject') await handler.onRejected(tx, result, auth.userId);
    else await handler.onReturned(tx, result, auth.userId);
    await enqueueEvent(tx, inst.tenant_id, `workflow.${taskStatus}`, 'workflow_instance', inst.id, {
      module: inst.module, entityId: inst.entity_id, requestedBy: inst.requested_by, comments,
    });
  }

  return { taskId, taskStatus, instance: publicInstance(result) };
}

async function cancelPendingTasks(tx: Tx, inst: WorkflowInstanceRow, stepOrder: number | null, exceptTaskId?: number) {
  await tx.query(
    `UPDATE workflow_tasks SET status = 'cancelled', acted_at = now()
      WHERE workflow_instance_id = $1 AND cycle = $2 AND status = 'pending'
        AND ($3::int IS NULL OR step_order = $3) AND ($4::bigint IS NULL OR id <> $4)`,
    [inst.id, inst.cycle, stepOrder, exceptTaskId ?? null],
  );
}

// ------------------------------------------------- resubmit / cancel --------

export async function resubmitWorkflow(
  tx: Tx,
  module: string,
  entityId: number,
  actorUserId: number,
  context: Record<string, unknown>,
) {
  assertContextMatchesSchema(context, getWorkflowHandler(module).contextSchema);
  const r = await tx.query<WorkflowInstanceRow>(
    `SELECT * FROM workflow_instances WHERE module = $1 AND entity_id = $2 AND status = 'returned' FOR UPDATE`,
    [module, entityId],
  );
  if (!r.rowCount) throw conflict('NOT_RETURNED', 'Only a returned request can be resubmitted');
  if (r.rows[0].requested_by !== actorUserId) throw forbidden('NOT_REQUESTER', 'Only the requester can resubmit');

  const upd = await tx.query<WorkflowInstanceRow>(
    `UPDATE workflow_instances
        SET status = 'pending', cycle = cycle + 1, current_step_order = NULL, context = $2
      WHERE id = $1 RETURNING *`,
    [r.rows[0].id, JSON.stringify(context)],
  );
  await log(tx, upd.rows[0], { action: 'resubmit', actor: actorUserId, from: 'returned', to: 'pending' });
  return advance(tx, upd.rows[0], 0, actorUserId);
}

export async function cancelWorkflow(
  tx: Tx,
  module: string,
  entityId: number,
  actorUserId: number,
  reason?: string | null,
) {
  const r = await tx.query<WorkflowInstanceRow>(
    `SELECT * FROM workflow_instances
      WHERE module = $1 AND entity_id = $2 AND status IN ('pending', 'returned') FOR UPDATE`,
    [module, entityId],
  );
  if (!r.rowCount) throw conflict('NOT_CANCELLABLE', 'No active workflow for this request');
  const inst = r.rows[0];
  await cancelPendingTasks(tx, inst, null);
  const upd = await tx.query<WorkflowInstanceRow>(
    `UPDATE workflow_instances SET status = 'cancelled', completed_at = now() WHERE id = $1 RETURNING *`,
    [inst.id],
  );
  await log(tx, upd.rows[0], { action: 'cancel', actor: actorUserId, from: inst.status, to: 'cancelled', comments: reason });
  await enqueueEvent(tx, inst.tenant_id, 'workflow.cancelled', 'workflow_instance', inst.id, {
    module, entityId,
  });
  return upd.rows[0];
}

// ------------------------------------------------------------------ reads ---

const DELEGATED_TO_ME = `
  SELECT d.delegator_user_id FROM workflow_delegations d
   WHERE d.delegate_user_id = $1 AND d.revoked_at IS NULL AND d.valid_during @> now()
     AND (d.module IS NULL OR d.module = i.module)`;

export async function listMyTasks(tx: Tx, auth: AuthContext) {
  const r = await tx.query(
    `SELECT t.id AS task_id, t.assigned_to, t.assigned_at, t.due_at, t.step_order,
            s.name AS step_name, s.allow_reject, s.allow_return,
            i.id AS instance_id, i.module, i.entity_id, i.cycle,
            ru.full_name AS requested_by_name, e.full_name AS requested_for_name,
            (t.assigned_to <> $1) AS via_delegation,
            (t.due_at IS NOT NULL AND t.due_at < now()) AS overdue
       FROM workflow_tasks t
       JOIN workflow_instances i ON i.tenant_id = t.tenant_id AND i.id = t.workflow_instance_id
       JOIN workflow_steps s     ON s.tenant_id = t.tenant_id AND s.id = t.workflow_step_id
       JOIN users ru             ON ru.id = i.requested_by
       JOIN employees e          ON e.tenant_id = i.tenant_id AND e.id = i.requested_for_employee_id
      WHERE t.status = 'pending' AND i.status = 'pending'
        AND t.cycle = i.cycle AND t.step_order = i.current_step_order
        AND i.requested_by <> $1
        AND (t.assigned_to = $1 OR t.assigned_to IN (${DELEGATED_TO_ME}))
      ORDER BY t.due_at NULLS LAST, t.assigned_at`,
    [auth.userId],
  );

  const byModule = new Map<string, number[]>();
  for (const row of r.rows) byModule.set(row.module, [...(byModule.get(row.module) ?? []), row.entity_id]);
  const summaries = new Map<string, Map<number, unknown>>();
  for (const [module, ids] of byModule) {
    const h = getWorkflowHandler(module);
    if (h.summarize) summaries.set(module, await h.summarize(tx, ids));
  }
  return r.rows.map((row) => ({ ...row, summary: summaries.get(row.module)?.get(row.entity_id) ?? null }));
}

/** Can this user see an instance's history? */
export async function canViewInstance(tx: Tx, auth: AuthContext, inst: WorkflowInstanceRow) {
  if (inst.requested_by === auth.userId || inst.requested_for_employee_id === auth.employeeId) return true;
  if (auth.permissions.has('workflow.admin')) return true;
  if (getWorkflowHandler(inst.module).canViewAll?.(auth)) return true;
  const r = await tx.query(
    `SELECT 1 FROM workflow_tasks t
      WHERE t.workflow_instance_id = $2
        AND (t.assigned_to = $1 OR t.acted_by = $1
             -- a delegate sees only what is currently waiting on the delegator
             OR (t.status = 'pending' AND t.assigned_to IN (
                   SELECT d.delegator_user_id FROM workflow_delegations d
                    WHERE d.delegate_user_id = $1 AND d.revoked_at IS NULL
                      AND d.valid_during @> now())))
      LIMIT 1`,
    [auth.userId, inst.id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** `preAuthorized`: the calling module already verified access to the business record. */
export async function getInstanceHistory(
  tx: Tx,
  auth: AuthContext,
  instanceId: number,
  opts: { preAuthorized?: boolean } = {},
) {
  const i = await tx.query<WorkflowInstanceRow>(`SELECT * FROM workflow_instances WHERE id = $1`, [instanceId]);
  if (!i.rowCount) throw notFound('Workflow instance');
  if (!opts.preAuthorized && !(await canViewInstance(tx, auth, i.rows[0]))) throw notFound('Workflow instance');

  const logs = await tx.query(
    `SELECT l.id, l.action, l.step_order, l.cycle, l.from_status, l.to_status, l.comments,
            l.metadata, l.at, a.full_name AS actor_name, l.actor_user_id,
            b.full_name AS on_behalf_of_name
       FROM workflow_action_logs l
       LEFT JOIN users a ON a.id = l.actor_user_id
       LEFT JOIN users b ON b.id = l.on_behalf_of_user_id
      WHERE l.workflow_instance_id = $1
      ORDER BY l.at, l.id`,
    [instanceId],
  );
  const tasks = await tx.query(
    `SELECT t.id, t.step_order, t.cycle, s.name AS step_name, t.status, t.assigned_to,
            u.full_name AS assigned_to_name, t.acted_by, t.on_behalf_of, t.acted_at, t.due_at
       FROM workflow_tasks t
       JOIN workflow_steps s ON s.tenant_id = t.tenant_id AND s.id = t.workflow_step_id
       JOIN users u ON u.id = t.assigned_to
      WHERE t.workflow_instance_id = $1
      ORDER BY t.cycle, t.step_order, t.id`,
    [instanceId],
  );
  return { instance: publicInstance(i.rows[0]), tasks: tasks.rows, history: logs.rows };
}

export async function getTaskDetail(tx: Tx, auth: AuthContext, taskId: number) {
  const r = await tx.query(
    `SELECT t.id, t.workflow_instance_id, t.assigned_to, t.status FROM workflow_tasks t WHERE t.id = $1`,
    [taskId],
  );
  if (!r.rowCount) throw notFound('Task');
  const detail = await getInstanceHistory(tx, auth, r.rows[0].workflow_instance_id);
  const inst = detail.instance;
  const h = getWorkflowHandler(inst.module);
  const summary = h.summarize ? (await h.summarize(tx, [inst.entityId])).get(inst.entityId) ?? null : null;
  return { task: r.rows[0], summary, ...detail };
}

export function publicInstance(i: WorkflowInstanceRow) {
  return {
    id: i.id,
    module: i.module,
    entityId: i.entity_id,
    status: i.status,
    cycle: i.cycle,
    currentStepOrder: i.current_step_order,
  };
}

// -------------------------------------------------------------------- log ---

async function log(
  tx: Tx,
  inst: WorkflowInstanceRow,
  e: {
    action: string;
    taskId?: number;
    actor?: number | null;
    onBehalfOf?: number | null;
    stepOrder?: number | null;
    from?: string | null;
    to?: string | null;
    comments?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await tx.query(
    `INSERT INTO workflow_action_logs
       (tenant_id, workflow_instance_id, workflow_task_id, actor_user_id, on_behalf_of_user_id,
        action, step_order, cycle, from_status, to_status, comments, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [inst.tenant_id, inst.id, e.taskId ?? null, e.actor ?? null, e.onBehalfOf ?? null,
     e.action, e.stepOrder ?? null, inst.cycle, e.from ?? null, e.to ?? null,
     e.comments ?? null, JSON.stringify(e.metadata ?? {})],
  );
}

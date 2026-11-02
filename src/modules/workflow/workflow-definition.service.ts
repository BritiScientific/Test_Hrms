import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { conflict, notFound, unprocessable } from '../../shared/errors';
import { validateCondition } from './condition-evaluator';
import { getWorkflowHandler, hasWorkflowHandler } from './handler-registry';

export interface StepInput {
  name: string;
  approverType: 'reporting_manager' | 'second_level_manager' | 'department_head' | 'role' | 'specific_user';
  approverRoleId?: number | null;
  specificUserId?: number | null;
  requiredPermission: string;
  approvalMode?: 'any' | 'all';
  allowReject?: boolean;
  allowReturn?: boolean;
  onNoApprover?: 'fail' | 'skip' | 'fallback_role';
  fallbackRoleId?: number | null;
  condition?: Record<string, unknown> | null;
  slaHours?: number | null;
}

export interface DraftInput {
  module: string;
  name: string;
  description?: string | null;
  steps: StepInput[];
}

export async function listDefinitions(tx: Tx, module?: string) {
  const r = await tx.query(
    `SELECT id, module, name, version, status, published_at, created_at
       FROM workflow_definitions
      WHERE ($1::text IS NULL OR module = $1)
      ORDER BY module, version DESC`,
    [module ?? null],
  );
  return r.rows;
}

export async function getDefinition(tx: Tx, id: number) {
  const d = await tx.query(`SELECT * FROM workflow_definitions WHERE id = $1`, [id]);
  if (!d.rowCount) throw notFound('Workflow definition');
  const s = await tx.query(
    `SELECT id, step_order, name, approver_type, approver_role_id, specific_user_id,
            required_permission_code, approval_mode, allow_reject, allow_return,
            on_no_approver, fallback_role_id, condition, sla_hours
       FROM workflow_steps WHERE workflow_id = $1 ORDER BY step_order`,
    [id],
  );
  return { ...d.rows[0], steps: s.rows };
}

export async function createDraft(tx: Tx, actor: AuthContext, input: DraftInput) {
  if (!hasWorkflowHandler(input.module)) throw unprocessable('UNKNOWN_MODULE', `Module ${input.module} has no workflow support`);
  await lockModule(tx, actor.tenantId, input.module);
  const v = await tx.query(
    `SELECT COALESCE(max(version), 0) + 1 AS v FROM workflow_definitions WHERE module = $1`,
    [input.module],
  );
  const d = await tx.query(
    `INSERT INTO workflow_definitions (tenant_id, module, name, version, description, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [actor.tenantId, input.module, input.name, v.rows[0].v, input.description ?? null, actor.userId],
  );
  await insertSteps(tx, actor.tenantId, d.rows[0].id, input.steps);
  return getDefinition(tx, d.rows[0].id);
}

/** Replace a draft's name/description/steps. Published versions are immutable (DB trigger). */
export async function updateDraft(tx: Tx, actor: AuthContext, id: number, input: Omit<DraftInput, 'module'>) {
  const d = await tx.query(`SELECT status FROM workflow_definitions WHERE id = $1 FOR UPDATE`, [id]);
  if (!d.rowCount) throw notFound('Workflow definition');
  if (d.rows[0].status !== 'draft') throw conflict('NOT_DRAFT', 'Only drafts can be edited; clone to create a new version');
  await tx.query(
    `UPDATE workflow_definitions SET name = $2, description = $3 WHERE id = $1`,
    [id, input.name, input.description ?? null],
  );
  await tx.query(`DELETE FROM workflow_steps WHERE workflow_id = $1`, [id]);
  await insertSteps(tx, actor.tenantId, id, input.steps);
  return getDefinition(tx, id);
}

/** Start a new draft from an existing version. */
export async function cloneToDraft(tx: Tx, actor: AuthContext, id: number) {
  const src = await getDefinition(tx, id);
  return createDraft(tx, actor, {
    module: src.module,
    name: src.name,
    description: src.description,
    steps: src.steps.map((s: any) => ({
      name: s.name,
      approverType: s.approver_type,
      approverRoleId: s.approver_role_id,
      specificUserId: s.specific_user_id,
      requiredPermission: s.required_permission_code,
      approvalMode: s.approval_mode,
      allowReject: s.allow_reject,
      allowReturn: s.allow_return,
      onNoApprover: s.on_no_approver,
      fallbackRoleId: s.fallback_role_id,
      condition: s.condition,
      slaHours: s.sla_hours,
    })),
  });
}

export async function deleteDraft(tx: Tx, id: number) {
  const r = await tx.query(`DELETE FROM workflow_definitions WHERE id = $1 AND status = 'draft'`, [id]);
  if (!r.rowCount) throw conflict('NOT_DRAFT', 'Only drafts can be deleted');
}

/**
 * Validate and publish. The previous published version is archived in the
 * same transaction; in-flight instances keep pointing at their own version.
 */
export async function publish(tx: Tx, actor: AuthContext, id: number) {
  const def = await getDefinition(tx, id);
  if (def.status !== 'draft') throw conflict('NOT_DRAFT', 'Only drafts can be published');
  await lockModule(tx, actor.tenantId, def.module);

  const errors = await validateDefinition(tx, def);
  if (errors.length) throw unprocessable('INVALID_WORKFLOW', 'Workflow definition is invalid', { errors });

  await tx.query(
    `UPDATE workflow_definitions SET status = 'archived' WHERE module = $1 AND status = 'published'`,
    [def.module],
  );
  await tx.query(
    `UPDATE workflow_definitions SET status = 'published', published_by = $2, published_at = now()
      WHERE id = $1`,
    [id, actor.userId],
  );
  return getDefinition(tx, id);
}

export async function validateDefinition(tx: Tx, def: any): Promise<string[]> {
  const errors: string[] = [];
  const steps: any[] = def.steps;
  if (!steps.length) errors.push('At least one step is required');
  steps.forEach((s, i) => {
    if (s.step_order !== i + 1) errors.push(`Step orders must be contiguous from 1 (found ${s.step_order} at position ${i + 1})`);
  });

  // Roles must exist and be active.
  const roleIds = steps.flatMap((s) => [s.approver_role_id, s.fallback_role_id]).filter((x) => x != null);
  if (roleIds.length) {
    const r = await tx.query(`SELECT id FROM roles WHERE id = ANY($1::bigint[]) AND is_active`, [roleIds]);
    const ok = new Set(r.rows.map((x) => x.id));
    for (const id of roleIds) if (!ok.has(id)) errors.push(`Role ${id} does not exist or is inactive`);
  }
  // Specific users must be active members.
  const userIds = steps.map((s) => s.specific_user_id).filter((x) => x != null);
  if (userIds.length) {
    const r = await tx.query(
      `SELECT user_id FROM tenant_users WHERE user_id = ANY($1::bigint[]) AND status = 'active'`,
      [userIds],
    );
    const ok = new Set(r.rows.map((x) => x.user_id));
    for (const id of userIds) if (!ok.has(id)) errors.push(`User ${id} is not an active member`);
  }
  // Conditions must only reference the module's declared context fields.
  const schema = getWorkflowHandler(def.module).contextSchema;
  for (const s of steps) {
    if (s.condition) {
      for (const e of validateCondition(s.condition, schema)) errors.push(`Step ${s.step_order}: ${e}`);
    }
  }
  // Guarantee at least one human approval: one step that always applies and cannot be skipped.
  if (!steps.some((s) => !s.condition && s.on_no_approver !== 'skip')) {
    errors.push('At least one step must always apply and must not be skippable (otherwise requests can auto-approve)');
  }
  return errors;
}

async function insertSteps(tx: Tx, tenantId: number, workflowId: number, steps: StepInput[]) {
  let order = 0;
  for (const s of steps) {
    order += 1;
    await tx.query(
      `INSERT INTO workflow_steps
         (tenant_id, workflow_id, step_order, name, approver_type, approver_role_id, specific_user_id,
          required_permission_code, approval_mode, allow_reject, allow_return, on_no_approver,
          fallback_role_id, condition, sla_hours)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [tenantId, workflowId, order, s.name, s.approverType, s.approverRoleId ?? null, s.specificUserId ?? null,
       s.requiredPermission, s.approvalMode ?? 'any', s.allowReject ?? true, s.allowReturn ?? true,
       s.onNoApprover ?? 'fail', s.fallbackRoleId ?? null,
       s.condition ? JSON.stringify(s.condition) : null, s.slaHours ?? null],
    );
  }
}

async function lockModule(tx: Tx, tenantId: number, module: string) {
  await tx.query(`SELECT pg_advisory_xact_lock($1::int, hashtext('wf:' || $2))`, [tenantId, module]);
}

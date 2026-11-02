import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import * as defs from './workflow-definition.service';
import * as delegations from './delegation.service';
import * as engine from './workflow-engine.service';

// z.coerce on IDs: JSON bodies from Postman/forms carry "3" rather than 3.
const StepBody = z.object({
  name: z.string().trim().min(1).max(150),
  approverType: z.enum(['reporting_manager', 'second_level_manager', 'department_head', 'role', 'specific_user']),
  approverRoleId: z.coerce.number().int().positive().nullish(),
  specificUserId: z.coerce.number().int().positive().nullish(),
  requiredPermission: z.string().max(150),
  approvalMode: z.enum(['any', 'all']).optional(),
  allowReject: z.boolean().optional(),
  allowReturn: z.boolean().optional(),
  onNoApprover: z.enum(['fail', 'skip', 'fallback_role']).optional(),
  fallbackRoleId: z.coerce.number().int().positive().nullish(),
  condition: z.record(z.unknown()).nullish(),
  slaHours: z.coerce.number().int().positive().max(24 * 30).nullish(),
});
const DraftBody = z.object({
  module: z.string().regex(/^[a-z][a-z_]*$/).max(50),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).nullish(),
  steps: z.array(StepBody).min(1).max(20),
});
const ActBody = z.object({ comments: z.string().trim().max(2000).nullish() });
const DelegationBody = z.object({
  delegateUserId: z.coerce.number().int().positive(),
  module: z.string().regex(/^[a-z][a-z_]*$/).nullish(),
  from: z.string().datetime({ offset: true }),
  to: z.string().datetime({ offset: true }),
  reason: z.string().max(500).nullish(),
});

export const workflowRouter = Router();
workflowRouter.use('/workflows', authenticate);

// ---- My Approvals --------------------------------------------------------
workflowRouter.get('/workflows/my-tasks', tenantHandler((tx, auth) => engine.listMyTasks(tx, auth)));

workflowRouter.get('/workflows/tasks/:id', tenantHandler((tx, auth, req) => engine.getTaskDetail(tx, auth, idParam(req))));

// No requirePermission here: the step's required_permission_code is checked by the engine.
for (const action of ['approve', 'reject', 'return'] as const) {
  workflowRouter.post(`/workflows/tasks/:id/${action}`, tenantHandler((tx, auth, req) =>
    engine.actOnTask(tx, auth, idParam(req), action, ActBody.parse(req.body ?? {}).comments)));
}

workflowRouter.get('/workflows/instances/:id/history',
  tenantHandler((tx, auth, req) => engine.getInstanceHistory(tx, auth, idParam(req))));

// ---- Delegations ---------------------------------------------------------
workflowRouter.get('/workflows/delegations', tenantHandler((tx, auth) => delegations.listMyDelegations(tx, auth)));
workflowRouter.post('/workflows/delegations', requirePermission('workflow.delegate'),
  tenantHandler((tx, auth, req) => delegations.createDelegation(tx, auth, DelegationBody.parse(req.body)), 201));
workflowRouter.delete('/workflows/delegations/:id',
  tenantHandler(async (tx, auth, req) => { await delegations.revokeDelegation(tx, auth, idParam(req)); }));

// ---- Definitions (Workflow Builder) ----------------------------------------
const canRead = requirePermission('workflow.view', 'workflow.configure');
const canWrite = requirePermission('workflow.configure');

workflowRouter.get('/workflows/definitions', canRead,
  tenantHandler((tx, _a, req) => defs.listDefinitions(tx, typeof req.query.module === 'string' ? req.query.module : undefined)));
workflowRouter.get('/workflows/definitions/:id', canRead, tenantHandler((tx, _a, req) => defs.getDefinition(tx, idParam(req))));
workflowRouter.post('/workflows/definitions', canWrite,
  tenantHandler((tx, auth, req) => defs.createDraft(tx, auth, DraftBody.parse(req.body)), 201));
workflowRouter.put('/workflows/definitions/:id', canWrite,
  tenantHandler((tx, auth, req) => defs.updateDraft(tx, auth, idParam(req), DraftBody.omit({ module: true }).parse(req.body))));
workflowRouter.post('/workflows/definitions/:id/clone', canWrite,
  tenantHandler((tx, auth, req) => defs.cloneToDraft(tx, auth, idParam(req)), 201));
workflowRouter.post('/workflows/definitions/:id/validate', canWrite,
  tenantHandler(async (tx, _a, req) => ({ errors: await defs.validateDefinition(tx, await defs.getDefinition(tx, idParam(req))) })));
workflowRouter.post('/workflows/definitions/:id/publish', canWrite,
  tenantHandler((tx, auth, req) => defs.publish(tx, auth, idParam(req))));
workflowRouter.delete('/workflows/definitions/:id', canWrite,
  tenantHandler(async (tx, _a, req) => { await defs.deleteDraft(tx, idParam(req)); }));

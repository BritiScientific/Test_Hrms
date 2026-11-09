import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import type { ContextSchema } from './condition-evaluator';

export interface WorkflowInstanceRow {
  tenant_id: number;
  id: number;
  workflow_id: number;
  module: string;
  entity_id: number;
  requested_by: number;
  requested_for_employee_id: number;
  status: 'pending' | 'returned' | 'approved' | 'rejected' | 'cancelled' | 'failed';
  cycle: number;
  current_step_order: number | null;
  context: Record<string, unknown>;
}

/**
 * A business module plugs into the engine by registering one handler.
 * Hooks run INSIDE the engine's transaction, so "approve task" and
 * "debit leave balance" commit or roll back together.
 */
export interface WorkflowModuleHandler {
  module: string;
  /** Fields a step condition may reference, with their types. */
  contextSchema: ContextSchema;
  onApproved(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number | null): Promise<void>;
  onRejected(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number): Promise<void>;
  onReturned(tx: Tx, inst: WorkflowInstanceRow, actorUserId: number): Promise<void>;
  /** Short summaries for the My Approvals inbox. */
  summarize?(tx: Tx, entityIds: number[]): Promise<Map<number, unknown>>;
  /** Extra read access (e.g. HR with leave.request.view_all can see any history). */
  canViewAll?(auth: AuthContext): boolean;
  /** Permission an action needs on top of the step's own (a module may separate approve from reject). */
  actionPermission?(action: 'approve' | 'reject' | 'return'): string | undefined;
}

const handlers = new Map<string, WorkflowModuleHandler>();

export function registerWorkflowHandler(h: WorkflowModuleHandler) {
  if (handlers.has(h.module)) throw new Error(`Workflow handler for ${h.module} already registered`);
  handlers.set(h.module, h);
}

export function getWorkflowHandler(module: string): WorkflowModuleHandler {
  const h = handlers.get(module);
  if (!h) throw new Error(`No workflow handler registered for module "${module}"`);
  return h;
}

export function hasWorkflowHandler(module: string) {
  return handlers.has(module);
}

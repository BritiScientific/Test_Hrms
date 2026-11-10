import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';

export type EntityType =
  | 'employee_type' | 'shift' | 'work_type' | 'rotating_shift' | 'rotating_work_type' | 'shift_schedule'
  | 'rotating_shift_assignment' | 'rotating_work_type_assignment';

export type AuditAction = 'created' | 'updated' | 'activated' | 'deactivated' | 'ended' | 'cancelled';

/** Bookkeeping and derived (read-only) fields that are never part of an audit diff. */
const NOT_BUSINESS = new Set([
  'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'warnings',
  'employeeCount', 'usage', 'activeAssignments', 'sequenceSummary', 'workingDaysSummary',
]);

/**
 * One append-only row per change, written with the caller's `tx` so it
 * commits or rolls back together with the change itself.
 */
export async function writeAudit(
  tx: Tx,
  auth: AuthContext,
  entry: { action: AuditAction; entityType: EntityType; entityId: number; before: unknown; after: unknown },
) {
  await tx.query(
    `INSERT INTO work_schedule_audit_log
       (tenant_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [auth.tenantId, auth.userId, entry.action, entry.entityType, entry.entityId,
     entry.before == null ? null : JSON.stringify(entry.before),
     entry.after == null ? null : JSON.stringify(entry.after),
     auth.requestId ?? null],
  );
}

/** Business fields of a record, without bookkeeping (for a "created" row). */
export function businessFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => !NOT_BUSINESS.has(k)));
}

/**
 * Only the business fields that changed, as before/after halves. Nested values
 * (rotation items, schedule days) compare by JSON. Returns null when nothing changed.
 */
export function diffFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOT_BUSINESS.has(key) || key === 'isActive') continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      b[key] = before[key] ?? null;
      a[key] = after[key] ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

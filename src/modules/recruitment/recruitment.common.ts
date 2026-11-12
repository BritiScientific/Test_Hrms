import { randomBytes } from 'node:crypto';
import type { Tx } from '../../config/db';
import { conflict } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';

/** Permission codes (module.resource.action). */
export const P = {
  pipelineView: 'recruitment.pipeline.view',
  manage: 'recruitment.manage',
  candidateView: 'recruitment.candidate.view',
  candidateManage: 'recruitment.candidate.manage',
  interviewView: 'recruitment.interview.view',
  interviewManage: 'recruitment.interview.manage',
  interviewFeedback: 'recruitment.interview.feedback',
  configView: 'recruitment.configuration.view',
  configManage: 'recruitment.configuration.manage',
} as const;

export type EntityType =
  | 'recruitment' | 'application' | 'candidate' | 'interview' | 'job_position' | 'survey_template' | 'rejection_reason' | 'settings';

/** Append-only audit row, written with the caller's tx so it commits or rolls back with the change. */
export async function writeAudit(
  tx: Tx,
  auth: Pick<AuthContext, 'tenantId' | 'userId' | 'requestId'> | { tenantId: number; userId: null; requestId?: string },
  entry: { action: string; entityType: EntityType; entityId: number; before?: unknown; after?: unknown },
) {
  await tx.query(
    `INSERT INTO rec_audit_log
       (tenant_id, actor_user_id, action, entity_type, entity_id, before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [auth.tenantId, auth.userId, entry.action, entry.entityType, entry.entityId,
     entry.before == null ? null : JSON.stringify(entry.before),
     entry.after == null ? null : JSON.stringify(entry.after),
     auth.requestId ?? null],
  );
}

/** Escape a user search term for ILIKE (backslash is PostgreSQL's default escape). */
export const likeTerm = (s: string) => `%${s.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** URL-safe slug with a random suffix: unique across tenants without a cross-tenant lookup (RLS hides other tenants). */
export function makeSlug(title: string): string {
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
    .replace(/-+$/, '');
  return `${base || 'job'}-${randomBytes(4).toString('hex')}`;
}

/** Human-friendly application reference, e.g. APP-2611-7F3A9C. Unique per tenant by index. */
export function makeReference(now = new Date()): string {
  const yymm = `${String(now.getUTCFullYear()).slice(2)}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `APP-${yymm}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

/** updated_at is microsecond precision; a JS Date (and so the client's copy) is milliseconds. Compare at ms. */
export function assertFresh(row: { updated_at: Date }, clientUpdatedAt: string) {
  if (row.updated_at.getTime() !== new Date(clientUpdatedAt).getTime()) {
    throw conflict('STALE_VERSION', 'This record was changed by someone else. Reload and try again.', {
      currentUpdatedAt: row.updated_at.toISOString(),
    });
  }
}

/** Fields the client sent in a patch, as `column = $n` fragments. Keys are a fixed whitelist chosen by the caller. */
export function buildSet(changes: Record<string, unknown>, startAt = 1) {
  const keys = Object.keys(changes);
  return {
    sql: keys.map((k, i) => `${k} = $${startAt + i}`).join(', '),
    values: keys.map((k) => changes[k]),
    next: startAt + keys.length,
  };
}

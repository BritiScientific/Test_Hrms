import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { conflict, notFound, unprocessable } from '../../shared/errors';

/**
 * Delegation is resolved at ACTION time: the task stays assigned to the real
 * approver, the delegate may act, and the log records actor + on_behalf_of.
 * This also covers tasks assigned before the delegation was created.
 * Chains are not followed (A->B and B->C does not let C act for A).
 */
export async function createDelegation(
  tx: Tx,
  auth: AuthContext,
  input: { delegateUserId: number; module?: string | null; from: string; to: string; reason?: string | null },
) {
  if (input.delegateUserId === auth.userId) throw unprocessable('SELF_DELEGATION', 'Cannot delegate to yourself');
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (!(to > from)) throw unprocessable('INVALID_PERIOD', '"to" must be after "from"');
  if (to.getTime() - from.getTime() > 90 * 24 * 3600 * 1000) {
    throw unprocessable('INVALID_PERIOD', 'Delegations are limited to 90 days');
  }
  const m = await tx.query(`SELECT status FROM tenant_users WHERE user_id = $1`, [input.delegateUserId]);
  if (!m.rowCount || m.rows[0].status !== 'active') throw notFound('Delegate user');

  const r = await tx.query(
    `INSERT INTO workflow_delegations
       (tenant_id, delegator_user_id, delegate_user_id, module, valid_during, reason, created_by)
     VALUES ($1, $2, $3, $4, tstzrange($5::timestamptz, $6::timestamptz, '[)'), $7, $2)
     RETURNING id, delegate_user_id, module, lower(valid_during) AS valid_from, upper(valid_during) AS valid_to`,
    [auth.tenantId, auth.userId, input.delegateUserId, input.module ?? null,
     from.toISOString(), to.toISOString(), input.reason ?? null],
  );
  return r.rows[0];
}

export async function revokeDelegation(tx: Tx, auth: AuthContext, id: number) {
  const r = await tx.query(
    `UPDATE workflow_delegations SET revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND delegator_user_id = $2 AND revoked_at IS NULL`,
    [id, auth.userId],
  );
  if (!r.rowCount) throw conflict('NOT_REVOCABLE', 'Delegation not found or already revoked');
}

export async function listMyDelegations(tx: Tx, auth: AuthContext) {
  const r = await tx.query(
    `SELECT id, delegator_user_id, delegate_user_id, module,
            lower(valid_during) AS valid_from, upper(valid_during) AS valid_to, revoked_at
       FROM workflow_delegations
      WHERE (delegator_user_id = $1 OR delegate_user_id = $1)
      ORDER BY created_at DESC`,
    [auth.userId],
  );
  return r.rows;
}

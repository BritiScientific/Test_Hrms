import type { Tx } from '../../config/db';

/**
 * Transactional outbox: events are inserted in the SAME transaction as the
 * state change and dispatched by a separate worker after commit. Never send
 * email/push from inside a request transaction (it may roll back).
 */
export async function enqueueEvent(
  tx: Tx,
  tenantId: number,
  eventType: string,
  aggregateType: string,
  aggregateId: number,
  payload: Record<string, unknown>,
) {
  await tx.query(
    `INSERT INTO outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, eventType, aggregateType, aggregateId, JSON.stringify(payload)],
  );
}

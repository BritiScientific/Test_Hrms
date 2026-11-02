import pg from 'pg';

/**
 * Outbox dispatcher. Connects as hrms_worker (sees outbox_events of all
 * tenants via its own RLS policy, nothing else). Run as a separate process:
 *   OUTBOX_DATABASE_URL=postgres://hrms_worker:...@host/hrms tsx src/modules/outbox/outbox.worker.ts
 * SKIP LOCKED lets several workers run in parallel without double-sending.
 */
type Dispatcher = (event: { event_type: string; tenant_id: number; payload: any }) => Promise<void>;

export async function drainOnce(pool: pg.Pool, dispatch: Dispatcher, batch = 50): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT tenant_id, id, event_type, payload, attempts
         FROM outbox_events
        WHERE processed_at IS NULL AND available_at <= now()
        ORDER BY available_at, id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batch],
    );
    for (const ev of rows) {
      try {
        await dispatch(ev);
        await client.query(
          `UPDATE outbox_events SET processed_at = now(), attempts = attempts + 1
            WHERE tenant_id = $1 AND id = $2`,
          [ev.tenant_id, ev.id],
        );
      } catch (err: any) {
        // exponential backoff, capped at 1h
        await client.query(
          `UPDATE outbox_events
              SET attempts = attempts + 1, last_error = $3,
                  available_at = now() + least(interval '1 hour', interval '5 seconds' * power(2, attempts))
            WHERE tenant_id = $1 AND id = $2`,
          [ev.tenant_id, ev.id, String(err?.message ?? err).slice(0, 1000)],
        );
      }
    }
    await client.query('COMMIT');
    return rows.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const pool = new pg.Pool({ connectionString: process.env.OUTBOX_DATABASE_URL });
  const dispatch: Dispatcher = async (ev) => {
    // Replace with email / push / websocket fan-out.
    console.log(`[outbox] tenant=${ev.tenant_id} ${ev.event_type}`, ev.payload);
  };
  const loop = async () => {
    try {
      const n = await drainOnce(pool, dispatch);
      setTimeout(loop, n ? 0 : 1000);
    } catch (e) {
      console.error('[outbox] drain failed', e);
      setTimeout(loop, 5000);
    }
  };
  loop();
}

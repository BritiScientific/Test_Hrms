import pg from 'pg';
import { env } from './env';

// --- type parsing -----------------------------------------------------------
// int8 ids -> number (safe below 2^53; switch to string/BigInt if you ever exceed it)
pg.types.setTypeParser(20, (v: string) => Number(v));
// numeric -> number (leave days are numeric(6,2); never use this for money)
pg.types.setTypeParser(1700, (v: string) => Number(v));
// DATE -> 'YYYY-MM-DD' string. The default parser builds a JS Date at local
// midnight, which shifts the day when serialised to UTC (IST: 2026-11-05 -> 2026-11-04T18:30Z).
pg.types.setTypeParser(1082, (v: string) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  statement_timeout: 15_000,
  application_name: 'hrms-api',
});

export type Tx = pg.PoolClient;

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Run `fn` in a transaction whose RLS tenant context is `tenantId`.
 * set_config(..., true) is transaction-local, so the setting can never leak
 * to the next request that reuses this pooled connection (also safe with
 * PgBouncer in transaction mode).
 */
export async function withTenantTx<T>(
  tenantId: number,
  fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T> {
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0) {
    throw new Error('withTenantTx: invalid tenant id');
  }
  const retries = opts.retries ?? 3;
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [String(tenantId)]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (RETRYABLE.has(err?.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * attempt + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

/** Single statement helper for queries that need no tenant context (auth helpers). */
export function queryNoTenant<R extends pg.QueryResultRow = any>(text: string, values?: unknown[]) {
  return pool.query<R>(text, values);
}

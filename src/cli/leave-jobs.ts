/**
 * Scheduled leave jobs. Run from cron or a task scheduler; re-running is safe.
 *
 *   npm run leave:jobs -- daily                       accrual, expiry, attachment and recruitment-upload cleanup
 *   npm run leave:jobs -- accrual  [--as-of YYYY-MM-DD] [--dry-run]
 *   npm run leave:jobs -- expiry   [--as-of YYYY-MM-DD] [--dry-run]
 *   npm run leave:jobs -- carry-forward --from-year 2026 [--dry-run]
 *
 * The owner connection is used for one thing: listing tenants, which the API role
 * cannot do. All work then runs as hrms_app inside withTenantTx, so RLS applies.
 *
 * Connection: OWNER_DATABASE_URL, or DATABASE_URL with the user switched to
 * hrms_owner / OWNER_PASSWORD.
 */
import './load-dotenv'; // first: the database config reads the environment when imported
import pg from 'pg';
import { pool, withTenantTx } from '../config/db';
import { runAccrual } from '../modules/leave/leave-accrual.service';
import { purgeOrphanAttachments } from '../modules/leave/leave-attachment.service';
import { purgeOrphanDocuments } from '../modules/recruitment/application.service';
import { runCarryForward, runExpiry } from '../modules/leave/leave-carry-forward.service';

function ownerUrl(): string {
  if (process.env.OWNER_DATABASE_URL) return process.env.OWNER_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://hrms_app@localhost:5432/hrms');
  u.username = 'hrms_owner';
  u.password = process.env.OWNER_PASSWORD ?? 'change_me_owner';
  return u.toString();
}

function args(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return out;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  if (!['daily', 'accrual', 'expiry', 'carry-forward'].includes(command) || (command === 'carry-forward' && !a['from-year'])) {
    console.error('Usage: leave-jobs daily | accrual [--as-of D] [--dry-run] | expiry [--as-of D] [--dry-run] | carry-forward --from-year Y [--dry-run]');
    process.exit(2);
  }

  const owner = new pg.Client({ connectionString: ownerUrl() });
  await owner.connect();
  const tenants = (await owner.query(`SELECT id, name FROM tenants WHERE is_active ORDER BY id`)).rows;
  await owner.end();

  const dryRun = a['dry-run'] === 'true';
  let failed = 0;
  for (const t of tenants) {
    const tenantId = Number(t.id);
    try {
      const result: Record<string, unknown> = {};
      if (command === 'accrual' || command === 'daily') {
        const { items: _items, ...summary } = await withTenantTx(tenantId, (tx) => runAccrual(tx, tenantId, { asOf: a['as-of'], dryRun }));
        result.accrual = summary;
      }
      if (command === 'expiry' || command === 'daily') {
        result.expiry = await withTenantTx(tenantId, (tx) => runExpiry(tx, tenantId, { asOf: a['as-of'], dryRun }));
      }
      if (command === 'carry-forward') {
        const { lines: _lines, ...summary } = await withTenantTx(tenantId, (tx) =>
          runCarryForward(tx, tenantId, { fromYear: Number(a['from-year']), dryRun }));
        result.carryForward = summary;
      }
      if (command === 'daily' && !dryRun) {
        result.orphanAttachmentsRemoved = await withTenantTx(tenantId, (tx) => purgeOrphanAttachments(tx));
        result.orphanCandidateDocumentsRemoved = await withTenantTx(tenantId, (tx) => purgeOrphanDocuments(tx));
      }
      console.log(JSON.stringify({ level: 'info', tenantId, command, ...result }));
    } catch (e: any) {
      // One tenant's failure must not stop the others. The exit code reports it.
      failed += 1;
      console.error(JSON.stringify({ level: 'error', tenantId, command, error: e?.message }));
    }
  }
  await pool.end();
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});

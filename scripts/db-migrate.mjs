/**
 * Forward-only migration runner (Windows, macOS, Linux) — unlike db:reset, this
 * keeps the data. Applied files are recorded in schema_migrations.
 *
 *   npm run db:migrate                     apply pending migrations
 *   npm run db:migrate -- --status         list applied and pending files, change nothing
 *   npm run db:migrate -- --baseline 010   first run on a database created by an older
 *                                          db:reset: record 001..010 as already applied
 *
 * A migration whose first line is `-- @destructive` drops data. Before one is
 * applied the database is dumped with pg_dump to backups/ (or --backup-dir), and
 * the run stops if the dump fails. --skip-backup is for throwaway databases only.
 *
 * Reads from .env (or the environment): ADMIN_DATABASE_URL, DB_NAME, OWNER_PASSWORD.
 * Runs as hrms_owner, who owns every object. pg_dump is found through PG_BIN, PATH
 * or the default Windows install folder.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const statusOnly = process.argv.includes('--status');
const skipBackup = process.argv.includes('--skip-backup');
const baseline = argValue('--baseline');
const backupDir = argValue('--backup-dir') ?? join(root, 'backups');

const DB_NAME = process.env.DB_NAME ?? 'hrms';
if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) throw new Error(`Unsafe DB_NAME: ${DB_NAME}`);
if (baseline !== undefined && !/^\d{3}$/.test(baseline)) throw new Error('--baseline takes a 3-digit number, e.g. 010');

const ownerUrl = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres');
ownerUrl.username = 'hrms_owner';
ownerUrl.password = process.env.OWNER_PASSWORD ?? 'change_me_owner';
ownerUrl.pathname = `/${DB_NAME}`;

const migrationsDir = join(root, 'db', 'migrations');
const files = readdirSync(migrationsDir).filter((f) => /^0*[1-9]\d*_.*\.sql$/.test(f)).sort();
const isDestructive = (f) => /^-- @destructive\b/.test(readFileSync(join(migrationsDir, f), 'utf8'));

function findPgDump() {
  const exe = process.platform === 'win32' ? 'pg_dump.exe' : 'pg_dump';
  if (process.env.PG_BIN && existsSync(join(process.env.PG_BIN, exe))) return join(process.env.PG_BIN, exe);
  const onPath = spawnSync(exe, ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return exe;
  const winRoot = 'C:\\Program Files\\PostgreSQL';
  if (process.platform === 'win32' && existsSync(winRoot)) {
    const versions = readdirSync(winRoot).sort((a, b) => Number(b) - Number(a));
    for (const v of versions) if (existsSync(join(winRoot, v, 'bin', exe))) return join(winRoot, v, 'bin', exe);
  }
  throw new Error('pg_dump not found. Set PG_BIN to the PostgreSQL bin folder.');
}

function backup() {
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const file = join(backupDir, `${DB_NAME}-${stamp}.dump`);
  const dumpUrl = new URL(ownerUrl);
  dumpUrl.password = '';
  execFileSync(findPgDump(), ['--format=custom', `--file=${file}`, `--dbname=${dumpUrl.toString()}`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, PGPASSWORD: decodeURIComponent(ownerUrl.password) },
  });
  if (statSync(file).size === 0) throw new Error(`Backup ${file} is empty`);
  return file;
}

const client = new pg.Client({ connectionString: ownerUrl.toString() });
await client.connect();
try {
  await client.query(`SET client_min_messages = warning`);
  const known = await client.query(`SELECT to_regclass('public.schema_migrations') AS t, to_regclass('public.tenants') AS core`);

  if (statusOnly) {
    // Reports only. --baseline shows what a run would do, without recording anything.
    const recorded = known.rows[0].t
      ? (await client.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename)
      : [];
    if (!known.rows[0].t && known.rows[0].core && baseline === undefined) {
      console.log('Not tracked yet: this database predates db:migrate. Run with --baseline <NNN> to record what it has.');
      process.exit(0);
    }
    const done = new Set([...recorded, ...files.filter((f) => baseline !== undefined && f.slice(0, 3) <= baseline)]);
    for (const f of files) console.log(`${done.has(f) ? 'applied' : 'PENDING'}  ${f}${isDestructive(f) ? '  (destructive)' : ''}`);
    process.exit(0);
  }

  if (!known.rows[0].t) {
    if (known.rows[0].core && baseline === undefined) {
      throw new Error('This database predates db:migrate. Check which migrations it has, then run with --baseline <NNN>.');
    }
    await client.query(`
      CREATE TABLE schema_migrations (
        filename    text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`);
  }
  if (baseline !== undefined) {
    const upTo = files.filter((f) => f.slice(0, 3) <= baseline);
    for (const f of upTo) {
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [f]);
    }
    console.log(`Baseline: recorded ${upTo.length} migrations up to ${baseline} as applied.`);
  }

  const applied = new Set((await client.query(`SELECT filename FROM schema_migrations`)).rows.map((r) => r.filename));
  const pending = files.filter((f) => !applied.has(f));

  if (!pending.length) {
    console.log('Nothing to apply.');
    process.exit(0);
  }

  if (pending.some(isDestructive)) {
    if (skipBackup) {
      console.log('WARNING: --skip-backup: destructive migrations will run with no dump.');
    } else {
      console.log(`Destructive migration pending. Backing up ${DB_NAME}...`);
      console.log(`  ${backup()}`);
    }
  }

  for (const f of pending) {
    process.stdout.write(`  ${f} ... `);
    await client.query('BEGIN');
    try {
      await client.query(readFileSync(join(migrationsDir, f), 'utf8'));
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [f]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.log('FAILED');
      throw new Error(`${f}: ${e.message}`);
    }
  }
  console.log(`Applied ${pending.length} migration(s).`);
} finally {
  await client.end();
}

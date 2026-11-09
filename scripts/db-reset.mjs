/**
 * Cross-platform database reset (Windows, macOS, Linux) — no psql needed.
 *
 *   npm run db:reset              drop + recreate + migrate + seed
 *   npm run db:reset -- --no-seed  skip the demo data
 *
 * Reads from .env (or the environment):
 *   ADMIN_DATABASE_URL  superuser connection, e.g. postgres://postgres:pw@localhost:5432/postgres
 *   DB_NAME             database to create (default: hrms)
 *   OWNER_PASSWORD / APP_PASSWORD / WORKER_PASSWORD
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so this works before any dotenv dependency exists.
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const ADMIN_URL = process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
const DB_NAME = process.env.DB_NAME ?? 'hrms';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD ?? 'change_me_owner';
const APP_PASSWORD = process.env.APP_PASSWORD ?? 'change_me_app';
const WORKER_PASSWORD = process.env.WORKER_PASSWORD ?? 'change_me_worker';
const seed = !process.argv.includes('--no-seed');

if (!/^[a-z_][a-z0-9_]*$/.test(DB_NAME)) throw new Error(`Unsafe DB_NAME: ${DB_NAME}`);

const read = (...p) => readFileSync(join(root, ...p), 'utf8');

async function connect(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Send a whole file as one simple query: multi-statement and $$-block safe. */
async function runFile(client, label, sql) {
  process.stdout.write(`  ${label} ... `);
  await client.query(sql);
  console.log('ok');
}

const adminUrl = new URL(ADMIN_URL);
const ownerUrl = new URL(ADMIN_URL);
ownerUrl.username = 'hrms_owner';
ownerUrl.password = OWNER_PASSWORD;
ownerUrl.pathname = `/${DB_NAME}`;

const admin = await connect(adminUrl.toString());
try {
  console.log(`Resetting ${DB_NAME} on ${adminUrl.host}`);

  console.log('- roles');
  await admin.query(
    read('db', 'migrations', '000_bootstrap_roles.sql')
      .replace("'change_me_owner'", `'${OWNER_PASSWORD.replace(/'/g, "''")}'`)
      .replace("'change_me_app'", `'${APP_PASSWORD.replace(/'/g, "''")}'`)
      .replace("'change_me_worker'", `'${WORKER_PASSWORD.replace(/'/g, "''")}'`),
  );
  // Re-apply passwords in case the roles already existed from an earlier run.
  for (const [role, pw] of [['hrms_owner', OWNER_PASSWORD], ['hrms_app', APP_PASSWORD], ['hrms_worker', WORKER_PASSWORD]]) {
    await admin.query(`ALTER ROLE ${role} WITH PASSWORD '${pw.replace(/'/g, "''")}'`);
  }

  console.log('- database');
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${DB_NAME} OWNER hrms_owner`);
} finally {
  await admin.end();
}

// Lock down the public schema, as the owner's superuser would.
const adminOnDb = await connect(new URL(`/${DB_NAME}`, adminUrl).toString());
try {
  await adminOnDb.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await adminOnDb.query('ALTER SCHEMA public OWNER TO hrms_owner');
} finally {
  await adminOnDb.end();
}

const owner = await connect(ownerUrl.toString());
try {
  console.log('- migrations');
  const files = readdirSync(join(root, 'db', 'migrations')).filter((f) => /^0*[1-9]\d*_.*\.sql$/.test(f)).sort();
  for (const f of files) await runFile(owner, f, read('db', 'migrations', f));
  // Same bookkeeping as scripts/db-migrate.mjs, so db:migrate works after a reset.
  await owner.query(`CREATE TABLE schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  await owner.query(`INSERT INTO schema_migrations (filename) SELECT unnest($1::text[])`, [files]);

  if (seed) {
    console.log('- seed');
    await runFile(owner, 'dev_seed.sql', read('db', 'seed', 'dev_seed.sql'));
  }
} finally {
  await owner.end();
}

console.log(`\nDone. API connection string:\n  postgres://hrms_app:${APP_PASSWORD}@${adminUrl.host}/${DB_NAME}`);

/**
 * The replacement migrations against a database in the state production is in:
 * migrated to 010, holding old leave data and in-flight workflows. Uses its own
 * database, `<DB_NAME>_migration`, created and dropped here.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const root = path.join(__dirname, '..');
const DB = `${process.env.DB_NAME ?? 'hrms'}_migration`;
assert.match(DB, /^[a-z_][a-z0-9_]*$/);

const adminUrl = (dbName?: string) => {
  const u = new URL(process.env.ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres');
  if (dbName) u.pathname = `/${dbName}`;
  return u.toString();
};
const ownerUrl = () => {
  const u = new URL(adminUrl(DB));
  u.username = 'hrms_owner';
  u.password = encodeURIComponent(process.env.OWNER_PASSWORD ?? 'change_me_owner');
  return u.toString();
};

let db: pg.Client;
const ids: Record<string, number> = {};

async function withAdmin(fn: (c: pg.Client) => Promise<void>) {
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  try { await fn(c); } finally { await c.end(); }
}

function migrate(...args: string[]) {
  return execFileSync(process.execPath, [path.join(root, 'scripts', 'db-migrate.mjs'), ...args], {
    env: { ...process.env, DB_NAME: DB }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

before(async () => {
  await withAdmin(async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await c.query(`CREATE DATABASE ${DB} OWNER hrms_owner`);
  });
  const su = new pg.Client({ connectionString: adminUrl(DB) });
  await su.connect();
  await su.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await su.query('ALTER SCHEMA public OWNER TO hrms_owner');
  await su.end();

  db = new pg.Client({ connectionString: ownerUrl() });
  await db.connect();
  const files = readdirSync(path.join(root, 'db', 'migrations')).filter((f) => /^0*[1-9]\d*_.*\.sql$/.test(f)).sort();
  for (const f of files.filter((x) => x.slice(0, 3) <= '010')) {
    await db.query(readFileSync(path.join(root, 'db', 'migrations', f), 'utf8'));
  }

  // The old world: roles holding old permissions, a published workflow, a balance, an in-flight request.
  const one = async (sql: string, p: unknown[] = []) => Number((await db.query(sql, p)).rows[0].id);
  ids.tenant = await one(`INSERT INTO tenants (name, slug) VALUES ('Old Co', 'old-co') RETURNING id`);
  const t = ids.tenant;
  ids.u1 = await one(`INSERT INTO users (email, full_name) VALUES ('a@old.test', 'A') RETURNING id`);
  ids.u2 = await one(`INSERT INTO users (email, full_name) VALUES ('b@old.test', 'B') RETURNING id`);
  await db.query(`INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2), ($1, $3)`, [t, ids.u1, ids.u2]);
  ids.e1 = await one(`INSERT INTO employees (tenant_id, user_id, employee_code, full_name) VALUES ($1, $2, 'E1', 'A') RETURNING id`, [t, ids.u1]);
  ids.emp = await one(`INSERT INTO roles (tenant_id, name) VALUES ($1, 'Employee') RETURNING id`, [t]);
  ids.mgr = await one(`INSERT INTO roles (tenant_id, name) VALUES ($1, 'Manager') RETURNING id`, [t]);
  ids.hr = await one(`INSERT INTO roles (tenant_id, name) VALUES ($1, 'HR') RETURNING id`, [t]);
  ids.admin = await one(`INSERT INTO roles (tenant_id, name, is_system_role) VALUES ($1, 'Tenant Admin', true) RETURNING id`, [t]);
  ids.other = await one(`INSERT INTO roles (tenant_id, name) VALUES ($1, 'Payroll') RETURNING id`, [t]);
  const grant = (role: number, codes: string[]) => db.query(
    `INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions WHERE code = ANY($3)`, [t, role, codes]);
  await grant(ids.emp, ['leave.create', 'leave.view.own', 'leave.withdraw']);
  await grant(ids.mgr, ['leave.view.team', 'leave.approve']);
  await grant(ids.hr, ['leave.view.all', 'leave.approve', 'leave.balance.manage', 'leave.type.manage']);
  await grant(ids.other, ['payroll.view']);
  await db.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) SELECT $1, $2, id FROM permissions`, [t, ids.admin]);

  ids.wf = await one(`INSERT INTO workflow_definitions (tenant_id, module, name, version, created_by) VALUES ($1, 'leave', 'Leave', 1, $2) RETURNING id`, [t, ids.u2]);
  ids.step = await one(
    `INSERT INTO workflow_steps (tenant_id, workflow_id, step_order, name, approver_type, required_permission_code)
     VALUES ($1, $2, 1, 'Manager', 'reporting_manager', 'leave.approve') RETURNING id`, [t, ids.wf]);
  await db.query(`UPDATE workflow_definitions SET status = 'published', published_by = $2, published_at = now() WHERE id = $1`, [ids.wf, ids.u2]);

  ids.lt = await one(`INSERT INTO leave_types (tenant_id, code, name) VALUES ($1, 'annual', 'Annual') RETURNING id`, [t]);
  ids.bal = await one(`INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, period_year) VALUES ($1, $2, $3, 2026) RETURNING id`, [t, ids.e1, ids.lt]);
  await db.query(`INSERT INTO leave_balance_transactions (tenant_id, balance_id, txn_type, allocated_delta) VALUES ($1, $2, 'allocation', 20)`, [t, ids.bal]);
  ids.req = await one(
    `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, total_days, period_year, applied_by)
     VALUES ($1, $2, $3, '2026-11-16', '2026-11-16', 1, 2026, $4) RETURNING id`, [t, ids.e1, ids.lt, ids.u1]);
  ids.inst = await one(
    `INSERT INTO workflow_instances (tenant_id, workflow_id, module, entity_id, requested_by, requested_for_employee_id, current_step_order)
     VALUES ($1, $2, 'leave', $3, $4, $5, 1) RETURNING id`, [t, ids.wf, ids.req, ids.u1, ids.e1]);
  ids.task = await one(
    `INSERT INTO workflow_tasks (tenant_id, workflow_instance_id, workflow_id, workflow_step_id, step_order, cycle, assigned_to)
     VALUES ($1, $2, $3, $4, 1, 1, $5) RETURNING id`, [t, ids.inst, ids.wf, ids.step, ids.u2]);
  await db.query(`INSERT INTO outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, 'leave.submitted', 'leave_request', $2, '{}')`, [t, ids.req]);
  await db.query(`INSERT INTO outbox_events (tenant_id, event_type, aggregate_type, aggregate_id, payload) VALUES ($1, 'other.event', 'employee', 1, '{}')`, [t]);
});

after(async () => {
  await db?.end();
  await withAdmin(async (c) => { await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); });
});

const rolePerms = async (role: number) =>
  (await db.query(`SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1 ORDER BY 1`, [role])).rows.map((r) => r.code);

describe('db:migrate', () => {
  test('an untracked database needs an explicit baseline', () => {
    assert.throws(() => migrate(), /predates db:migrate/);
  });

  test('status shows the destructive migration as pending, and changes nothing', () => {
    const out = migrate('--baseline', '010', '--status');
    assert.match(out, /applied {2}010_organization_chart\.sql/);
    assert.match(out, /PENDING {2}011_leave_remove_legacy\.sql {2}\(destructive\)/);
    assert.match(out, /PENDING {2}014_leave_permissions\.sql/);
  });

  test('applies the pending migrations', async () => {
    const out = migrate('--baseline', '010', '--skip-backup');
    // Everything after 010: the leave replacement (011-015) and any later module migrations.
    const pending = readdirSync(path.join(root, 'db', 'migrations'))
      .filter((f) => /^0*[1-9]\d*_.*\.sql$/.test(f) && f.slice(0, 3) > '010').length;
    assert.match(out, new RegExp(`Applied ${pending} migration`));
    assert.match(out, /015_leave_comp_off_workflow\.sql \.\.\. ok/);
    assert.match(migrate(), /Nothing to apply/);
  });
});

describe('after the replacement', () => {
  test('the new tables exist and the old shape is gone', async () => {
    const col = async (t: string, c: string) => (await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [t, c])).rowCount;
    assert.equal(await col('leave_requests', 'period_year'), 0);
    assert.equal(await col('leave_requests', 'leave_year'), 1);
    assert.equal(await col('leave_balances', 'allocated'), 0);
    assert.equal((await db.query(`SELECT to_regclass('public.holidays') AS t`)).rows[0].t, null);
  });

  test('old leave data is removed, as documented', async () => {
    for (const t of ['leave_types', 'leave_requests', 'leave_balances', 'leave_balance_transactions']) {
      assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n, 0, t);
    }
  });

  test('unrelated data is untouched', async () => {
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM employees`)).rows[0].n, 1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM roles`)).rows[0].n, 5);
    assert.deepEqual(await rolePerms(ids.other), ['payroll.view']);
    const other = await db.query(`SELECT processed_at FROM outbox_events WHERE event_type = 'other.event'`);
    assert.equal(other.rows[0].processed_at, null, 'other modules’ events are still queued');
  });

  test('in-flight workflows are closed, not deleted, and their history is kept', async () => {
    const i = (await db.query(`SELECT status, completed_at FROM workflow_instances WHERE id = $1`, [ids.inst])).rows[0];
    assert.equal(i.status, 'cancelled');
    assert.ok(i.completed_at);
    assert.equal((await db.query(`SELECT status FROM workflow_tasks WHERE id = $1`, [ids.task])).rows[0].status, 'cancelled');
    const log = await db.query(`SELECT action, comments FROM workflow_action_logs WHERE workflow_instance_id = $1`, [ids.inst]);
    assert.equal(log.rows[0].action, 'cancel');
    assert.match(log.rows[0].comments, /replacement/);
    const ev = await db.query(`SELECT processed_at FROM outbox_events WHERE event_type = 'leave.submitted'`);
    assert.ok(ev.rows[0].processed_at, 'notifications about removed requests are not sent');
  });

  test('a new request can reuse the id of a removed one', async () => {
    const r = await db.query(`SELECT 1 FROM workflow_instances WHERE module = 'leave' AND status IN ('pending', 'returned')`);
    assert.equal(r.rowCount, 0, 'nothing active is left to collide with uq_wf_instance_active_entity');
  });

  test('old permission codes are gone', async () => {
    const r = await db.query(`SELECT code FROM permissions WHERE code = ANY($1)`, [[
      'leave.create', 'leave.view.own', 'leave.view.team', 'leave.view.all', 'leave.approve',
      'leave.withdraw', 'leave.balance.manage', 'leave.type.manage',
    ]]);
    assert.equal(r.rowCount, 0);
  });

  test('each role gets the new codes for what it held, and nothing more', async () => {
    assert.deepEqual(await rolePerms(ids.emp), [
      'leave.balance.view_self', 'leave.calendar.view_self', 'leave.dashboard.view_self', 'leave.request.cancel_self',
      'leave.request.create_self', 'leave.request.view_self',
    ]);
    assert.deepEqual(await rolePerms(ids.mgr), [
      'leave.approval_history.view_team', 'leave.dashboard.view_team', 'leave.request.approve',
      'leave.request.reject', 'leave.request.return', 'leave.request.view_team',
    ]);
    const hr = await rolePerms(ids.hr);
    assert.ok(hr.includes('leave.configuration.manage') && hr.includes('leave.balance.adjust') && hr.includes('leave.request.view_all'));
    assert.ok(!hr.includes('leave.request.create_self'), 'HR role did not hold the self-service permission before');
  });

  test('Tenant Admin keeps full access to the new catalog', async () => {
    const all = (await db.query(`SELECT code FROM permissions WHERE module = 'leave'`)).rows.map((r) => r.code);
    const admin = await rolePerms(ids.admin);
    assert.equal(all.length, 21);
    for (const c of all) assert.ok(admin.includes(c), c);
  });

  test('published workflow steps point at the new permission and stay immutable', async () => {
    const s = await db.query(`SELECT required_permission_code FROM workflow_steps WHERE id = $1`, [ids.step]);
    assert.equal(s.rows[0].required_permission_code, 'leave.request.approve');
    const def = await db.query(`SELECT status FROM workflow_definitions WHERE id = $1`, [ids.wf]);
    assert.equal(def.rows[0].status, 'published');
    await assert.rejects(db.query(`UPDATE workflow_steps SET name = 'x' WHERE id = $1`, [ids.step]), /immutable/);
  });

  test('the API role can use the new tables, within its limits', async () => {
    const grants = async (table: string) => (await db.query(
      `SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'hrms_app' AND table_name = $1`, [table])).rows.map((r) => r.privilege_type).sort();
    assert.deepEqual(await grants('leave_balance_transactions'), ['INSERT', 'SELECT']);
    assert.deepEqual(await grants('leave_audit_log'), ['INSERT', 'SELECT']);
    assert.deepEqual(await grants('leave_balances'), ['SELECT']);
    assert.ok((await grants('leave_requests')).includes('UPDATE'));
    assert.ok(!(await grants('leave_requests')).includes('DELETE'));
    assert.ok(!(await grants('leave_types')).includes('DELETE'), 'leave types are deactivated, not deleted');
  });
});

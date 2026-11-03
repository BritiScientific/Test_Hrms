/**
 * Employee creation, approach "A + D", over HTTP against the real database:
 *   A — HR quick add: one transaction, only name / work email / joining date required.
 *   D — the employee activates and fills their own personal details; HR can still edit anything.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import pg from 'pg';

import { createApp } from '../src/app';
import { pool } from '../src/config/db';

const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const PASSWORD = 'Passw0rd!';
let server: Server;
let base = '';
const uid: Record<string, number> = {};
const empId: Record<string, number> = {};
const role: Record<string, number> = {};
const tokens: Record<string, string> = {};
let deptEng = 0;

interface Res { status: number; json: any }
async function call(method: string, url: string, token?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
function expectStatus(r: Res, status: number, code?: string) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  if (code) assert.equal(r.json?.error?.code, code);
}
async function login(email: string, password = PASSWORD) {
  const r = await call('POST', '/auth/login', undefined, { email, password });
  expectStatus(r, 200);
  return r.json.accessToken as string;
}
const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const today = () => new Date().toISOString().slice(0, 10);

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  for (const r of (await admin.query(`SELECT id, split_part(email, '@', 1) AS n FROM users`)).rows) uid[r.n] = Number(r.id);
  for (const r of (await admin.query(`SELECT tenant_id, id, name FROM roles`)).rows) role[`${r.tenant_id}:${r.name}`] = Number(r.id);
  for (const r of (await admin.query(`SELECT e.id, split_part(u.email, '@', 1) AS n FROM employees e JOIN users u ON u.id = e.user_id`)).rows) empId[r.n] = Number(r.id);
  deptEng = Number((await admin.query(`SELECT id FROM departments WHERE tenant_id = 1 AND name = 'Engineering'`)).rows[0].id);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens.suresh = await login('suresh@abc.test');   // HR Admin: employee.view/create/update + roles.assign
  tokens.krishna = await login('krishna@abc.test'); // manager: no employee.* permissions
  tokens.rahul = await login('rahul@abc.test');     // employee
  tokens.meera = await login('meera@xyz.test');     // other tenant's admin
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.end();
});

const state: Record<string, any> = {};

describe('A · HR quick add (single transaction, minimal fields)', () => {
  test('suggests the next employee code from the tenant’s own convention', async () => {
    const r = await call('GET', '/employees/next-code', tokens.suresh);
    expectStatus(r, 200);
    assert.equal(r.json.employeeCode, 'E901');
  });

  test('only name, work email and joining date are required', async () => {
    const missing = await call('POST', '/employees', tokens.suresh, { fullName: 'Nobody' });
    expectStatus(missing, 422, 'VALIDATION_FAILED');
    assert.ok(missing.json.error.details.fieldErrors.workEmail && missing.json.error.details.fieldErrors.dateOfJoining);

    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Divya Nair', workEmail: 'divya@abc.test', dateOfJoining: today(),
    });
    expectStatus(r, 201);
    assert.equal(r.json.employee.employeeCode, 'E901');
    assert.equal(r.json.employee.access.status, 'invited');
    assert.equal(r.json.employee.profile.completed, false);
    assert.match(r.json.invitation.url, /\/activate\?token=[A-Za-z0-9_-]{43}$/);
    state.divya = r.json;
  });

  test('everything was created together: identity, invited membership, employee record', async () => {
    const rows = await admin.query(
      `SELECT u.password_hash, tu.status, e.employee_code FROM users u
         JOIN tenant_users tu ON tu.user_id = u.id AND tu.tenant_id = 1
         JOIN employees e ON e.user_id = u.id AND e.tenant_id = 1
        WHERE u.email = 'divya@abc.test'`);
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0].password_hash, null, 'no password until the employee activates');
    assert.equal(rows.rows[0].status, 'invited');
    expectStatus(await call('POST', '/auth/login', undefined, { email: 'divya@abc.test', password: 'anything-1' }), 401, 'INVALID_CREDENTIALS');
  });

  test('optional details: department, manager and roles in the same call (roles inert until activation)', async () => {
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Farhan Ali', workEmail: 'farhan@abc.test', dateOfJoining: today(), jobTitle: 'QA Engineer',
      departmentId: deptEng, managerId: empId.krishna, roleIds: [role['1:Employee']],
    });
    expectStatus(r, 201);
    assert.equal(r.json.employee.department.name, 'Engineering');
    assert.equal(r.json.employee.manager.name, 'Krishna');
    const u = Number(r.json.employee.userId);
    const eff = await admin.query(`SELECT count(*)::int AS n FROM v_effective_permissions WHERE user_id = $1`, [u]);
    assert.equal(eff.rows[0].n, 0, 'an invited member has no effective permissions yet');
    const assigned = await admin.query(`SELECT count(*)::int AS n FROM user_roles WHERE user_id = $1 AND revoked_at IS NULL`, [u]);
    assert.equal(assigned.rows[0].n, 1);
    state.farhan = r.json;
  });

  test('a failure anywhere rolls the whole quick add back (no half-created people)', async () => {
    // A role from ANOTHER tenant fails at the role step, after identity/membership/record were written.
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Ghost Person', workEmail: 'ghost@abc.test', dateOfJoining: today(), roleIds: [role['2:Employee']],
    });
    expectStatus(r, 404);
    const left = await admin.query(
      `SELECT (SELECT count(*) FROM users WHERE email = 'ghost@abc.test')::int AS users,
              (SELECT count(*) FROM employees WHERE full_name = 'Ghost Person')::int AS employees`);
    assert.deepEqual(left.rows[0], { users: 0, employees: 0 });
  });

  test('duplicates are refused: same person, same code', async () => {
    expectStatus(await call('POST', '/employees', tokens.suresh, {
      fullName: 'Divya Again', workEmail: 'DIVYA@abc.test', dateOfJoining: today(),
    }), 409, 'EMPLOYEE_EXISTS');
    const code = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Code Clash', workEmail: 'clash@abc.test', dateOfJoining: today(), employeeCode: 'E501',
    });
    expectStatus(code, 422, 'VALIDATION_FAILED');
    assert.ok(code.json.error.details.fieldErrors.employeeCode);
  });

  test('an existing member without an employee record is linked, keeping their access', async () => {
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Kiran Rao', workEmail: 'kiran@partners.test', dateOfJoining: today(),
    });
    expectStatus(r, 201);
    assert.equal(r.json.linkedExistingMember, true);
    assert.equal(r.json.invitation, null);
    assert.equal(r.json.employee.access.status, 'active');
  });

  test('permissions are enforced by the API', async () => {
    expectStatus(await call('POST', '/employees', tokens.krishna, { fullName: 'X Y', workEmail: 'x@abc.test', dateOfJoining: today() }), 403);
    expectStatus(await call('GET', '/employees', tokens.rahul), 403);
    expectStatus(await call('GET', `/employees/${empId.krishna}`, tokens.rahul), 403);
    expectStatus(await call('GET', `/employees/${empId.rahul}`, tokens.rahul), 200); // own record
  });
});

describe('D · employee self-service', () => {
  test('activation preview says it is an employee invitation; activating signs them in', async () => {
    const token = tokenOf(state.divya.invitation.url);
    const info = await call('GET', `/onboarding/invitations/${token}`);
    expectStatus(info, 200);
    assert.equal(info.json.kind, 'employee');
    assert.equal(info.json.organizationName, 'ABC Technologies');
    const ok = await call('POST', '/onboarding/activate', undefined, { token, password: 'Kochi-Secure-2026' });
    expectStatus(ok, 200);
    tokens.divya = ok.json.accessToken;
    const me = await call('GET', '/me', tokens.divya);
    assert.equal(me.json.employee.profileCompleted, false);
    assert.equal(me.json.tenant.slug, 'abc-technologies');
  });

  test('the employee fills their own details; HR-owned fields are not writable', async () => {
    expectStatus(await call('PATCH', '/me/employee', tokens.divya, { jobTitle: 'CEO' }), 422);
    expectStatus(await call('PATCH', '/me/employee', tokens.divya, { employeeCode: 'X1' }), 422);
    expectStatus(await call('PATCH', `/employees/${state.divya.employee.id}`, tokens.divya, { mobilePhone: '+91 90000 00000' }), 403);

    const partial = await call('PATCH', '/me/employee', tokens.divya, {
      dateOfBirth: '1996-04-12', mobilePhone: '+91 98450 11111', gender: 'female',
    });
    expectStatus(partial, 200);
    assert.equal(partial.json.profile.completed, false);
    assert.equal(partial.json.profile.done, 2);

    expectStatus(await call('PATCH', '/me/employee', tokens.divya, { address: { countryCode: 'IN', postalCode: '12' } }), 422);
    const done = await call('PATCH', '/me/employee', tokens.divya, {
      address: { line1: '4 Lake View', city: 'Kochi', countryCode: 'IN', postalCode: '682001' },
      emergencyContact: { name: 'Arun Nair', relation: 'Brother', phone: '+91 98450 22222' },
    });
    expectStatus(done, 200);
    assert.equal(done.json.profile.completed, true);
    assert.ok(done.json.profile.completedAt);
    const me = await call('GET', '/me', tokens.divya);
    assert.equal(me.json.employee.profileCompleted, true);
    const audit = await admin.query(
      `SELECT action FROM employee_audit_log WHERE employee_id = $1 ORDER BY id`, [state.divya.employee.id]);
    assert.deepEqual(audit.rows.map((r) => r.action),
      ['employee.invite', 'employee.create', 'employee.self_update', 'employee.self_update', 'employee.profile.complete']);
  });
});

describe('HR can still fill anything directly', () => {
  test('HR edits job and self-service fields, changes the manager, with optimistic concurrency', async () => {
    const id = state.farhan.employee.id;
    const cur = await call('GET', `/employees/${id}`, tokens.suresh);
    const r = await call('PATCH', `/employees/${id}`, tokens.suresh, {
      jobTitle: 'Senior QA Engineer', mobilePhone: '+91 99000 33333', managerId: empId.suresh, version: cur.json.version,
    });
    expectStatus(r, 200);
    assert.equal(r.json.jobTitle, 'Senior QA Engineer');
    assert.equal(r.json.mobilePhone, '+91 99000 33333');
    assert.equal(r.json.manager.name, 'Suresh');
    expectStatus(await call('PATCH', `/employees/${id}`, tokens.suresh, { jobTitle: 'Other', version: cur.json.version }), 409, 'VERSION_CONFLICT');
    expectStatus(await call('PATCH', `/employees/${id}`, tokens.krishna, { jobTitle: 'Hacked' }), 403);
    expectStatus(await call('PATCH', `/employees/${id}`, tokens.suresh, { managerId: id }), 422);
  });

  test('re-issuing a link invalidates the old one; active employees need no link', async () => {
    const id = state.farhan.employee.id;
    const oldToken = tokenOf(state.farhan.invitation.url);
    const r = await call('POST', `/employees/${id}/invitation`, tokens.suresh);
    expectStatus(r, 201);
    expectStatus(await call('GET', `/onboarding/invitations/${oldToken}`), 404, 'INVITATION_INVALID');
    expectStatus(await call('GET', `/onboarding/invitations/${tokenOf(r.json.url)}`), 200);
    expectStatus(await call('POST', `/employees/${state.divya.employee.id}/invitation`, tokens.suresh), 409, 'ALREADY_ACTIVE');
  });

  test('marking an employee as exited ends their access immediately', async () => {
    const id = state.divya.employee.id;
    expectStatus(await call('PATCH', `/employees/${id}`, tokens.suresh, { status: 'exited' }), 200);
    expectStatus(await call('GET', '/me', tokens.divya), 401);
    expectStatus(await call('POST', '/auth/login', undefined, { email: 'divya@abc.test', password: 'Kochi-Secure-2026' }), 403, 'NO_TENANT');
    const list = await call('GET', '/employees?search=divya', tokens.suresh);
    assert.equal(list.json.total, 0, 'exited people are hidden from the default list');
    const exited = await call('GET', '/employees?search=divya&status=exited', tokens.suresh);
    assert.equal(exited.json.total, 1);
  });

  test('departments can be created for quick add', async () => {
    const d = await call('POST', '/departments', tokens.suresh, { name: 'Finance' });
    expectStatus(d, 201);
    expectStatus(await call('POST', '/departments', tokens.suresh, { name: 'finance' }), 409);
    const list = await call('GET', '/departments', tokens.suresh);
    assert.ok(list.json.some((x: any) => x.name === 'Engineering' && x.headcount >= 4));
  });
});

describe('Tenant isolation & audit', () => {
  test('another tenant can neither see nor change these employees', async () => {
    const id = state.farhan.employee.id;
    expectStatus(await call('GET', `/employees/${id}`, tokens.meera), 404);
    expectStatus(await call('PATCH', `/employees/${id}`, tokens.meera, { jobTitle: 'x' }), 404);
    expectStatus(await call('POST', `/employees/${id}/invitation`, tokens.meera), 404);
    const list = await call('GET', '/employees?limit=100', tokens.meera);
    assert.ok(list.json.items.every((e: any) => !String(e.workEmail).endsWith('@abc.test')));
    // Quick add in tenant 2 with a tenant-1 manager id is rejected.
    expectStatus(await call('POST', '/employees', tokens.meera, {
      fullName: 'Cross Tenant', workEmail: 'cross@xyz.test', dateOfJoining: today(), managerId: empId.krishna,
    }), 422);
  });

  test('employee changes appear in the audit timeline for HR only', async () => {
    const a = await call('GET', `/audit-events?category=employee&targetType=employee&targetId=${state.farhan.employee.id}`, tokens.suresh);
    expectStatus(a, 200);
    assert.ok(a.json.items.some((e: any) => e.action === 'employee.update'));
    assert.ok(a.json.items.every((e: any) => e.category === 'employee'));
    expectStatus(await call('GET', '/audit-events', tokens.rahul), 403);
  });
});

/**
 * Organization chart over HTTP against the real database, as the NOBYPASSRLS app role:
 * permissions, effective dating, exited employees, cycle rules and tenant isolation.
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
const emp: Record<string, number> = {};
const tokens: Record<string, string> = {};
let deptEng = 0;
let deptHr = 0;

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
async function login(email: string) {
  const r = await call('POST', '/auth/login', undefined, { email, password: PASSWORD });
  expectStatus(r, 200);
  return r.json.accessToken as string;
}
async function chart(query = '', token = tokens.suresh) {
  const r = await call('GET', `/organization/chart${query}`, token);
  expectStatus(r, 200);
  return r.json;
}
function flatten(nodes: any[]): any[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
const everyone = (c: any) => flatten([...c.roots, ...c.unassigned]);
const names = (nodes: any[]) => nodes.map((n) => n.fullName);
const find = (c: any, name: string) => everyone(c).find((n) => n.fullName === name);
const isoDay = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  for (const r of (await admin.query(`SELECT id, full_name FROM employees`)).rows) emp[r.full_name] = Number(r.id);
  for (const r of (await admin.query(`SELECT id, name FROM departments WHERE tenant_id = 1`)).rows) {
    if (r.name === 'Engineering') deptEng = Number(r.id);
    if (r.name === 'Human Resources') deptHr = Number(r.id);
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens.suresh = await login('suresh@abc.test'); // HR Admin
  tokens.asha = await login('asha@abc.test');     // Tenant Admin
  tokens.rahul = await login('rahul@abc.test');   // Employee: no chart permission
  tokens.meera = await login('meera@xyz.test');   // other tenant's admin
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.end();
});

describe('access', () => {
  test('requires authentication and organization.chart.view', async () => {
    expectStatus(await call('GET', '/organization/chart'), 401);
    expectStatus(await call('GET', '/organization/chart', tokens.rahul), 403, 'MISSING_PERMISSION');
    expectStatus(await call('GET', '/organization/chart', tokens.asha), 200);
  });

  test('the permission is in the catalogue and can be granted to a role on its own', async () => {
    const perm = await admin.query(`SELECT id, module FROM permissions WHERE code = 'organization.chart.view'`);
    assert.equal(perm.rows[0].module, 'organization');
    const role = await admin.query(`SELECT id FROM roles WHERE tenant_id = 1 AND name = 'Employee'`);
    const key = [1, role.rows[0].id, perm.rows[0].id];
    await admin.query(`INSERT INTO role_permissions (tenant_id, role_id, permission_id) VALUES ($1, $2, $3)`, key);
    try {
      expectStatus(await call('GET', '/organization/chart', tokens.rahul), 200);
      // The chart does not open the wider employee records.
      expectStatus(await call('GET', `/employees/${emp.Vikram}`, tokens.rahul), 403);
    } finally {
      await admin.query(`DELETE FROM role_permissions WHERE tenant_id = $1 AND role_id = $2 AND permission_id = $3`, key);
    }
  });

  test('rejects malformed filters', async () => {
    expectStatus(await call('GET', '/organization/chart?status=bogus', tokens.suresh), 422, 'VALIDATION_FAILED');
    expectStatus(await call('GET', '/organization/chart?departmentId=abc', tokens.suresh), 422);
    expectStatus(await call('GET', '/organization/chart?managerId=-1', tokens.suresh), 422);
  });
});

describe('hierarchy from the seeded reporting lines', () => {
  test('nested structure, multiple direct reports, unassigned employees', async () => {
    const c = await chart();
    assert.deepEqual(names(c.roots), ['Vikram']);
    const vikram = c.roots[0];
    assert.deepEqual(names(vikram.children), ['Anita', 'Suresh']);
    assert.equal(vikram.directReportCount, 2);
    assert.equal(vikram.totalReportCount, 5);
    const krishna = find(c, 'Krishna');
    assert.deepEqual(names(krishna.children), ['Priya', 'Rahul']);
    assert.equal(krishna.manager.name, 'Suresh');
    assert.deepEqual(names(c.unassigned), ['Asha'], 'no manager and no reports');
    assert.equal(c.summary.employees, 7);
    assert.match(c.asOf, /^\d{4}-\d{2}-\d{2}$/);
  });

  test('cards carry display data; personal details never leave the API', async () => {
    await admin.query(
      `UPDATE employees SET date_of_birth = '1990-05-05', personal_email = 'private-mail@home.test', mobile_phone = '+91 90000 12345',
              address_line1 = '7 Secret Street', emergency_contact_name = 'Secret Contact' WHERE tenant_id = 1 AND id = $1`, [emp.Rahul]);
    const c = await chart();
    const rahul = find(c, 'Rahul');
    assert.equal(rahul.employeeCode, 'E501');
    assert.equal(rahul.jobTitle, 'Software Engineer');
    assert.equal(rahul.department.name, 'Engineering');
    assert.equal(rahul.photoUrl, null);
    const raw = JSON.stringify(c);
    for (const secret of ['private-mail@home.test', '90000 12345', 'Secret Street', 'Secret Contact', '1990-05-05',
      'dateOfBirth', 'personalEmail', 'mobilePhone', 'emergencyContact', 'workEmail']) {
      assert.ok(!raw.includes(secret), `leaked ${secret}`);
    }
  });
});

describe('filters', () => {
  test('department: matching people, with the manager between them as context', async () => {
    const c = await chart(`?departmentId=${deptEng}`);
    assert.equal(c.summary.employees, 4);
    assert.ok(find(c, 'Suresh'), 'HR manager connects Krishna to Vikram');
    assert.equal(find(c, 'Suresh').matched, false);
    assert.equal(find(c, 'Krishna').matched, true);
    assert.equal(find(c, 'Anita'), undefined);
    assert.deepEqual(c.unassigned, []);
    const hr = await chart(`?departmentId=${deptHr}`);
    assert.deepEqual(names(hr.unassigned), ['Asha']);
  });

  test('manager: the branch of that manager only', async () => {
    const c = await chart(`?managerId=${emp.Suresh}`);
    assert.deepEqual(names(c.roots), ['Suresh']);
    assert.deepEqual(names(everyone(c)).sort(), ['Krishna', 'Priya', 'Rahul', 'Suresh']);
    assert.deepEqual(c.unassigned, []);
  });

  test('search: name, employee number and job title', async () => {
    assert.ok(find(await chart('?search=priya'), 'Priya').matched);
    assert.ok(find(await chart('?search=E201'), 'Krishna').matched);
    const byTitle = await chart(`?search=${encodeURIComponent('hr exec')}`);
    assert.equal(byTitle.summary.employees, 1);
    assert.ok(find(byTitle, 'Anita').matched);
    assert.equal((await chart('?search=nobody-here')).summary.employees, 0);
  });

  test('filter options work for people without employee.view', async () => {
    const c = await chart(`?departmentId=${deptHr}`);
    assert.deepEqual(c.filterOptions.departments.map((d: any) => d.name), ['Engineering', 'Human Resources']);
    assert.deepEqual(c.filterOptions.managers.map((m: any) => m.name), ['Krishna', 'Suresh', 'Vikram']);
  });
});

describe('reporting rules, through the real employee API', () => {
  test('an employee cannot report to themselves', async () => {
    const r = await call('PATCH', `/employees/${emp.Rahul}`, tokens.suresh, { managerId: emp.Rahul });
    expectStatus(r, 422, 'VALIDATION_FAILED');
    assert.ok(r.json.error.details.fieldErrors.managerId);
  });

  test('a manager cannot report to someone in their own team', async () => {
    const r = await call('PATCH', `/employees/${emp.Vikram}`, tokens.suresh, { managerId: emp.Rahul });
    expectStatus(r, 409, 'INVARIANT_VIOLATION');
    assert.match(r.json.error.message, /reporting cycle/);
    assert.deepEqual(names((await chart()).roots), ['Vikram'], 'nothing changed');
  });

  test('changing a reporting manager moves the employee on the next read', async () => {
    expectStatus(await call('PATCH', `/employees/${emp.Priya}`, tokens.suresh, { managerId: emp.Anita }), 200);
    const c = await chart();
    assert.deepEqual(names(find(c, 'Anita').children), ['Priya']);
    assert.deepEqual(names(find(c, 'Krishna').children), ['Rahul']);
    assert.equal(everyone(c).filter((n) => n.fullName === 'Priya').length, 1, 'no duplicate after the move');
    assert.equal(find(c, 'Krishna').directReportCount, 1);

    expectStatus(await call('PATCH', `/employees/${emp.Priya}`, tokens.suresh, { managerId: emp.Krishna }), 200);
    assert.deepEqual(names(find(await chart(), 'Krishna').children), ['Priya', 'Rahul']);
  });

  test('removing a manager sends the employee to Unassigned', async () => {
    const quick = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Lone Worker', workEmail: 'lone@abc.test', dateOfJoining: isoDay(-10), managerId: emp.Anita,
    });
    expectStatus(quick, 201);
    assert.equal(find(await chart(), 'Lone Worker').manager.name, 'Anita');
    expectStatus(await call('PATCH', `/employees/${quick.json.employee.id}`, tokens.suresh, { managerId: null }), 200);
    const c = await chart();
    assert.ok(names(c.unassigned).includes('Lone Worker'));
    assert.equal(find(c, 'Lone Worker').manager, null);
  });

  test('several independent structures are several roots', async () => {
    const boss = await call('POST', '/employees', tokens.suresh, { fullName: 'Second Founder', workEmail: 'founder2@abc.test', dateOfJoining: isoDay(-5) });
    expectStatus(boss, 201);
    expectStatus(await call('POST', '/employees', tokens.suresh, {
      fullName: 'Founder Report', workEmail: 'report@abc.test', dateOfJoining: isoDay(-5), managerId: boss.json.employee.id,
    }), 201);
    const c = await chart();
    assert.deepEqual(names(c.roots), ['Second Founder', 'Vikram']);
    assert.equal(c.summary.roots, 2);
  });
});

describe('effective dating', () => {
  test('a line that has ended no longer places the employee', async () => {
    const e = await call('POST', '/employees', tokens.suresh, { fullName: 'Past Line', workEmail: 'past@abc.test', dateOfJoining: isoDay(-400) });
    await admin.query(
      `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from, effective_to) VALUES (1, $1, $2, $3, $4)`,
      [e.json.employee.id, emp.Krishna, isoDay(-400), isoDay(-30)]);
    const c = await chart();
    assert.ok(names(c.unassigned).includes('Past Line'));
    assert.ok(!names(find(c, 'Krishna').children).includes('Past Line'));
  });

  test('a line that has not started is not in the chart yet, but is announced', async () => {
    const joining = isoDay(30);
    const e = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Future Joiner', workEmail: 'future@abc.test', dateOfJoining: joining, managerId: emp.Krishna,
    });
    expectStatus(e, 201);
    const c = await chart();
    const f = find(c, 'Future Joiner');
    assert.ok(names(c.unassigned).includes('Future Joiner'));
    assert.equal(f.manager, null);
    assert.deepEqual(f.upcomingManager, { id: emp.Krishna, name: 'Krishna', effectiveFrom: joining });
    assert.ok(!names(find(c, 'Krishna').children).includes('Future Joiner'));
  });

  test('a future line cannot close a cycle (it could before migration 010)', async () => {
    const f = find(await chart(), 'Future Joiner');
    // Future Joiner -> Krishna starts in 30 days; Krishna -> Future Joiner from today would overlap it.
    const r = await call('PATCH', `/employees/${emp.Krishna}`, tokens.suresh, { managerId: f.id });
    expectStatus(r, 409, 'INVARIANT_VIOLATION');
    assert.equal(find(await chart(), 'Krishna').manager.name, 'Suresh');
  });

  test('lines that never overlap in time are not a cycle', async () => {
    const a = await call('POST', '/employees', tokens.suresh, { fullName: 'Swap A', workEmail: 'swapa@abc.test', dateOfJoining: '2020-01-01' });
    const b = await call('POST', '/employees', tokens.suresh, { fullName: 'Swap B', workEmail: 'swapb@abc.test', dateOfJoining: '2020-01-01' });
    const insert = (employee: number, manager: number, from: string, to: string | null) => admin.query(
      `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from, effective_to) VALUES (1, $1, $2, $3, $4)`,
      [employee, manager, from, to]);
    await insert(a.json.employee.id, b.json.employee.id, '2021-01-01', '2021-12-31');
    await insert(b.json.employee.id, a.json.employee.id, '2022-01-01', null); // A used to report to B; now B reports to A
    const c = await chart();
    assert.deepEqual(names(find(c, 'Swap A').children), ['Swap B']);
    assert.equal(find(c, 'Swap A').manager, null);
  });
});

describe('exited employees', () => {
  let exitedId = 0;

  test('hidden by default; their team is flagged instead of disappearing', async () => {
    const add = (fullName: string, workEmail: string, managerId?: number) => call('POST', '/employees', tokens.suresh, {
      fullName, workEmail, dateOfJoining: isoDay(-20), managerId,
    });
    const manager = await add('Leaving Manager', 'leaving@abc.test', emp.Anita);
    exitedId = manager.json.employee.id;
    const lead = await add('Orphan Lead', 'orphanlead@abc.test', exitedId);
    await add('Orphan Report', 'orphanreport@abc.test', lead.json.employee.id);
    await add('Orphan Solo', 'orphansolo@abc.test', exitedId);

    expectStatus(await call('PATCH', `/employees/${exitedId}`, tokens.suresh, { status: 'exited' }), 200);

    const c = await chart();
    assert.equal(find(c, 'Leaving Manager'), undefined);
    assert.ok(names(c.roots).includes('Orphan Lead'), 'still leads a team, so still a root');
    assert.equal(find(c, 'Orphan Lead').issue, 'manager_exited');
    assert.deepEqual(names(find(c, 'Orphan Lead').children), ['Orphan Report']);
    assert.ok(names(c.unassigned).includes('Orphan Solo'));
    assert.equal(find(c, 'Orphan Solo').issue, 'manager_exited');
    assert.equal(find(c, 'Orphan Solo').manager.name, 'Leaving Manager');
    assert.equal(c.summary.issues.managerExited, 2);
    assert.ok(!c.filterOptions.managers.some((m: any) => m.id === exitedId));
  });

  test('status filters reveal them on request', async () => {
    const exited = await chart('?status=exited');
    assert.equal(find(exited, 'Leaving Manager').matched, true);
    assert.equal(find(exited, 'Anita').matched, false, 'managers above are context only');
    assert.equal(find(exited, 'Rahul'), undefined);

    const all = await chart('?status=all');
    assert.deepEqual(names(find(all, 'Leaving Manager').children), ['Orphan Lead', 'Orphan Solo']);
    assert.equal(find(all, 'Orphan Lead').issue, null);
  });

  test('status=active hides people on notice, who stay visible as context for their team', async () => {
    expectStatus(await call('PATCH', `/employees/${emp.Krishna}`, tokens.suresh, { status: 'on_notice' }), 200);
    try {
      assert.equal(find(await chart(), 'Krishna').matched, true, 'on notice is still current staff');
      const active = await chart('?status=active');
      assert.equal(find(active, 'Krishna').matched, false);
      assert.equal(find(active, 'Rahul').matched, true);
      assert.equal((await chart('?status=on_notice')).summary.employees, 1);
    } finally {
      await call('PATCH', `/employees/${emp.Krishna}`, tokens.suresh, { status: 'active' });
    }
  });
});

describe('cycles already in the data', () => {
  test('are shown once, flagged, and can be corrected through the normal API', async () => {
    const a = await call('POST', '/employees', tokens.suresh, { fullName: 'Cycle A', workEmail: 'cyclea@abc.test', dateOfJoining: '2023-01-01' });
    const b = await call('POST', '/employees', tokens.suresh, { fullName: 'Cycle B', workEmail: 'cycleb@abc.test', dateOfJoining: '2023-01-01' });
    const [ida, idb] = [a.json.employee.id, b.json.employee.id];
    await admin.query(`ALTER TABLE employee_reporting DISABLE TRIGGER trg_reporting_no_cycle`);
    try {
      await admin.query(
        `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from)
         VALUES (1, $1, $2, '2023-01-01'), (1, $2, $1, '2023-01-01')`,
        [ida, idb]);
    } finally {
      await admin.query(`ALTER TABLE employee_reporting ENABLE TRIGGER trg_reporting_no_cycle`);
    }

    const c = await chart();
    const inChart = everyone(c);
    assert.equal(inChart.filter((n) => n.fullName === 'Cycle A').length, 1);
    assert.equal(inChart.filter((n) => n.fullName === 'Cycle B').length, 1);
    assert.equal(find(c, 'Cycle A').issue, 'cycle');
    assert.deepEqual(names(find(c, 'Cycle A').children), ['Cycle B']);
    assert.equal(c.summary.issues.cycle, 1);

    expectStatus(await call('PATCH', `/employees/${idb}`, tokens.suresh, { managerId: null }), 200);
    const fixed = await chart();
    assert.equal(find(fixed, 'Cycle B').manager, null);
    assert.equal(find(fixed, 'Cycle A').manager.name, 'Cycle B');
    assert.equal(fixed.summary.issues.cycle, 0);
  });
});

describe('tenant isolation', () => {
  test('each tenant sees only its own hierarchy', async () => {
    const xyz = await chart('', tokens.meera);
    assert.deepEqual(names(everyone(xyz)).sort(), ['Arjun', 'Meera']);
    assert.deepEqual(names(xyz.roots), ['Meera']);
    assert.deepEqual(xyz.filterOptions.departments, []);
    const abc = await chart('', tokens.asha);
    assert.equal(find(abc, 'Meera'), undefined);
    assert.equal(find(abc, 'Arjun'), undefined);
  });

  test('another tenant’s ids give an empty result, not their data', async () => {
    const byManager = await chart(`?managerId=${emp.Vikram}`, tokens.meera);
    assert.deepEqual(byManager.roots, []);
    assert.equal(byManager.summary.employees, 0);
    const byDept = await chart(`?departmentId=${deptEng}`, tokens.meera);
    assert.equal(byDept.summary.employees, 0);
    assert.ok(!JSON.stringify(byManager).includes('Vikram'));
  });

  test('a tenant id in the query string is ignored', async () => {
    for (const q of ['?tenant_id=1', '?tenantId=1']) {
      assert.deepEqual(names(everyone(await chart(q, tokens.meera))).sort(), ['Arjun', 'Meera']);
    }
  });

  test('RLS is what enforces it: the app role sees nothing without a tenant context', async () => {
    const rows = await pool.query(`SELECT count(*)::int AS n FROM employee_reporting`);
    assert.equal(rows.rows[0].n, 0);
  });
});

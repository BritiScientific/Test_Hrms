/**
 * Work Schedule Configuration over HTTP against the real database:
 * employee types (and the employee form link), shifts, work types, rotations
 * and shift schedules — RBAC, validation, dependents, concurrency, audit, RLS.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import pg from 'pg';

import { createApp } from '../src/app';
import { pool, withTenantTx } from '../src/config/db';

const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const PASSWORD = 'Passw0rd!';
const T1 = 1;
const T2 = 2;
let server: Server;
let base = '';
const tokens: Record<string, string> = {};

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
const auditRows = async (entityType: string, entityId: number) =>
  (await admin.query(
    `SELECT action, before_state, after_state, actor_user_id FROM work_schedule_audit_log
      WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY id`,
    [T1, entityType, entityId])).rows;

const workWeek = (start = '09:00', end = '18:00', minimum = 480) =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => (d <= 5
    ? { dayOfWeek: d, isWorkingDay: true, startTime: start, endTime: end, minimumWorkingMinutes: minimum }
    : { dayOfWeek: d, isWorkingDay: false }));

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens.suresh = await login('suresh@abc.test');   // HR Admin: holds leave.configuration.manage -> all workschedule.*
  tokens.krishna = await login('krishna@abc.test'); // manager: no workschedule.*, no employee.*
  tokens.rahul = await login('rahul@abc.test');     // employee
  tokens.meera = await login('meera@xyz.test');     // tenant 2 admin
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.end();
});

const state: Record<string, any> = {};

// ------------------------------------------------------------------- RBAC ---
describe('RBAC', () => {
  const RESOURCES = ['employee-types', 'shifts', 'work-types', 'rotating-shifts', 'rotating-work-types', 'shift-schedules'];

  test('HR Admin can list every resource; managers and employees get 403', async () => {
    for (const r of RESOURCES) {
      expectStatus(await call('GET', `/work-schedule/${r}`, tokens.suresh), 200);
      expectStatus(await call('GET', `/work-schedule/${r}`, tokens.krishna), 403, 'MISSING_PERMISSION');
      expectStatus(await call('GET', `/work-schedule/${r}`, tokens.rahul), 403, 'MISSING_PERMISSION');
    }
  });

  test('managers and employees hold no workschedule.* permission', async () => {
    const r = await admin.query(
      `SELECT count(*)::int n FROM role_permissions rp
         JOIN roles ro ON ro.tenant_id = rp.tenant_id AND ro.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ro.name IN ('Manager', 'Employee') AND p.code LIKE 'workschedule.%'`);
    assert.equal(r.rows[0].n, 0);
  });

  test('a view-only role cannot write', async () => {
    // Give the Manager role shift.view only, then try to create.
    await admin.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       SELECT $1, r.id, p.id FROM roles r, permissions p
        WHERE r.tenant_id = $1 AND r.name = 'Manager' AND p.code = 'workschedule.shift.view'`, [T1]);
    expectStatus(await call('GET', '/work-schedule/shifts', tokens.krishna), 200);
    expectStatus(await call('POST', '/work-schedule/shifts', tokens.krishna, { name: 'Sneaky' }), 403, 'MISSING_PERMISSION');
    await admin.query(
      `DELETE FROM role_permissions rp USING roles r, permissions p
        WHERE rp.tenant_id = $1 AND r.tenant_id = rp.tenant_id AND r.id = rp.role_id AND r.name = 'Manager'
          AND p.id = rp.permission_id AND p.code = 'workschedule.shift.view'`, [T1]);
  });

  test('there is no DELETE route', async () => {
    const list = await call('GET', '/work-schedule/shifts', tokens.suresh);
    const id = list.json.items[0].id;
    expectStatus(await call('DELETE', `/work-schedule/shifts/${id}`, tokens.suresh), 404, 'ROUTE_NOT_FOUND');
  });

  test('unauthenticated requests get 401', async () => {
    expectStatus(await call('GET', '/work-schedule/shifts'), 401);
  });
});

// --------------------------------------------------------- employee types ---
describe('Employee types', () => {
  test('every tenant starts with the four defaults, each with a base category', async () => {
    const r = await call('GET', '/work-schedule/employee-types?sort=name', tokens.suresh);
    expectStatus(r, 200);
    const byName = Object.fromEntries(r.json.items.map((t: any) => [t.name, t.baseCategory]));
    assert.deepEqual(byName, { Contract: 'contract', 'Full-Time': 'full_time', Intern: 'intern', 'Part-Time': 'part_time' });
    assert.ok(r.json.items.find((t: any) => t.name === 'Full-Time').employeeCount > 0);
  });

  test('create, then a case-insensitive duplicate is NAME_TAKEN', async () => {
    const r = await call('POST', '/work-schedule/employee-types', tokens.suresh,
      { name: 'Consultant', baseCategory: 'contract', description: 'External consultants' });
    expectStatus(r, 201);
    assert.equal(r.json.isActive, true);
    state.consultant = r.json;
    const dup = await call('POST', '/work-schedule/employee-types', tokens.suresh, { name: 'consultant', baseCategory: 'intern' });
    expectStatus(dup, 409, 'NAME_TAKEN');
    assert.ok(dup.json.error.details.fieldErrors.name);
  });

  test('the same name is fine in another tenant', async () => {
    expectStatus(await call('POST', '/work-schedule/employee-types', tokens.meera, { name: 'Consultant', baseCategory: 'contract' }), 201);
  });

  test('an invalid base category is rejected', async () => {
    expectStatus(await call('POST', '/work-schedule/employee-types', tokens.suresh, { name: 'Odd', baseCategory: 'freelance' }), 422, 'VALIDATION_FAILED');
  });

  test('a type held by active employees cannot be deactivated, and the blockers are listed', async () => {
    const fullTime = (await call('GET', '/work-schedule/employee-types?search=Full', tokens.suresh)).json.items[0];
    const r = await call('PATCH', `/work-schedule/employee-types/${fullTime.id}/status`, tokens.suresh,
      { isActive: false, updatedAt: fullTime.updatedAt });
    expectStatus(r, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.ok(r.json.error.details.total > 0);
    assert.ok(r.json.error.details.items.length <= 20);
    assert.equal(r.json.error.details.items[0].type, 'employee');
  });

  test('a stale updatedAt is rejected with STALE_VERSION', async () => {
    const r = await call('PATCH', `/work-schedule/employee-types/${state.consultant.id}`, tokens.suresh,
      { description: 'x', updatedAt: '2000-01-01T00:00:00.000Z' });
    expectStatus(r, 409, 'STALE_VERSION');
  });

  test('an edit writes one audit row with only the changed field', async () => {
    const r = await call('PATCH', `/work-schedule/employee-types/${state.consultant.id}`, tokens.suresh,
      { description: 'Consultants on retainer', updatedAt: state.consultant.updatedAt });
    expectStatus(r, 200);
    state.consultant = r.json;
    const rows = await auditRows('employee_type', state.consultant.id);
    assert.deepEqual(rows.map((x) => x.action), ['created', 'updated']);
    assert.deepEqual(rows[1].before_state, { description: 'External consultants' });
    assert.deepEqual(rows[1].after_state, { description: 'Consultants on retainer' });
  });

  test('an unchanged edit writes nothing and keeps updatedAt', async () => {
    const r = await call('PATCH', `/work-schedule/employee-types/${state.consultant.id}`, tokens.suresh,
      { description: 'Consultants on retainer', updatedAt: state.consultant.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.updatedAt, state.consultant.updatedAt);
    assert.equal((await auditRows('employee_type', state.consultant.id)).length, 2);
  });
});

// ------------------------------------------------ employee form integration ---
describe('Employee form integration', () => {
  test('the dropdown lookup lists active types only, behind employee.create/update', async () => {
    const r = await call('GET', '/employees/lookups/employee-types', tokens.suresh);
    expectStatus(r, 200);
    assert.ok(r.json.some((t: any) => t.name === 'Consultant' && t.baseCategory === 'contract'));
    expectStatus(await call('GET', '/employees/lookups/employee-types', tokens.krishna), 403);
  });

  test('quick add with a type stores it and sets employment_type from its base category', async () => {
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Kavya Rao', workEmail: 'kavya@abc.test', dateOfJoining: '2026-01-05', employeeTypeId: state.consultant.id,
    });
    expectStatus(r, 201);
    assert.equal(r.json.employee.employeeTypeId, state.consultant.id);
    assert.equal(r.json.employee.employeeTypeName, 'Consultant');
    assert.equal(r.json.employee.employmentType, 'contract');
    state.kavya = r.json.employee;
  });

  test('an old client sending only employmentType still works and maps to the default type', async () => {
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Old Client', workEmail: 'oldclient@abc.test', dateOfJoining: '2026-01-05', employmentType: 'intern',
    });
    expectStatus(r, 201);
    assert.equal(r.json.employee.employmentType, 'intern');
    assert.equal(r.json.employee.employeeTypeName, 'Intern');
  });

  test('changing the type updates employment_type and is audited with before and after', async () => {
    const partTime = (await call('GET', '/employees/lookups/employee-types', tokens.suresh)).json.find((t: any) => t.name === 'Part-Time');
    const r = await call('PATCH', `/employees/${state.kavya.id}`, tokens.suresh, { employeeTypeId: partTime.id, version: state.kavya.version });
    expectStatus(r, 200);
    assert.equal(r.json.employmentType, 'part_time');
    assert.equal(r.json.employeeTypeName, 'Part-Time');
    const a = await admin.query(
      `SELECT before_state, after_state FROM employee_audit_log WHERE employee_id = $1 AND action = 'employee.update' ORDER BY id DESC LIMIT 1`,
      [state.kavya.id]);
    assert.equal(a.rows[0].before_state.employeeType, 'Consultant');
    assert.equal(a.rows[0].after_state.employeeType, 'Part-Time');
    assert.equal(a.rows[0].before_state.employmentType, 'contract');
    assert.equal(a.rows[0].after_state.employmentType, 'part_time');
    state.kavya = r.json;
  });

  test('employment_type always equals base_category for every employee', async () => {
    const r = await admin.query(
      `SELECT count(*)::int n FROM employees e JOIN employee_types et ON et.tenant_id = e.tenant_id AND et.id = e.employee_type_id
        WHERE et.base_category <> e.employment_type`);
    assert.equal(r.rows[0].n, 0);
  });

  test('an unused type can be deactivated; it then leaves the dropdown and is rejected on create', async () => {
    const t = (await call('POST', '/work-schedule/employee-types', tokens.suresh, { name: 'Seasonal', baseCategory: 'part_time' })).json;
    const off = await call('PATCH', `/work-schedule/employee-types/${t.id}/status`, tokens.suresh, { isActive: false, updatedAt: t.updatedAt });
    expectStatus(off, 200);
    assert.equal(off.json.isActive, false);
    const lookup = (await call('GET', '/employees/lookups/employee-types', tokens.suresh)).json;
    assert.ok(!lookup.some((x: any) => x.id === t.id));
    const r = await call('POST', '/employees', tokens.suresh, {
      fullName: 'Late Joiner', workEmail: 'late@abc.test', dateOfJoining: '2026-01-05', employeeTypeId: t.id,
    });
    expectStatus(r, 422, 'VALIDATION_FAILED');
    assert.ok(r.json.error.details.fieldErrors.employeeTypeId);
    // Still readable, for history.
    expectStatus(await call('GET', `/work-schedule/employee-types/${t.id}`, tokens.suresh), 200);
    // Repeating the same state is a 200 with no audit row.
    const before = (await auditRows('employee_type', t.id)).length;
    expectStatus(await call('PATCH', `/work-schedule/employee-types/${t.id}/status`, tokens.suresh, { isActive: false, updatedAt: off.json.updatedAt }), 200);
    assert.equal((await auditRows('employee_type', t.id)).length, before);
  });

  test('a type employees hold cannot change base category', async () => {
    const t = (await call('GET', `/work-schedule/employee-types/${state.consultant.id}`, tokens.suresh)).json;
    // Kavya moved off Consultant, so put someone on it first.
    await call('POST', '/employees', tokens.suresh, {
      fullName: 'Holder', workEmail: 'holder@abc.test', dateOfJoining: '2026-01-05', employeeTypeId: t.id,
    });
    const r = await call('PATCH', `/work-schedule/employee-types/${t.id}`, tokens.suresh, { baseCategory: 'intern', updatedAt: t.updatedAt });
    expectStatus(r, 409, 'BASE_CATEGORY_IN_USE');
  });
});

// ------------------------------------------------------ shifts, work types ---
describe('Shifts and work types', () => {
  test('grace time -1 and 241 are rejected', async () => {
    expectStatus(await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Bad', graceTimeMinutes: -1 }), 422, 'VALIDATION_FAILED');
    expectStatus(await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Bad', graceTimeMinutes: 241 }), 422, 'VALIDATION_FAILED');
  });

  test('create two shifts and two work types', async () => {
    const a = await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Early', graceTimeMinutes: 5 });
    const b = await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Late', graceTimeMinutes: 5 });
    expectStatus(a, 201); expectStatus(b, 201);
    state.early = a.json; state.late = b.json;
    const w1 = await call('POST', '/work-schedule/work-types', tokens.suresh, { name: 'Field Work' });
    const w2 = await call('POST', '/work-schedule/work-types', tokens.suresh, { name: 'Desk Work' });
    expectStatus(w1, 201); expectStatus(w2, 201);
    state.field = w1.json; state.desk = w2.json;
  });

  test('"Night Shift" and "night shift" collide in one tenant', async () => {
    expectStatus(await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'night shift' }), 409, 'NAME_TAKEN');
  });

  test('search, status filter and pagination', async () => {
    const r = await call('GET', '/work-schedule/shifts?search=ear&status=active&limit=1&page=1', tokens.suresh);
    expectStatus(r, 200);
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].name, 'Early');
    assert.equal(r.json.limit, 1);
    expectStatus(await call('GET', '/work-schedule/shifts?limit=101', tokens.suresh), 422);
  });

  test('another tenant\'s shift is NOT_FOUND, for reads and writes', async () => {
    expectStatus(await call('GET', `/work-schedule/shifts/${state.early.id}`, tokens.meera), 404, 'NOT_FOUND');
    expectStatus(await call('PATCH', `/work-schedule/shifts/${state.early.id}`, tokens.meera,
      { name: 'Hijack', updatedAt: state.early.updatedAt }), 404, 'NOT_FOUND');
  });

  test('two simultaneous edits: one wins, the other gets STALE_VERSION', async () => {
    const [a, b] = await Promise.all([
      call('PATCH', `/work-schedule/shifts/${state.late.id}`, tokens.suresh, { graceTimeMinutes: 10, updatedAt: state.late.updatedAt }),
      call('PATCH', `/work-schedule/shifts/${state.late.id}`, tokens.suresh, { graceTimeMinutes: 20, updatedAt: state.late.updatedAt }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal([a, b].find((x) => x.status === 409)!.json.error.code, 'STALE_VERSION');
    state.late = (await call('GET', `/work-schedule/shifts/${state.late.id}`, tokens.suresh)).json;
  });
});

// --------------------------------------------------------------- rotations ---
describe('Rotations', () => {
  test('1 entry and duplicate entries are rejected', async () => {
    expectStatus(await call('POST', '/work-schedule/rotating-shifts', tokens.suresh, { name: 'R', items: [state.early.id] }), 422, 'VALIDATION_FAILED');
    expectStatus(await call('POST', '/work-schedule/rotating-shifts', tokens.suresh,
      { name: 'R', items: [state.early.id, state.early.id] }), 422, 'VALIDATION_FAILED');
  });

  test('order is preserved and renumbered 1..n', async () => {
    const r = await call('POST', '/work-schedule/rotating-shifts', tokens.suresh,
      { name: 'Early / Late', rotationInterval: 2, rotationUnit: 'weeks', items: [state.late.id, state.early.id] });
    expectStatus(r, 201);
    assert.deepEqual(r.json.items.map((i: any) => [i.name, i.sequenceOrder]), [['Late', 1], ['Early', 2]]);
    assert.equal(r.json.sequenceSummary, 'Late > Early');
    state.rotation = r.json;
  });

  test('editing replaces the entries atomically and moves updatedAt', async () => {
    const r = await call('PATCH', `/work-schedule/rotating-shifts/${state.rotation.id}`, tokens.suresh,
      { items: [state.early.id, state.late.id], updatedAt: state.rotation.updatedAt });
    expectStatus(r, 200);
    assert.deepEqual(r.json.items.map((i: any) => i.name), ['Early', 'Late']);
    assert.notEqual(r.json.updatedAt, state.rotation.updatedAt);
    const rows = await admin.query(`SELECT count(*)::int n FROM rotating_shift_pattern_items WHERE pattern_id = $1`, [state.rotation.id]);
    assert.equal(rows.rows[0].n, 2);
    state.rotation = r.json;
  });

  test('a shift in an active rotation cannot be deactivated; the rotation is listed', async () => {
    const r = await call('PATCH', `/work-schedule/shifts/${state.early.id}/status`, tokens.suresh,
      { isActive: false, updatedAt: state.early.updatedAt });
    expectStatus(r, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.ok(r.json.error.details.items.some((x: any) => x.type === 'rotating_shift' && x.id === state.rotation.id));
  });

  test('an inactive shift cannot be used in a rotation', async () => {
    const s = (await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Retired' })).json;
    const off = (await call('PATCH', `/work-schedule/shifts/${s.id}/status`, tokens.suresh, { isActive: false, updatedAt: s.updatedAt })).json;
    assert.equal(off.isActive, false);
    expectStatus(await call('POST', '/work-schedule/rotating-shifts', tokens.suresh,
      { name: 'Uses retired', items: [state.early.id, s.id] }), 422, 'INACTIVE_REFERENCE');
    state.retired = off;
  });

  test('rotating work types: same rules; a work type in use cannot be deactivated', async () => {
    const r = await call('POST', '/work-schedule/rotating-work-types', tokens.suresh,
      { name: 'Field / Desk', items: [state.field.id, state.desk.id] });
    expectStatus(r, 201);
    const blocked = await call('PATCH', `/work-schedule/work-types/${state.field.id}/status`, tokens.suresh,
      { isActive: false, updatedAt: state.field.updatedAt });
    expectStatus(blocked, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.equal(blocked.json.error.details.items[0].type, 'rotating_work_type');
  });
});

// --------------------------------------------------------- shift schedules ---
describe('Shift schedules', () => {
  test('all 7 days are saved; a 22:00-06:00 day is flagged overnight with 480 minutes', async () => {
    const days = workWeek();
    days[0] = { dayOfWeek: 1, isWorkingDay: true, startTime: '22:00', endTime: '06:00', minimumWorkingMinutes: 480 };
    const r = await call('POST', '/work-schedule/shift-schedules', tokens.suresh,
      { name: 'Early Week', shiftId: state.early.id, defaultMinimumWorkingMinutes: 480, automaticCheckoutEnabled: true, days });
    expectStatus(r, 201);
    assert.equal(r.json.days.length, 7);
    assert.equal(r.json.days[0].isNightShift, true);
    assert.equal(r.json.days[0].spanMinutes, 480);
    assert.equal(r.json.days[1].isNightShift, false);
    assert.equal(r.json.workingDaysSummary, 'Mon-Fri');
    assert.equal(r.json.automaticCheckoutEnabled, true);
    assert.deepEqual(r.json.warnings, []);
    state.schedule = r.json;
  });

  test('a day off with times is rejected', async () => {
    const days = workWeek();
    days[5] = { dayOfWeek: 6, isWorkingDay: false, startTime: '09:00', endTime: '13:00' } as any;
    expectStatus(await call('POST', '/work-schedule/shift-schedules', tokens.suresh, { name: 'X1', shiftId: state.early.id, days }), 422, 'VALIDATION_FAILED');
  });

  test('a working day without times is rejected', async () => {
    const days = workWeek();
    days[0] = { dayOfWeek: 1, isWorkingDay: true } as any;
    const r = await call('POST', '/work-schedule/shift-schedules', tokens.suresh, { name: 'X2', shiftId: state.early.id, days });
    expectStatus(r, 422, 'VALIDATION_FAILED');
    assert.ok(r.json.error.details.fieldErrors['days.0.startTime']);
  });

  test('09:00-18:00 with a 9h30 minimum is rejected; equal start and end is rejected', async () => {
    expectStatus(await call('POST', '/work-schedule/shift-schedules', tokens.suresh,
      { name: 'X3', shiftId: state.early.id, days: workWeek('09:00', '18:00', 570) }), 422, 'VALIDATION_FAILED');
    expectStatus(await call('POST', '/work-schedule/shift-schedules', tokens.suresh,
      { name: 'X4', shiftId: state.early.id, days: workWeek('09:00', '09:00', 0) }), 422, 'VALIDATION_FAILED');
  });

  test('a failed save leaves no parent and no partial days', async () => {
    const n = await admin.query(`SELECT count(*)::int n FROM work_shift_schedules WHERE name LIKE 'X%'`);
    assert.equal(n.rows[0].n, 0);
  });

  test('a working day on the organization weekly off returns a warning, not an error', async () => {
    const days = workWeek();
    days[5] = { dayOfWeek: 6, isWorkingDay: true, startTime: '09:00', endTime: '13:00', minimumWorkingMinutes: 240 };
    const r = await call('POST', '/work-schedule/shift-schedules', tokens.suresh, { name: 'Six Day Week', shiftId: state.early.id, days });
    expectStatus(r, 201);
    assert.equal(r.json.warnings.length, 1);
    assert.match(r.json.warnings[0], /Saturday/);
  });

  test('a schedule cannot use an inactive shift', async () => {
    expectStatus(await call('POST', '/work-schedule/shift-schedules', tokens.suresh,
      { name: 'On retired', shiftId: state.retired.id, days: workWeek() }), 422, 'INACTIVE_REFERENCE');
  });

  test('a shift with an active schedule cannot be deactivated', async () => {
    const late = (await call('GET', `/work-schedule/shifts/${state.late.id}`, tokens.suresh)).json;
    // Late is also in the rotation; Early has a schedule. Check Early's blockers include the schedule.
    const early = (await call('GET', `/work-schedule/shifts/${state.early.id}`, tokens.suresh)).json;
    const r = await call('PATCH', `/work-schedule/shifts/${early.id}/status`, tokens.suresh, { isActive: false, updatedAt: early.updatedAt });
    expectStatus(r, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.ok(r.json.error.details.items.some((x: any) => x.type === 'shift_schedule'));
    assert.ok(late.usage.activeRotations >= 1);
  });

  test('deactivate-shift racing create-schedule never leaves an active schedule on an inactive shift', async () => {
    for (let i = 0; i < 6; i++) {
      const s = (await call('POST', '/work-schedule/shifts', tokens.suresh, { name: `Race ${i}` })).json;
      const [off, sched] = await Promise.all([
        call('PATCH', `/work-schedule/shifts/${s.id}/status`, tokens.suresh, { isActive: false, updatedAt: s.updatedAt }),
        call('POST', '/work-schedule/shift-schedules', tokens.suresh, { name: `Race schedule ${i}`, shiftId: s.id, days: workWeek() }),
      ]);
      // Exactly one side wins.
      assert.ok((off.status === 200) !== (sched.status === 201), `round ${i}: ${off.status} / ${sched.status}`);
    }
    const bad = await admin.query(
      `SELECT count(*)::int n FROM work_shift_schedules ws JOIN work_shifts s ON s.tenant_id = ws.tenant_id AND s.id = ws.shift_id
        WHERE ws.is_active AND NOT s.is_active`);
    assert.equal(bad.rows[0].n, 0);
  });

  test('editing days writes an audit diff that holds only the days', async () => {
    const days = workWeek('08:00', '17:00', 480);
    const r = await call('PATCH', `/work-schedule/shift-schedules/${state.schedule.id}`, tokens.suresh,
      { days, updatedAt: state.schedule.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.days[0].startTime, '08:00');
    const rows = await auditRows('shift_schedule', state.schedule.id);
    assert.deepEqual(rows.map((x) => x.action), ['created', 'updated']);
    assert.deepEqual(Object.keys(rows[1].after_state), ['days']);
  });
});

// ---------------------------------------------------------- isolation, audit ---
describe('Database isolation and audit', () => {
  test('RLS: tenant 2 sees none of tenant 1\'s rows, and no context sees nothing', async () => {
    for (const t of ['employee_types', 'work_shifts', 'work_types', 'rotating_shift_patterns',
      'rotating_shift_pattern_items', 'work_shift_schedules', 'work_shift_schedule_days', 'work_schedule_audit_log']) {
      const seen = await withTenantTx(T2, async (tx) => (await tx.query(`SELECT DISTINCT tenant_id FROM ${t}`)).rows);
      assert.ok(seen.every((x) => Number(x.tenant_id) === T2), `${t} leaked`);
      const client = await pool.connect();
      try {
        assert.equal((await client.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0, `${t} without context`);
      } finally { client.release(); }
    }
  });

  test('every create, update and status change has an audit row with the actor', async () => {
    const suresh = (await admin.query(`SELECT id FROM users WHERE email = 'suresh@abc.test'`)).rows[0].id;
    const rows = await admin.query(
      `SELECT DISTINCT actor_user_id FROM work_schedule_audit_log WHERE tenant_id = $1`, [T1]);
    assert.deepEqual(rows.rows.map((r) => Number(r.actor_user_id)), [Number(suresh)]);
    const kinds = await admin.query(`SELECT DISTINCT action FROM work_schedule_audit_log WHERE tenant_id = $1 ORDER BY 1`, [T1]);
    assert.deepEqual(kinds.rows.map((r) => r.action), ['created', 'deactivated', 'updated']);
  });

  test('the audit feed shows work schedule events to HR', async () => {
    const r = await call('GET', '/audit-events?category=work_schedule&limit=5', tokens.suresh);
    expectStatus(r, 200);
    assert.ok(r.json.items.length > 0);
    assert.match(r.json.items[0].action, /^(employee_type|shift|work_type|rotating_shift|rotating_work_type|shift_schedule)\./);
  });
});

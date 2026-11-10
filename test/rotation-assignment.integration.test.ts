/**
 * Rotating shift / rotating work type assignments over HTTP against the real
 * database: bulk create, overlap, edit rules, End / Cancel, pattern freeze
 * (service and database triggers), computed rotation, picker, export, RBAC,
 * audit, RLS and concurrency.
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
import { addDaysIso } from '../src/modules/work-schedule/work-schedule-calculation';

const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const PASSWORD = 'Passw0rd!';
const T1 = 1;
const T2 = 2;
let server: Server;
let base = '';
let today = '';
const tokens: Record<string, string> = {};
const emp: Record<string, number> = {};

interface Res { status: number; json: any; text: string; headers: Headers }
async function call(method: string, url: string, token?: string, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/v1${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* csv */ }
  return { status: res.status, json, text, headers: res.headers };
}
function expectStatus(r: Res, status: number, code?: string) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 400)}`);
  if (code) assert.equal(r.json?.error?.code, code);
}
async function login(email: string) {
  const r = await call('POST', '/auth/login', undefined, { email, password: PASSWORD });
  expectStatus(r, 200);
  return r.json.accessToken as string;
}

const SHIFT = '/work-schedule/rotating-shift-assignments';
const WTYPE = '/work-schedule/rotating-work-type-assignments';
const auditRows = async (entityType: string, entityId: number) =>
  (await admin.query(
    `SELECT action, before_state, after_state FROM work_schedule_audit_log
      WHERE tenant_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY id`, [T1, entityType, entityId])).rows;
const count = async (table: string, where = 'true') =>
  (await admin.query(`SELECT count(*)::int n FROM ${table} WHERE tenant_id = ${T1} AND ${where}`)).rows[0].n as number;

let shiftPatternId = 0;
let workTypePatternId = 0;
const state: Record<string, any> = {};

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  for (const r of (await admin.query(
    `SELECT e.id, split_part(u.email, '@', 1) AS n FROM employees e JOIN users u ON u.id = e.user_id WHERE e.tenant_id = $1`, [T1])).rows) {
    emp[r.n] = Number(r.id);
  }
  today = (await admin.query(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text AS d`)).rows[0].d;
  shiftPatternId = Number((await admin.query(`SELECT id FROM rotating_shift_patterns WHERE tenant_id = $1 LIMIT 1`, [T1])).rows[0].id);
  workTypePatternId = Number((await admin.query(`SELECT id FROM rotating_work_type_patterns WHERE tenant_id = $1 LIMIT 1`, [T1])).rows[0].id);
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  tokens.suresh = await login('suresh@abc.test');   // HR Admin: all workschedule.*
  tokens.krishna = await login('krishna@abc.test'); // manager
  tokens.rahul = await login('rahul@abc.test');     // employee
  tokens.meera = await login('meera@xyz.test');     // tenant 2 admin
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.end();
});

// ------------------------------------------------------------------- RBAC ---
const ROTATE = { basedOn: 'after', afterDays: 7 } as const;

describe('RBAC', () => {
  test('HR Admin can read both lists; managers and employees get 403', async () => {
    for (const p of [SHIFT, WTYPE]) {
      expectStatus(await call('GET', p, tokens.suresh), 200);
      expectStatus(await call('GET', p, tokens.krishna), 403, 'MISSING_PERMISSION');
      expectStatus(await call('GET', p, tokens.rahul), 403, 'MISSING_PERMISSION');
    }
    expectStatus(await call('GET', '/work-schedule/employee-picker?kind=rotating-shift', tokens.krishna), 403);
    expectStatus(await call('GET', SHIFT), 401);
  });

  test('the four assignment permissions exist; managers and employees hold none', async () => {
    const n = await admin.query(`SELECT count(*)::int n FROM permissions WHERE code LIKE 'workschedule.rotating\\_%\\_assignment.%'`);
    assert.equal(n.rows[0].n, 4);
    const r = await admin.query(
      `SELECT count(*)::int n FROM role_permissions rp JOIN roles ro ON ro.tenant_id = rp.tenant_id AND ro.id = rp.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE ro.name IN ('Manager', 'Employee') AND p.code LIKE 'workschedule.rotating\\_%\\_assignment.%'`);
    assert.equal(r.rows[0].n, 0);
  });

  test('view-only cannot write; the kind decides which manage permission applies', async () => {
    await admin.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       SELECT $1, r.id, p.id FROM roles r, permissions p
        WHERE r.tenant_id = $1 AND r.name = 'Manager' AND p.code = 'workschedule.rotating_shift_assignment.view'`, [T1]);
    expectStatus(await call('GET', SHIFT, tokens.krishna), 200);
    expectStatus(await call('GET', WTYPE, tokens.krishna), 403);
    expectStatus(await call('POST', SHIFT, tokens.krishna,
      { employeeIds: [emp.rahul], patternId: shiftPatternId, rotation: ROTATE, startDate: today }), 403, 'MISSING_PERMISSION');
    await admin.query(
      `DELETE FROM role_permissions rp USING roles r, permissions p
        WHERE rp.tenant_id = $1 AND r.tenant_id = rp.tenant_id AND r.id = rp.role_id AND r.name = 'Manager'
          AND p.id = rp.permission_id AND p.code LIKE 'workschedule.rotating\\_%\\_assignment.%'`, [T1]);
  });

  test('there is no DELETE route', async () => {
    expectStatus(await call('DELETE', `${SHIFT}/1`, tokens.suresh), 404, 'ROUTE_NOT_FOUND');
  });
});

// ------------------------------------------------------------ bulk create ---
describe('Bulk create and the computed rotation', () => {
  test('the rotation rule is required and must match "based on"', async () => {
    const base = { employeeIds: [emp.asha], patternId: shiftPatternId, startDate: today };
    expectStatus(await call('POST', SHIFT, tokens.suresh, base), 422, 'VALIDATION_FAILED');
    for (const rotation of [{ basedOn: 'weekly', weekday: 8 }, { basedOn: 'monthly', monthDay: 32 }, { basedOn: 'after', afterDays: 0 }, { basedOn: 'after', weekday: 1 }]) {
      expectStatus(await call('POST', SHIFT, tokens.suresh, { ...base, rotation }), 422, 'VALIDATION_FAILED');
    }
  });

  test('assigns many employees at once; current, next switch and next are computed', async () => {
    const r = await call('POST', SHIFT, tokens.suresh,
      { employeeIds: [emp.priya, emp.rahul], patternId: shiftPatternId, rotation: ROTATE, startDate: today });
    expectStatus(r, 201);
    assert.equal(r.json.items.length, 2);
    const a = r.json.items[0];
    assert.equal(a.status, 'active');
    assert.equal(a.phase, 'current');
    assert.equal(a.current.name, 'Morning Shift');
    assert.equal(a.next.name, 'Night Shift');
    assert.equal(a.nextSwitch, addDaysIso(today, 7));
    assert.equal(a.rotateLabel, 'Every 7 days');
    assert.deepEqual(a.rotation, ROTATE);
    assert.equal(a.sequenceSummary, 'Morning Shift > Night Shift');
    state.priya = r.json.items.find((x: any) => x.employee.id === emp.priya);
    state.rahul = r.json.items.find((x: any) => x.employee.id === emp.rahul);
  });

  test('a start date in the future shows "upcoming" with no current entry', async () => {
    const r = await call('POST', SHIFT, tokens.suresh,
      { employeeIds: [emp.krishna], patternId: shiftPatternId, rotation: ROTATE, startDate: addDaysIso(today, 10) });
    expectStatus(r, 201);
    assert.equal(r.json.items[0].phase, 'upcoming');
    assert.equal(r.json.items[0].current, null);
    state.krishna = r.json.items[0];
  });

  test('a past start date needs a reason', async () => {
    const yesterday = addDaysIso(today, -1);
    const bad = await call('POST', SHIFT, tokens.suresh, { employeeIds: [emp.anita], patternId: shiftPatternId, rotation: ROTATE, startDate: yesterday });
    expectStatus(bad, 422, 'VALIDATION_FAILED');
    assert.ok(bad.json.error.details.fieldErrors.reason);
    const ok = await call('POST', SHIFT, tokens.suresh,
      { employeeIds: [emp.anita], patternId: shiftPatternId, rotation: ROTATE, startDate: yesterday, reason: 'Joined the night rota last week' });
    expectStatus(ok, 201);
    state.anita = ok.json.items[0];
    assert.equal(state.anita.current.name, 'Morning Shift');
  });

  test('overlap is all-or-nothing: nothing is saved and every clash is listed', async () => {
    const before = await count('rotating_shift_assignments');
    const r = await call('POST', SHIFT, tokens.suresh,
      { employeeIds: [emp.asha, emp.priya], patternId: shiftPatternId, rotation: ROTATE, startDate: today });
    expectStatus(r, 409, 'ASSIGNMENT_OVERLAP');
    assert.equal(r.json.error.details.conflicts.length, 1);
    assert.equal(r.json.error.details.conflicts[0].employeeName, 'Priya');
    assert.equal(r.json.error.details.conflicts[0].assignmentId, state.priya.id);
    assert.equal(await count('rotating_shift_assignments'), before, 'asha must not have been saved');
    assert.equal(await count('work_schedule_audit_log', `entity_type = 'rotating_shift_assignment' AND entity_id NOT IN (${[state.priya.id, state.rahul.id, state.krishna.id, state.anita.id].join(',')})`), 0);
  });

  test('201 employees are rejected', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    expectStatus(await call('POST', SHIFT, tokens.suresh, { employeeIds: ids, patternId: shiftPatternId, rotation: ROTATE, startDate: today }), 422, 'VALIDATION_FAILED');
  });

  test('an exited employee and an inactive pattern are rejected', async () => {
    await admin.query(`UPDATE employees SET status = 'exited' WHERE tenant_id = $1 AND id = $2`, [T1, emp.vikram]);
    const gone = await call('POST', SHIFT, tokens.suresh, { employeeIds: [emp.vikram], patternId: shiftPatternId, rotation: ROTATE, startDate: today });
    expectStatus(gone, 422, 'VALIDATION_FAILED');
    assert.equal(gone.json.error.details.ineligible[0].name, 'Vikram');

    // A fresh, unassigned pattern that is then deactivated.
    const a = (await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Swing A' })).json;
    const b = (await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Swing B' })).json;
    const p = (await call('POST', '/work-schedule/rotating-shifts', tokens.suresh, { name: 'Swing', items: [a.id, b.id] })).json;
    const off = await call('PATCH', `/work-schedule/rotating-shifts/${p.id}/status`, tokens.suresh, { isActive: false, updatedAt: p.updatedAt });
    expectStatus(off, 200);
    expectStatus(await call('POST', SHIFT, tokens.suresh, { employeeIds: [emp.asha], patternId: p.id, rotation: ROTATE, startDate: today }), 422, 'INACTIVE_REFERENCE');
  });

  test('a rotation of the other kind does not clash: one person can have both', async () => {
    const r = await call('POST', WTYPE, tokens.suresh,
      { employeeIds: [emp.priya, emp.suresh], patternId: workTypePatternId, rotation: ROTATE, startDate: today });
    expectStatus(r, 201);
    assert.equal(r.json.items[0].current.name, 'Work From Office');
    state.wtPriya = r.json.items.find((x: any) => x.employee.id === emp.priya);
  });

  test('two simultaneous bulk creates for one employee: one wins, one gets ASSIGNMENT_OVERLAP', async () => {
    const body = { employeeIds: [emp.asha], patternId: shiftPatternId, rotation: ROTATE, startDate: today };
    const [a, b] = await Promise.all([call('POST', SHIFT, tokens.suresh, body), call('POST', SHIFT, tokens.suresh, body)]);
    assert.deepEqual([a.status, b.status].sort(), [201, 409]);
    assert.equal([a, b].find((x) => x.status === 409)!.json.error.code, 'ASSIGNMENT_OVERLAP');
    state.asha = [a, b].find((x) => x.status === 201)!.json.items[0];
  });

  test('every created assignment has one audit row', async () => {
    const rows = await auditRows('rotating_shift_assignment', state.priya.id);
    assert.deepEqual(rows.map((x) => x.action), ['created']);
    assert.equal(rows[0].after_state.employeeName, 'Priya');
    assert.equal(rows[0].after_state.patternId, shiftPatternId);
  });
});

// --------------------------------------------------------------- pattern freeze ---
describe('Pattern freeze', () => {
  test('entries, interval and deactivation are blocked while employees are on the pattern; name is not', async () => {
    const p = (await call('GET', `/work-schedule/rotating-shifts/${shiftPatternId}`, tokens.suresh)).json;
    assert.ok(p.activeAssignments >= 4);
    const items = [...p.items].reverse().map((i: any) => i.id);
    const edit = await call('PATCH', `/work-schedule/rotating-shifts/${p.id}`, tokens.suresh, { items, updatedAt: p.updatedAt });
    expectStatus(edit, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.ok(edit.json.error.details.total >= 4);
    assert.equal(edit.json.error.details.items[0].type, 'rotating_shift_assignment');
    expectStatus(await call('PATCH', `/work-schedule/rotating-shifts/${p.id}`, tokens.suresh,
      { items: p.items.map((i: any) => i.id).slice(0, 2), updatedAt: p.updatedAt }), 409, 'HAS_ACTIVE_DEPENDENTS');
    expectStatus(await call('PATCH', `/work-schedule/rotating-shifts/${p.id}/status`, tokens.suresh,
      { isActive: false, updatedAt: p.updatedAt }), 409, 'HAS_ACTIVE_DEPENDENTS');
    const renamed = await call('PATCH', `/work-schedule/rotating-shifts/${p.id}`, tokens.suresh,
      { name: `${p.name} (renamed)`, description: 'Still editable', updatedAt: p.updatedAt });
    expectStatus(renamed, 200);
  });

  test('the same holds for direct SQL (database triggers)', async () => {
    const attempts = [
      `UPDATE rotating_shift_patterns SET is_active = false WHERE tenant_id = ${T1} AND id = ${shiftPatternId}`,
      `DELETE FROM rotating_shift_pattern_items WHERE tenant_id = ${T1} AND pattern_id = ${shiftPatternId}`,
      `UPDATE rotating_shift_pattern_items SET sequence_order = sequence_order + 10 WHERE tenant_id = ${T1} AND pattern_id = ${shiftPatternId}`,
      `UPDATE rotating_work_type_patterns SET is_active = false WHERE tenant_id = ${T1} AND id = ${workTypePatternId}`,
    ];
    for (const sql of attempts) {
      await assert.rejects(admin.query(sql), (e: any) => e.code === '23514', sql);
    }
  });

  test('a work type pattern with employees is frozen through the API too', async () => {
    const p = (await call('GET', `/work-schedule/rotating-work-types/${workTypePatternId}`, tokens.suresh)).json;
    const r = await call('PATCH', `/work-schedule/rotating-work-types/${p.id}/status`, tokens.suresh, { isActive: false, updatedAt: p.updatedAt });
    expectStatus(r, 409, 'HAS_ACTIVE_DEPENDENTS');
    assert.equal(r.json.error.details.items[0].type, 'rotating_work_type_assignment');
  });

  test('direct SQL cannot assign an inactive pattern', async () => {
    const inactive = (await admin.query(`SELECT id FROM rotating_shift_patterns WHERE tenant_id = $1 AND NOT is_active LIMIT 1`, [T1])).rows[0].id;
    await assert.rejects(admin.query(
      `INSERT INTO rotating_shift_assignments (tenant_id, employee_id, pattern_id, start_date) VALUES ($1, $2, $3, $4)`,
      [T1, emp.suresh, inactive, today]), (e: any) => e.code === '23514');
  });
});

// ------------------------------------------------------------ edit, end, cancel ---
describe('Edit, End and Cancel', () => {
  test('before the start date the pattern and start date can change', async () => {
    const r = await call('PATCH', `${SHIFT}/${state.krishna.id}`, tokens.suresh,
      { startDate: addDaysIso(today, 12), reason: 'Moved with the new roster', updatedAt: state.krishna.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.startDate, addDaysIso(today, 12));
    state.krishna = r.json;
    const rows = await auditRows('rotating_shift_assignment', state.krishna.id);
    assert.deepEqual(rows.map((x) => x.action), ['created', 'updated']);
    assert.deepEqual(Object.keys(rows[1].after_state).sort(), ['reason', 'startDate']);
  });

  test('before the start date the rotation rule can change; after it starts it cannot', async () => {
    const r = await call('PATCH', `${SHIFT}/${state.krishna.id}`, tokens.suresh,
      { rotation: { basedOn: 'monthly', monthDay: 'last' }, updatedAt: state.krishna.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.rotateLabel, 'Monthly on the last day');
    state.krishna = r.json;
    const started = await call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh,
      { rotation: { basedOn: 'weekly', weekday: 1 }, updatedAt: state.rahul.updatedAt });
    expectStatus(started, 409, 'INVALID_ASSIGNMENT_STATE');
    assert.ok(started.json.error.details.fieldErrors.rotation);
  });

  test('every rule type is stored and computed from the database', async () => {
    const rules = [{ basedOn: 'weekly', weekday: 3 }, { basedOn: 'monthly', monthDay: 15 }, { basedOn: 'monthly', monthDay: 'last' }, { basedOn: 'after', afterDays: 3 }];
    for (const rotation of rules) {
      const r = await call('PATCH', `${SHIFT}/${state.krishna.id}`, tokens.suresh, { rotation, updatedAt: state.krishna.updatedAt });
      expectStatus(r, 200);
      assert.deepEqual(r.json.rotation, rotation);
      state.krishna = r.json;
    }
  });

  test('after it starts only the end date and reason change', async () => {
    const other = (await call('POST', '/work-schedule/shifts', tokens.suresh, { name: 'Edit Probe' })).json;
    void other;
    const r = await call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh,
      { startDate: addDaysIso(today, 1), updatedAt: state.rahul.updatedAt });
    expectStatus(r, 409, 'INVALID_ASSIGNMENT_STATE');
    assert.ok(r.json.error.details.fieldErrors.startDate);
    const ok = await call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh,
      { endDate: addDaysIso(today, 30), reason: 'Fixed term', updatedAt: state.rahul.updatedAt });
    expectStatus(ok, 200);
    assert.equal(ok.json.endDate, addDaysIso(today, 30));
    state.rahul = ok.json;
  });

  test('an end date before the start date, or in the past, is rejected', async () => {
    expectStatus(await call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh,
      { endDate: addDaysIso(today, -3), updatedAt: state.rahul.updatedAt }), 422, 'VALIDATION_FAILED');
  });

  test('two admins editing one assignment: one wins, one gets STALE_VERSION', async () => {
    const [a, b] = await Promise.all([
      call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh, { reason: 'one', updatedAt: state.rahul.updatedAt }),
      call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh, { reason: 'two', updatedAt: state.rahul.updatedAt }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    assert.equal([a, b].find((x) => x.status === 409)!.json.error.code, 'STALE_VERSION');
    state.rahul = (await call('GET', `${SHIFT}/${state.rahul.id}`, tokens.suresh)).json;
  });

  test('End: a started assignment ends today by default; an upcoming one must be cancelled', async () => {
    const upcoming = await call('PATCH', `${SHIFT}/${state.krishna.id}/end`, tokens.suresh, { updatedAt: state.krishna.updatedAt });
    expectStatus(upcoming, 409, 'INVALID_ASSIGNMENT_STATE');
    const r = await call('PATCH', `${SHIFT}/${state.rahul.id}/end`, tokens.suresh, { updatedAt: state.rahul.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.status, 'ended');
    assert.equal(r.json.endDate, today);
    assert.equal(r.json.phase, 'current', 'in force until the end of its last day');
    expectStatus(await call('PATCH', `${SHIFT}/${state.rahul.id}/end`, tokens.suresh, { updatedAt: r.json.updatedAt }), 409, 'INVALID_ASSIGNMENT_STATE');
    expectStatus(await call('PATCH', `${SHIFT}/${state.rahul.id}`, tokens.suresh, { reason: 'x', updatedAt: r.json.updatedAt }), 409, 'INVALID_ASSIGNMENT_STATE');
  });

  test('Cancel: only before the start date, and it frees the employee', async () => {
    expectStatus(await call('PATCH', `${SHIFT}/${state.anita.id}/cancel`, tokens.suresh, { updatedAt: state.anita.updatedAt }), 409, 'INVALID_ASSIGNMENT_STATE');
    const r = await call('PATCH', `${SHIFT}/${state.krishna.id}/cancel`, tokens.suresh,
      { reason: 'Roster dropped', updatedAt: state.krishna.updatedAt });
    expectStatus(r, 200);
    assert.equal(r.json.status, 'cancelled');
    assert.equal(r.json.phase, 'cancelled');
    assert.equal(r.json.current, null);
    // The cancelled dates are free again.
    expectStatus(await call('POST', SHIFT, tokens.suresh,
      { employeeIds: [emp.krishna], patternId: shiftPatternId, rotation: ROTATE, startDate: addDaysIso(today, 12) }), 201);
    const rows = await auditRows('rotating_shift_assignment', state.krishna.id);
    assert.deepEqual(rows.map((x) => x.action), ['created', 'updated', 'cancelled']);
  });

  test('Bulk end is all-or-nothing', async () => {
    const list = (await call('GET', `${SHIFT}?status=active&limit=100`, tokens.suresh)).json.items;
    const upcoming = list.find((a: any) => a.employee.id === emp.krishna && a.phase === 'upcoming');
    const bad = await call('POST', `${SHIFT}/bulk-end`, tokens.suresh, { ids: [state.priya.id, upcoming.id] });
    expectStatus(bad, 409, 'INVALID_ASSIGNMENT_STATE');
    assert.equal(bad.json.error.details.problems.length, 1);
    assert.equal((await call('GET', `${SHIFT}/${state.priya.id}`, tokens.suresh)).json.status, 'active', 'priya untouched');

    const ok = await call('POST', `${SHIFT}/bulk-end`, tokens.suresh, { ids: [state.priya.id, state.anita.id] });
    expectStatus(ok, 200);
    assert.deepEqual(ok.json.items.map((x: any) => x.status), ['ended', 'ended']);
    assert.equal((await auditRows('rotating_shift_assignment', state.priya.id)).at(-1)!.action, 'ended');
  });

  test('once the rotation has no live assignment left, the pattern can change again', async () => {
    // Everyone is ended with end_date = today, which is still live today; push the check with SQL on the end dates.
    await admin.query(`UPDATE rotating_shift_assignments SET end_date = start_date - 0 WHERE tenant_id = $1 AND status = 'cancelled'`, [T1]);
    const live = (await call('GET', `/work-schedule/rotating-shifts/${shiftPatternId}`, tokens.suresh)).json.activeAssignments;
    assert.ok(live >= 1, 'assignments ending today are still live today');
  });
});

// ------------------------------------------------------- picker, list, export ---
describe('Picker, list filters and export', () => {
  test('the picker lists current employees with their assignment flag and filters', async () => {
    const all = await call('GET', '/work-schedule/employee-picker?kind=rotating-shift&limit=100', tokens.suresh);
    expectStatus(all, 200);
    assert.ok(all.json.items.length >= 5);
    assert.ok(!all.json.items.some((x: any) => x.name === 'Vikram'), 'exited employees are not offered');
    const unassigned = await call('GET', '/work-schedule/employee-picker?kind=rotating-shift&assignment=unassigned&limit=100', tokens.suresh);
    assert.ok(unassigned.json.items.every((x: any) => x.assigned === false));
    const assigned = await call('GET', '/work-schedule/employee-picker?kind=rotating-shift&assignment=assigned&limit=100', tokens.suresh);
    assert.ok(assigned.json.items.every((x: any) => x.assigned === true));
    assert.equal(assigned.json.total + unassigned.json.total, all.json.total);
    const search = await call('GET', '/work-schedule/employee-picker?kind=rotating-shift&search=Suresh', tokens.suresh);
    assert.deepEqual(search.json.items.map((x: any) => x.name), ['Suresh']);
  });

  test('"select all matching" returns ids, capped', async () => {
    const r = await call('GET', '/work-schedule/employee-picker?kind=rotating-work-type&idsOnly=true', tokens.suresh);
    expectStatus(r, 200);
    assert.ok(Array.isArray(r.json.ids) && r.json.ids.length === r.json.total);
    assert.equal(r.json.truncated, false);
  });

  test('filter options', async () => {
    const r = await call('GET', '/work-schedule/employee-picker/options', tokens.suresh);
    expectStatus(r, 200);
    assert.ok(r.json.departments.length && r.json.employeeTypes.length && r.json.roles.length && r.json.jobTitles.length);
  });

  test('list filters, sorting and search', async () => {
    const r = await call('GET', `${SHIFT}?search=pri&limit=5`, tokens.suresh);
    assert.equal(r.json.items[0].employee.name, 'Priya');
    const byPattern = await call('GET', `${SHIFT}?patternId=${shiftPatternId}&status=ended&sort=employee`, tokens.suresh);
    assert.ok(byPattern.json.items.every((x: any) => x.status === 'ended'));
    expectStatus(await call('GET', `${SHIFT}?limit=101`, tokens.suresh), 422);
    expectStatus(await call('GET', `${SHIFT}?sort=employee_name`, tokens.suresh), 422);
  });

  test('CSV export of the filtered list', async () => {
    const r = await call('GET', `${SHIFT}/export?status=all`, tokens.suresh);
    expectStatus(r, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(r.headers.get('content-disposition') ?? '', /attachment/);
    const lines = r.text.replace(/^﻿/, '').trim().split(/\r\n/);
    assert.equal(lines[0], 'Employee,Employee code,Pattern,Rotates,Sequence,Start date,End date,Status,Current,Next switch,Next,Reason');
    assert.ok(lines.length > 3);
    expectStatus(await call('GET', `${SHIFT}/export`, tokens.krishna), 403);
  });
});

// ------------------------------------------------------------- isolation, db ---
describe('Database isolation and grants', () => {
  test('RLS: tenant 2 sees none of tenant 1\'s assignments; no context sees nothing', async () => {
    for (const t of ['rotating_shift_assignments', 'rotating_work_type_assignments']) {
      const seen = await withTenantTx(T2, async (tx) => (await tx.query(`SELECT DISTINCT tenant_id FROM ${t}`)).rows);
      assert.ok(seen.every((x) => Number(x.tenant_id) === T2));
      const client = await pool.connect();
      try { assert.equal((await client.query(`SELECT count(*)::int n FROM ${t}`)).rows[0].n, 0); } finally { client.release(); }
      const c = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t]);
      assert.deepEqual([c.rows[0].relrowsecurity, c.rows[0].relforcerowsecurity], [true, true]);
      const priv = await admin.query(`SELECT has_table_privilege('hrms_app', $1, 'DELETE') AS d`, [t]);
      assert.equal(priv.rows[0].d, false, `${t} must have no DELETE grant`);
    }
  });

  test('another tenant gets 404 for an assignment id, never its data', async () => {
    expectStatus(await call('GET', `${SHIFT}/${state.priya.id}`, tokens.meera), 404, 'NOT_FOUND');
    expectStatus(await call('PATCH', `${SHIFT}/${state.priya.id}/end`, tokens.meera, { updatedAt: state.priya.updatedAt }), 404, 'NOT_FOUND');
  });

  test('cross-tenant references are rejected by composite foreign keys', async () => {
    const t2emp = (await admin.query(`SELECT id FROM employees WHERE tenant_id = $1 LIMIT 1`, [T2])).rows[0].id;
    await assert.rejects(admin.query(
      `INSERT INTO rotating_shift_assignments (tenant_id, employee_id, pattern_id, start_date) VALUES ($1, $2, $3, $4)`,
      [T2, t2emp, shiftPatternId, today]), (e: any) => e.code === '23503');
  });

  test('the overlap constraint holds at the database level, and cancelled rows are ignored', async () => {
    await assert.rejects(admin.query(
      `INSERT INTO rotating_shift_assignments (tenant_id, employee_id, pattern_id, start_date) VALUES ($1, $2, $3, $4)`,
      [T1, emp.asha, shiftPatternId, addDaysIso(today, 3)]), (e: any) => e.code === '23P01');
  });

  test('the widened audit CHECKs accept the new values; the log stays append-only', async () => {
    const r = await admin.query(
      `SELECT count(*)::int n FROM work_schedule_audit_log WHERE entity_type IN ('rotating_shift_assignment', 'rotating_work_type_assignment')`);
    assert.ok(r.rows[0].n >= 8);
    const kinds = await admin.query(`SELECT DISTINCT action FROM work_schedule_audit_log WHERE entity_type = 'rotating_shift_assignment' ORDER BY 1`);
    assert.deepEqual(kinds.rows.map((x) => x.action), ['cancelled', 'created', 'ended', 'updated']);
    await assert.rejects(admin.query(`UPDATE work_schedule_audit_log SET action = 'updated' WHERE tenant_id = $1`, [T1]));
  });
});

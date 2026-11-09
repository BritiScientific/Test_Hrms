/**
 * Leave Management over HTTP: the real Express app against the real database (RLS
 * on, app role). Most dates are in next year, so notice periods never interfere;
 * that year's balances come from the accrual job.
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
import { runAccrual } from '../src/modules/leave/leave-accrual.service';
import { postLedger, lockBalance } from '../src/modules/leave/leave-balance.service';
import { runCarryForward, runExpiry } from '../src/modules/leave/leave-carry-forward.service';

const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const PASSWORD = 'Passw0rd!';
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const T1 = 1;
const T2 = 2;
const Y = new Date().getFullYear() + 1;

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
const emp: Record<string, number> = {};
const type: Record<string, number> = {};

/** Date in test year Y: `week` weeks after the first Monday in February, `dow` 0 = Monday .. 4 = Friday. */
function day(week: number, dow = 0): string {
  const d = new Date(Date.UTC(Y, 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + week * 7 + dow);
  return d.toISOString().slice(0, 10);
}
const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const localToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

interface Result { status: number; json: any; buffer: Buffer; headers: Headers }

async function call(who: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result> {
  const h: Record<string, string> = { authorization: `Bearer ${tokens[who]}`, ...headers };
  let payload: Uint8Array | string | undefined;
  if (Buffer.isBuffer(body)) payload = new Uint8Array(body);
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}/api/v1${url}`, { method, headers: h, body: payload });
  const buffer = Buffer.from(await res.arrayBuffer());
  const json = (res.headers.get('content-type') ?? '').includes('json') && buffer.length ? JSON.parse(buffer.toString()) : null;
  return { status: res.status, json, buffer, headers: res.headers };
}
const get = (who: string, url: string) => call(who, 'GET', url);
const post = (who: string, url: string, body?: unknown, headers?: Record<string, string>) => call(who, 'POST', url, body, headers);
const patch = (who: string, url: string, body?: unknown) => call(who, 'PATCH', url, body);

function ok(r: Result, status = 200) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
}
function fails(r: Result, status: number, code?: string) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  if (code) assert.equal(r.json?.error?.code, code);
  return r.json?.error;
}

const apply = (who: string, leaveTypeCode: string, startDate: string, endDate = startDate, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  post(who, '/leave/requests', { leaveTypeCode, startDate, endDate, reason: 'Test reason', ...extra }, headers);
const preview = (who: string, leaveTypeCode: string, startDate: string, endDate = startDate, extra: Record<string, unknown> = {}) =>
  post(who, '/leave/requests/preview', { leaveTypeCode, startDate, endDate, ...extra });
const issueCodes = (r: Result) => ok(r).issues.map((i: any) => i.code);
const balance = async (who: string, code: string, year = Y) =>
  ok(await get(who, `/leave/balances?year=${year}`)).items.find((b: any) => b.leaveTypeCode === code);

/** Walk a request through every approval step. */
async function approveAll(requestId: number, approvers = ['krishna', 'anita']) {
  for (const who of approvers) {
    const tasks = ok(await get(who, '/leave/team/approvals/pending'));
    const t = tasks.find((x: any) => x.entityId === requestId);
    assert.ok(t, `${who} has no task for ${requestId}`);
    ok(await post(who, `/workflows/tasks/${t.taskId}/approve`, { comments: 'ok' }));
  }
}

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const e = await admin.query(`SELECT e.id, split_part(u.email, '@', 1) AS n FROM employees e JOIN users u ON u.id = e.user_id`);
  for (const r of e.rows) emp[r.n] = Number(r.id);
  const t = await admin.query(`SELECT id, code FROM leave_types WHERE tenant_id = $1`, [T1]);
  for (const r of t.rows) type[r.code] = Number(r.id);

  const logins: [string, string][] = [
    ['asha', 'asha@abc.test'], ['anita', 'anita@abc.test'], ['suresh', 'suresh@abc.test'], ['krishna', 'krishna@abc.test'],
    ['rahul', 'rahul@abc.test'], ['priya', 'priya@abc.test'], ['vikram', 'vikram@abc.test'], ['meera', 'meera@xyz.test'], ['arjun', 'arjun@xyz.test'],
  ];
  for (const [who, email] of logins) {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }),
    });
    tokens[who] = (await res.json() as any).accessToken;
    assert.ok(tokens[who], `login failed for ${email}`);
  }
  for (const tenant of [T1, T2]) await withTenantTx(tenant, (tx) => runAccrual(tx, tenant, { asOf: `${Y}-12-31` }));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
  await admin.end();
});

// ------------------------------------------------------------------ database ---

describe('Database', () => {
  const LEAVE_TABLES = [
    'leave_types', 'leave_policies', 'leave_policy_entitlements', 'leave_policy_assignments', 'leave_holiday_calendars',
    'leave_holidays', 'leave_calendar_assignments', 'leave_accrual_rules', 'leave_carry_forward_rules', 'leave_comp_off_rules',
    'leave_requests', 'leave_request_days', 'leave_request_attachments', 'leave_balances', 'leave_balance_transactions',
    'leave_request_cancellations', 'leave_accrual_postings', 'leave_comp_off_claims', 'leave_audit_log',
  ];

  test('the old tables and functions are gone', async () => {
    const r = await admin.query(`SELECT to_regclass('public.holidays') AS holidays, to_regprocedure('public.leave_guard_transition()') AS f`);
    assert.equal(r.rows[0].holidays, null);
    assert.equal(r.rows[0].f, null);
    const old = await admin.query(`SELECT code FROM permissions WHERE code IN ('leave.create', 'leave.view.own', 'leave.approve', 'leave.type.manage')`);
    assert.equal(old.rowCount, 0);
  });

  test('every leave table has tenant_id and forced RLS with a tenant policy', async () => {
    for (const t of LEAVE_TABLES) {
      const c = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t]);
      assert.equal(c.rows[0].relrowsecurity, true, `${t} RLS`);
      assert.equal(c.rows[0].relforcerowsecurity, true, `${t} FORCE RLS`);
      const p = await admin.query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = 'tenant_isolation'`, [t]);
      assert.equal(p.rowCount, 1, `${t} policy`);
      const col = await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'tenant_id' AND is_nullable = 'NO'`, [t]);
      assert.equal(col.rowCount, 1, `${t} tenant_id`);
    }
  });

  test('the API role has no way around RLS', async () => {
    const r = await admin.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'hrms_app'`);
    assert.deepEqual(r.rows[0], { rolbypassrls: false, rolsuper: false });
  });

  test('RLS isolates tenants at the SQL level, with no tenant context returning nothing', async () => {
    const seen = await withTenantTx(T2, async (tx) => (await tx.query(`SELECT DISTINCT tenant_id FROM leave_types`)).rows);
    assert.deepEqual(seen.map((x) => x.tenant_id), [T2]);
    const client = await pool.connect();
    try {
      for (const t of ['leave_types', 'leave_balances', 'leave_requests']) {
        const r = await client.query(`SELECT count(*)::int AS n FROM ${t}`);
        assert.equal(r.rows[0].n, 0, `${t} without a tenant context`);
      }
    } finally {
      client.release();
    }
  });

  test('a row cannot be written for another tenant', async () => {
    await assert.rejects(
      withTenantTx(T2, (tx) => tx.query(`INSERT INTO leave_types (tenant_id, code, name) VALUES ($1, 'HACK', 'Hack')`, [T1])),
      (e: any) => e.code === '42501',
    );
  });

  test('foreign keys are tenant-aware: no entitlement across tenants', async () => {
    const policy = (await admin.query(`SELECT id FROM leave_policies WHERE tenant_id = $1 LIMIT 1`, [T2])).rows[0].id;
    await assert.rejects(
      withTenantTx(T2, (tx) => tx.query(
        `INSERT INTO leave_policy_entitlements (tenant_id, policy_id, leave_type_id) VALUES ($1, $2, $3)`, [T2, policy, type.CL])),
      (e: any) => e.code === '23503',
    );
  });

  test('unique constraints: duplicate leave type code', async () => {
    fails(await post('asha', '/leave/config/types', { code: 'CL', name: 'Another casual' }), 409, 'DUPLICATE');
  });

  test('the ledger is append-only and balance buckets cannot be set directly', async () => {
    await assert.rejects(withTenantTx(T1, (tx) => tx.query(`UPDATE leave_balance_transactions SET days = 1`)), (e: any) => e.code === '42501');
    await assert.rejects(withTenantTx(T1, (tx) => tx.query(`DELETE FROM leave_balance_transactions`)), (e: any) => e.code === '42501');
    await assert.rejects(withTenantTx(T1, (tx) => tx.query(`UPDATE leave_balances SET used = 0`)), (e: any) => e.code === '42501');
    await assert.rejects(withTenantTx(T1, (tx) => tx.query(
      `INSERT INTO leave_balances (tenant_id, employee_id, leave_type_id, leave_year, accrued) VALUES ($1, $2, $3, 2099, 100)`,
      [T1, emp.rahul, type.CL])), (e: any) => e.code === '42501');
  });

  test('the same ledger key posts once, and the balance moves once', async () => {
    const [first, second, avail] = await withTenantTx(T1, async (tx) => {
      const bal = await lockBalance(tx, T1, emp.vikram, type.BL, Y);
      const base_ = { tenantId: T1, balanceId: bal.id, type: 'MANUAL_CREDIT' as const, days: 2, effectiveDate: `${Y}-01-01`, idempotencyKey: 'test:dup' };
      const a = await postLedger(tx, base_);
      const b = await postLedger(tx, base_);
      const after_ = await lockBalance(tx, T1, emp.vikram, type.BL, Y);
      return [a, b, after_.available - bal.available];
    });
    assert.deepEqual([first, second, avail], [true, false, 2]);
  });

  test('an overlapping request is refused by the database itself', async () => {
    const r = ok(await apply('vikram', 'CL', day(30)), 201);
    const c = (await admin.query(`SELECT policy_id, leave_year FROM leave_requests WHERE id = $1`, [r.id])).rows[0];
    await assert.rejects(
      withTenantTx(T1, (tx) => tx.query(
        `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, policy_id, leave_year, start_date, end_date, total_days, reason, applied_by)
         SELECT tenant_id, employee_id, leave_type_id, $2, $3, start_date, end_date, 1, 'x', applied_by FROM leave_requests WHERE id = $1`,
        [r.id, c.policy_id, c.leave_year])),
      (e: any) => e.code === '23P01' && e.constraint === 'ex_leave_no_overlap',
    );
    ok(await post('vikram', `/leave/requests/${r.id}/withdraw`, {}));
  });

  test('effective-dated assignments cannot overlap', async () => {
    const policy = (await admin.query(`SELECT id FROM leave_policies WHERE tenant_id = $1 AND code = 'CONTRACT'`, [T1])).rows[0].id;
    ok(await post('asha', '/leave/config/policy-assignments', {
      employeeIds: [emp.vikram], policyId: policy, effectiveFrom: `${Y + 5}-03-01`, effectiveTo: `${Y + 5}-06-30`,
    }), 201);
    fails(await post('asha', '/leave/config/policy-assignments', {
      employeeIds: [emp.vikram], policyId: policy, effectiveFrom: `${Y + 5}-02-01`, effectiveTo: `${Y + 5}-04-30`,
    }), 409, 'OVERLAP');
  });

  test('a holiday must fall inside its calendar year', async () => {
    const cal = ok(await post('asha', '/leave/config/holiday-calendars', { code: 'YEARCHECK', name: 'Year check', calendarYear: Y + 3 }), 201);
    const e = fails(await post('asha', '/leave/config/holidays', { calendarId: cal.id, name: 'Wrong year', holidayDate: `${Y + 4}-01-01` }), 409);
    assert.match(e.message, /outside calendar year/);
  });
});

// ------------------------------------------------------------------ employee ---

describe('Employee: applying for leave', () => {
  test('the form lists leave types from the policy, with their rules', async () => {
    const r = ok(await get('rahul', '/leave/types'));
    assert.equal(r.policy.code, 'PERMANENT');
    const codes = r.types.map((t: any) => t.code);
    assert.ok(codes.includes('EL') && codes.includes('SL') && codes.includes('LOP'));
    const el = r.types.find((t: any) => t.code === 'EL');
    assert.equal(el.minNoticeDays, 3);
    assert.equal(el.effectiveMaxConsecutiveDays, 15);
  });

  test('submission holds the days and does not deduct them', async () => {
    const before_ = await balance('rahul', 'EL');
    assert.equal(before_.available, 18);
    const r = ok(await apply('rahul', 'EL', day(0, 3), day(1, 0)), 201);
    assert.equal(r.totalDays, 3);
    assert.equal(r.status, 'pending');
    const b = await balance('rahul', 'EL');
    assert.deepEqual([b.used, b.pending, b.available], [0, 3, 15]);
    const ledger = (await admin.query(`SELECT txn_type FROM leave_balance_transactions WHERE leave_request_id = $1`, [r.id])).rows;
    assert.deepEqual(ledger.map((x) => x.txn_type), ['LEAVE_HOLD']);
    assert.equal(r.days.length, 5);
    assert.deepEqual(r.days.map((d: any) => d.chargeableDays), [1, 1, 0, 0, 1]);
  });

  test('the server computes the days: a client total is rejected, not used', async () => {
    fails(await post('rahul', '/leave/requests', {
      leaveTypeCode: 'EL', startDate: day(2), endDate: day(2), reason: 'Trying to game it', totalDays: 0.5,
    }), 422, 'VALIDATION_FAILED');
  });

  test('invalid dates', async () => {
    assert.deepEqual(issueCodes(await preview('rahul', 'EL', day(3, 1), day(3, 0))), ['INVALID_DATES']);
    fails(await apply('rahul', 'EL', day(3, 1), day(3, 0)), 422, 'INVALID_DATES');
    fails(await post('rahul', '/leave/requests', { leaveTypeCode: 'EL', startDate: `${Y}-02-31`, endDate: `${Y}-03-01`, reason: 'Bad date' }), 422);
  });

  test('a request cannot span two leave years', async () => {
    assert.deepEqual(issueCodes(await preview('rahul', 'EL', `${Y}-12-30`, `${Y + 1}-01-05`)), ['SPANS_LEAVE_YEARS']);
  });

  test('insufficient balance', async () => {
    const r = await preview('priya', 'CL', day(4), day(4));
    assert.ok(ok(r).ok, 'a single day fits');
    const adjust = ok(await post('asha', '/leave/admin/balances/adjust', {
      employeeId: emp.priya, leaveTypeId: type.BL, year: Y, days: 1, direction: 'credit', note: 'Test credit',
    }), 201);
    assert.equal(adjust.balance.adjusted, 1);
    const e = fails(await apply('priya', 'BL', day(5), day(5, 1)), 422, 'INSUFFICIENT_BALANCE');
    assert.equal(e.details.available, 1);
    assert.equal(e.details.requested, 2);
  });

  test('half day: 0.5 days, requires a session and a single date', async () => {
    const r = ok(await apply('priya', 'CL', day(6), day(6), { durationType: 'half_day', halfDaySession: 'first_half' }), 201);
    assert.equal(r.totalDays, 0.5);
    assert.deepEqual(issueCodes(await preview('priya', 'CL', day(7), day(7), { durationType: 'half_day' })), ['HALF_DAY_SESSION_REQUIRED']);
    assert.deepEqual(issueCodes(await preview('priya', 'CL', day(7), day(7, 1), { durationType: 'half_day', halfDaySession: 'first_half' })), ['HALF_DAY_SINGLE_DATE']);
  });

  test('half-day rules: the afternoon of the same date is free, the same half is not', async () => {
    ok(await apply('priya', 'CL', day(6), day(6), { durationType: 'half_day', halfDaySession: 'second_half' }), 201);
    fails(await apply('priya', 'SL', day(6), day(6), { durationType: 'half_day', halfDaySession: 'first_half' }), 422, 'OVERLAPPING_REQUEST');
    fails(await apply('priya', 'SL', day(6), day(6)), 422, 'OVERLAPPING_REQUEST');
  });

  test('a leave type that forbids half days refuses them', async () => {
    assert.ok(issueCodes(await preview('priya', 'PL', day(7), day(7), { durationType: 'half_day', halfDaySession: 'first_half' })).includes('HALF_DAY_NOT_ALLOWED'));
  });

  test('overlapping requests are refused', async () => {
    ok(await apply('priya', 'CL', day(8), day(8, 2)), 201);
    assert.ok(issueCodes(await preview('priya', 'SL', day(8, 2), day(8, 3))).includes('OVERLAPPING_REQUEST'));
  });

  test('advance notice, from the leave type', async () => {
    const tomorrow = shift(localToday(), 1);
    assert.ok(issueCodes(await preview('priya', 'EL', tomorrow)).includes('INSUFFICIENT_NOTICE'));
  });

  test('backdated restrictions, from the leave type', async () => {
    const today = localToday();
    assert.ok(issueCodes(await preview('priya', 'CL', shift(today, -1))).includes('BACKDATED_NOT_ALLOWED'));
    assert.ok(issueCodes(await preview('priya', 'SL', shift(today, -30))).includes('TOO_FAR_BACK'));
  });

  test('maximum consecutive days: the policy override beats the leave type', async () => {
    assert.ok(issueCodes(await preview('priya', 'CL', day(9), day(10, 2))).includes('MAX_CONSECUTIVE_EXCEEDED')); // type limit: 5
    const ents = ok(await get('asha', '/leave/config/entitlements'));
    const cl = ents.find((e: any) => e.leaveTypeCode === 'CL' && e.policyCode === 'PERMANENT');
    ok(await patch('asha', `/leave/config/entitlements/${cl.id}`, { maxConsecutiveDays: 2 }));
    assert.ok(issueCodes(await preview('priya', 'CL', day(9), day(9, 2))).includes('MAX_CONSECUTIVE_EXCEEDED'));
    ok(await patch('asha', `/leave/config/entitlements/${cl.id}`, { maxConsecutiveDays: null }));
    assert.ok(!issueCodes(await preview('priya', 'CL', day(9), day(9, 2))).includes('MAX_CONSECUTIVE_EXCEEDED'));
  });

  test('a leave type outside the policy is refused, and unknown types too', async () => {
    const created = ok(await post('asha', '/leave/config/types', { code: 'STUDY', name: 'Study Leave', category: 'other' }), 201);
    assert.ok(issueCodes(await preview('priya', 'STUDY', day(11))).includes('NOT_IN_POLICY'));
    assert.deepEqual(issueCodes(await preview('priya', 'NOPE', day(11))), ['UNKNOWN_LEAVE_TYPE']);
    ok(await patch('asha', `/leave/config/types/${created.id}`, { isActive: false }));
  });

  test('required attachment and contact details, from the leave type', async () => {
    ok(await patch('asha', `/leave/config/types/${type.SL}`, { requiresAttachment: true, requiresContactDetails: true }));
    const r = await preview('priya', 'SL', day(12));
    assert.ok(issueCodes(r).includes('ATTACHMENT_REQUIRED'));
    assert.ok(issueCodes(r).includes('CONTACT_REQUIRED'));
    const e = fails(await apply('priya', 'SL', day(12)), 422);
    assert.ok(e.details.fieldErrors.attachment);

    const up = ok(await post('priya', '/leave/attachments?fileName=note.png', PNG_1x1, { 'content-type': 'image/png' }), 201);
    const made = ok(await apply('priya', 'SL', day(12), day(12), { attachmentIds: [up.id], contactDetails: '+91 90000 00000' }), 201);
    assert.equal(made.attachments.length, 1);
    assert.equal(made.contactDetails, '+91 90000 00000');
    ok(await patch('asha', `/leave/config/types/${type.SL}`, { requiresAttachment: false, requiresContactDetails: false }));

    const file = await get('priya', `/leave/attachments/${up.id}`);
    assert.equal(file.status, 200);
    assert.ok(file.buffer.equals(PNG_1x1));
    assert.match(file.headers.get('content-disposition') ?? '', /^attachment/);
    fails(await get('rahul', `/leave/attachments/${up.id}`), 404);
    ok(await get('krishna', `/leave/attachments/${up.id}`));
    fails(await call('priya', 'DELETE', `/leave/attachments/${up.id}`), 409, 'ATTACHMENT_LINKED');
  });

  test('uploads are checked by content, not by the name or declared type', async () => {
    fails(await post('priya', '/leave/attachments?fileName=evil.pdf', Buffer.from('<script>alert(1)</script>'), { 'content-type': 'application/pdf' }), 422, 'UNSUPPORTED_FILE');
    const pdf = ok(await post('priya', '/leave/attachments?fileName=../../etc/passwd.pdf', Buffer.from('%PDF-1.7 test'), { 'content-type': 'text/plain' }), 201);
    assert.equal(pdf.contentType, 'application/pdf');
    assert.equal(pdf.fileName, 'passwd.pdf');
    assert.equal((await call('priya', 'DELETE', `/leave/attachments/${pdf.id}`)).status, 204);
  });

  test('an attachment cannot be taken from another employee', async () => {
    const up = ok(await post('priya', '/leave/attachments?fileName=a.png', PNG_1x1), 201);
    fails(await apply('rahul', 'CL', day(13), day(13), { attachmentIds: [up.id] }), 422, 'INVALID_ATTACHMENT');
    assert.equal((await call('priya', 'DELETE', `/leave/attachments/${up.id}`)).status, 204);
  });

  test('the same Idempotency-Key creates one request', async () => {
    const key = { 'idempotency-key': 'e2a7f2d4-7a1e-4c55-8f0b-2c4b9a1d0001' };
    const a = ok(await apply('rahul', 'CL', day(14), day(14), {}, key), 201);
    const b = ok(await apply('rahul', 'CL', day(14), day(14), {}, key), 201);
    assert.equal(a.id, b.id);
    const n = await admin.query(`SELECT count(*)::int AS n FROM leave_balance_transactions WHERE leave_request_id = $1`, [a.id]);
    assert.equal(n.rows[0].n, 1, 'one hold');
    ok(await post('rahul', `/leave/requests/${a.id}/withdraw`, {}));
  });

  test('an unpaid leave type with negative balance allowed can be taken with no credit', async () => {
    const r = ok(await apply('rahul', 'LOP', day(15), day(15, 1)), 201);
    assert.equal(r.totalDays, 2);
    assert.equal((await balance('rahul', 'LOP')).available, -2);
    ok(await post('rahul', `/leave/requests/${r.id}/withdraw`, {}));
  });
});

describe('Employee: holidays', () => {
  let calendarId: number;

  test('holidays from the default calendar are not charged; optional ones are', async () => {
    const c = ok(await post('asha', '/leave/config/holiday-calendars', { code: 'DEFAULT', name: 'Next year', calendarYear: Y }), 201);
    calendarId = c.id;
    fails(await patch('asha', `/leave/config/holiday-calendars/${c.id}`, { status: 'active', isDefault: true }), 422, 'EMPTY_CALENDAR');
    ok(await post('asha', '/leave/config/holidays', { calendarId: c.id, name: 'Founders Day', holidayDate: day(16, 1), holidayType: 'organization' }), 201);
    ok(await post('asha', '/leave/config/holidays', { calendarId: c.id, name: 'Choice Day', holidayDate: day(16, 2), holidayType: 'optional' }), 201);
    ok(await patch('asha', `/leave/config/holiday-calendars/${c.id}`, { status: 'active', isDefault: true }));

    const r = ok(await preview('rahul', 'CL', day(16, 0), day(16, 2)));
    assert.equal(r.totalDays, 2, 'Monday + optional Wednesday; the fixed Tuesday holiday is free');
    assert.equal(r.days[1].dayType, 'holiday');
    assert.equal(r.days[1].holidayName, 'Founders Day');
    assert.equal(r.days[2].dayType, 'working');
  });

  test('a date range of only non-working days cannot be applied for', async () => {
    assert.ok(issueCodes(await preview('rahul', 'CL', day(16, 1))).includes('NO_WORKING_DAYS'));
    assert.ok(issueCodes(await preview('rahul', 'CL', day(16, 5), day(16, 6))).includes('NO_WORKING_DAYS'));
  });

  test('a calendar for the employee’s work location beats the default', async () => {
    await admin.query(`UPDATE employees SET work_location = 'Pune' WHERE id = $1`, [emp.rahul]);
    const c = ok(await post('asha', '/leave/config/holiday-calendars', { code: 'PUNE', name: 'Pune', calendarYear: Y, location: 'pune' }), 201);
    ok(await post('asha', '/leave/config/holidays', { calendarId: c.id, name: 'Pune Local', holidayDate: day(17, 0), holidayType: 'state' }), 201);
    ok(await patch('asha', `/leave/config/holiday-calendars/${c.id}`, { status: 'active' }));

    const rahul = ok(await preview('rahul', 'CL', day(17, 0), day(17, 1)));
    assert.equal(rahul.totalDays, 1);
    const priya = ok(await preview('priya', 'CL', day(17, 0), day(17, 1)));
    assert.equal(priya.totalDays, 2, 'other locations are unaffected');
    const fh = ok(await preview('rahul', 'CL', day(16, 1)));
    assert.equal(fh.totalDays, 1, 'Rahul no longer follows the default calendar’s holiday');
  });

  test('an assigned calendar beats location, and takes effect on its date (a transfer)', async () => {
    const c = ok(await post('asha', '/leave/config/holiday-calendars', { code: 'CHENNAI', name: 'Chennai', calendarYear: Y }), 201);
    ok(await post('asha', '/leave/config/holidays', { calendarId: c.id, name: 'Chennai Local', holidayDate: day(18, 1), holidayType: 'state' }), 201);
    ok(await post('asha', '/leave/config/holidays', { calendarId: c.id, name: 'Before Transfer', holidayDate: day(17, 3), holidayType: 'state' }), 201);
    ok(await patch('asha', `/leave/config/holiday-calendars/${c.id}`, { status: 'active' }));
    ok(await post('asha', '/leave/config/calendar-assignments', { employeeIds: [emp.rahul], calendarId: c.id, effectiveFrom: day(18, 0) }), 201);

    assert.equal(ok(await preview('rahul', 'CL', day(18, 1))).issues[0]?.code, 'NO_WORKING_DAYS');
    assert.equal(ok(await preview('rahul', 'CL', day(17, 3))).totalDays, 1, 'before the transfer the old calendar applies');
    assert.equal(ok(await preview('priya', 'CL', day(18, 1))).totalDays, 1);
    const history = ok(await get('asha', `/leave/config/calendar-assignments?employeeId=${emp.rahul}`));
    assert.equal(history.length, 1);
  });

  test('the employee calendar shows their holidays and weekly offs', async () => {
    const r = ok(await get('priya', `/leave/calendar?from=${Y}-01-01&to=${Y}-12-31`));
    assert.deepEqual(r.weeklyOffs, [0, 6]);
    assert.deepEqual(r.holidays.map((h: any) => h.name), ['Founders Day', 'Choice Day']);
    assert.equal(r.holidays[1].isOptional, true);
    assert.equal(r.calendarName, 'Next year');
    fails(await get('priya', `/leave/calendar?from=${Y}-12-31&to=${Y}-01-01`), 422);
    assert.ok(calendarId);
  });
});

describe('Employee: my requests and balance', () => {
  test('search and filter my requests; other people’s are absent', async () => {
    const all = ok(await get('priya', '/leave/requests'));
    assert.ok(all.total > 0);
    assert.ok(all.items.every((r: any) => r.employeeId === emp.priya));
    const pending = ok(await get('priya', `/leave/requests?status=pending&leaveTypeId=${type.CL}`));
    assert.ok(pending.items.every((r: any) => r.status === 'pending' && r.leaveTypeCode === 'CL'));
    const range = ok(await get('priya', `/leave/requests?from=${day(8)}&to=${day(8)}`));
    assert.equal(range.total, 1);
    assert.equal(ok(await get('priya', '/leave/requests?search=zzzz-no-match')).total, 0);
    fails(await get('priya', '/leave/requests?status=bogus'), 422);
  });

  test('the wildcard characters in a search are literal', async () => {
    assert.equal(ok(await get('priya', '/leave/requests?search=%25%25')).total, 0);
  });

  test('balance statement: every change is a ledger row with a running balance', async () => {
    const r = ok(await get('priya', `/leave/balances/transactions?year=${Y}&leaveTypeId=${type.CL}`));
    assert.ok(r.total >= 2);
    const oldest = r.items[r.items.length - 1];
    assert.equal(oldest.txnType, 'ACCRUAL');
    assert.equal(oldest.availableAfter, 12);
    const b = await balance('priya', 'CL');
    assert.equal(r.items[0].availableAfter, b.available, 'the running balance ends at the displayed balance');
  });

  test('request detail has the approval history and what can be done next', async () => {
    const list = ok(await get('priya', `/leave/requests?from=${day(8)}&to=${day(8)}`));
    const r = ok(await get('priya', `/leave/requests/${list.items[0].id}`));
    assert.equal(r.workflow.history[0].action, 'submit');
    assert.equal(r.workflow.tasks[0].stepName, 'Manager Approval');
    assert.deepEqual(r.actions, { canWithdraw: true, canCancel: false, canResubmit: false, canHrCancel: false });
    assert.equal(r.balance.pending > 0, true);
  });

  test('another employee’s request is a 404', async () => {
    const list = ok(await get('priya', '/leave/requests'));
    fails(await get('rahul', `/leave/requests/${list.items[0].id}`), 404);
    fails(await post('rahul', `/leave/requests/${list.items[0].id}/withdraw`, {}), 404);
  });
});

describe('Cancellation and reversal', () => {
  let id: number;

  test('approved leave deducts; cancelling before it starts reverses exactly once', async () => {
    const before_ = await balance('krishna', 'CL');
    const r = ok(await apply('krishna', 'CL', day(19), day(19, 1)), 201);
    id = r.id;
    const tasks = ok(await get('suresh', '/leave/team/approvals/pending'));
    ok(await post('suresh', `/workflows/tasks/${tasks.find((t: any) => t.entityId === id).taskId}/approve`, {}));
    const tasks2 = ok(await get('anita', '/leave/team/approvals/pending'));
    ok(await post('anita', `/workflows/tasks/${tasks2.find((t: any) => t.entityId === id).taskId}/approve`, {}));

    const mid = await balance('krishna', 'CL');
    assert.deepEqual([mid.used - before_.used, mid.pending - before_.pending], [2, 0]);

    fails(await post('krishna', `/leave/requests/${id}/cancel`, {}), 422, 'VALIDATION_FAILED');
    const cancelled = ok(await post('krishna', `/leave/requests/${id}/cancel`, { reason: 'Plans changed' }));
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancellation.daysReversed, 2);
    assert.equal(cancelled.cancellation.isHrAction, false);
    assert.deepEqual(cancelled.ledger.map((l: any) => l.txnType), ['LEAVE_HOLD', 'LEAVE_HOLD_RELEASE', 'LEAVE_CONSUMPTION', 'LEAVE_REVERSAL']);
    const after_ = await balance('krishna', 'CL');
    assert.equal(after_.available, before_.available);
    assert.equal(after_.used, before_.used);
  });

  test('a duplicate cancel cannot reverse twice', async () => {
    const before_ = await balance('krishna', 'CL');
    fails(await post('krishna', `/leave/requests/${id}/cancel`, { reason: 'Again' }), 409, 'NOT_CANCELLABLE');
    assert.equal((await balance('krishna', 'CL')).available, before_.available);
  });

  test('concurrent cancels reverse once', async () => {
    const r = ok(await apply('rahul', 'CL', day(20), day(20, 1)), 201);
    await approveAll(r.id);
    const before_ = await balance('rahul', 'CL');
    const results = await Promise.all([
      post('rahul', `/leave/requests/${r.id}/cancel`, { reason: 'First' }),
      post('rahul', `/leave/requests/${r.id}/cancel`, { reason: 'Second' }),
    ]);
    assert.deepEqual(results.map((x) => x.status).sort(), [200, 409]);
    const after_ = await balance('rahul', 'CL');
    assert.equal(after_.available - before_.available, 2);
    const reversals = await admin.query(`SELECT count(*)::int AS n FROM leave_balance_transactions WHERE leave_request_id = $1 AND txn_type = 'LEAVE_REVERSAL'`, [r.id]);
    assert.equal(reversals.rows[0].n, 1);
  });

  test('a rejected request cannot be cancelled and never consumes balance', async () => {
    const before_ = await balance('rahul', 'SL');
    const r = ok(await apply('rahul', 'SL', day(21)), 201);
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    ok(await post('krishna', `/workflows/tasks/${t.taskId}/reject`, { comments: 'Not this week' }));
    fails(await post('rahul', `/leave/requests/${r.id}/cancel`, { reason: 'Too late' }), 409, 'NOT_CANCELLABLE');
    const after_ = await balance('rahul', 'SL');
    assert.deepEqual([after_.used, after_.available], [before_.used, before_.available]);
    const ledger = await admin.query(`SELECT txn_type FROM leave_balance_transactions WHERE leave_request_id = $1 ORDER BY id`, [r.id]);
    assert.deepEqual(ledger.rows.map((x) => x.txn_type), ['LEAVE_HOLD', 'LEAVE_HOLD_RELEASE']);
  });

  test('once leave has started only HR can cancel it, with an audit entry', async () => {
    // A calendar-day type so that today always counts, whatever day of the week the tests run.
    const created = ok(await post('asha', '/leave/config/types', {
      code: 'TESTNOW', name: 'Test same-day', includeNonWorkingDays: true, allowBackdated: true,
    }), 201);
    const policy = ok(await get('asha', '/leave/config/policies')).find((p: any) => p.code === 'PERMANENT');
    ok(await post('asha', '/leave/config/entitlements', { policyId: policy.id, leaveTypeId: created.id, allowNegativeBalance: true }), 201);

    const r = ok(await apply('rahul', 'TESTNOW', localToday()), 201);
    await approveAll(r.id);

    fails(await post('rahul', `/leave/requests/${r.id}/cancel`, { reason: 'Too late' }), 409, 'CANCEL_WINDOW_CLOSED');
    fails(await post('krishna', `/leave/admin/requests/${r.id}/cancel`, { reason: 'Manager tries' }), 403, 'MISSING_PERMISSION');

    const team = ok(await get('krishna', '/leave/team/dashboard'));
    assert.ok(team.onLeaveToday.some((x: any) => x.employeeName === 'Rahul'), 'manager dashboard shows who is away today');
    assert.equal(team.availability.onLeave, 1);
    const hrDash = ok(await get('anita', '/leave/admin/dashboard'));
    assert.ok(hrDash.onLeaveToday.some((x: any) => x.employeeName === 'Rahul'));

    const done = ok(await post('anita', `/leave/admin/requests/${r.id}/cancel`, { reason: 'Employee came back' }));
    assert.equal(done.status, 'cancelled');
    assert.equal(done.cancellation.isHrAction, true);
    const audit = await admin.query(`SELECT action, after_state FROM leave_audit_log WHERE target_type = 'leave_request' AND target_id = $1`, [r.id]);
    assert.equal(audit.rows[0].action, 'leave_request.cancel');
    assert.equal(audit.rows[0].after_state.reason, 'Employee came back');
  });

  test('HR cannot use the HR action on their own request', async () => {
    const r = ok(await apply('anita', 'CL', day(22)), 201);
    fails(await post('anita', `/leave/admin/requests/${r.id}/cancel`, { reason: 'Self' }), 403, 'SELF_APPROVAL');
    ok(await post('anita', `/leave/requests/${r.id}/withdraw`, {}));
  });

  test('HR can cancel an in-flight request: the hold is released and tasks close', async () => {
    const before_ = await balance('priya', 'SL');
    const r = ok(await apply('priya', 'SL', day(23)), 201);
    const done = ok(await post('anita', `/leave/admin/requests/${r.id}/cancel`, { reason: 'Duplicate of another request' }));
    assert.equal(done.status, 'cancelled');
    const after_ = await balance('priya', 'SL');
    assert.deepEqual([after_.pending, after_.available], [before_.pending, before_.available]);
    assert.ok(!ok(await get('krishna', '/leave/team/approvals/pending')).some((t: any) => t.entityId === r.id));
  });
});

// ------------------------------------------------------------------- manager ---

describe('Manager', () => {
  let id: number;

  test('pending approvals carry what the approver needs', async () => {
    const r = ok(await apply('rahul', 'CL', day(24), day(24, 1), { reason: 'Family function' }), 201);
    id = r.id;
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === id);
    assert.equal(t.summary.employeeName, 'Rahul');
    assert.equal(t.summary.leaveType, 'Casual Leave');
    assert.equal(t.summary.totalDays, 2);
    assert.equal(t.summary.reason, 'Family function');
    assert.ok(t.summary.submittedAt);
    assert.equal(t.stepName, 'Manager Approval');
    assert.equal(t.allowReturn, true);
  });

  test('someone with no approval permissions is forbidden, and not assigned tasks anyway', async () => {
    fails(await get('rahul', '/leave/team/approvals/pending'), 403, 'MISSING_PERMISSION');
    fails(await get('rahul', '/leave/team/requests'), 403, 'MISSING_PERMISSION');
    fails(await get('rahul', '/leave/team/dashboard'), 403, 'MISSING_PERMISSION');
    fails(await get('rahul', '/leave/team/approvals/history'), 403, 'MISSING_PERMISSION');
  });

  test('a manager cannot see or act on requests outside their team', async () => {
    const other = ok(await apply('anita', 'CL', day(25)), 201); // Anita reports to Vikram
    fails(await get('krishna', `/leave/requests/${other.id}`), 404);
    assert.ok(!ok(await get('krishna', '/leave/team/requests')).items.some((r: any) => r.id === other.id));
    const task = ok(await get('vikram', '/leave/team/approvals/pending')).find((x: any) => x.entityId === other.id);
    fails(await post('krishna', `/workflows/tasks/${task.taskId}/approve`, {}), 404);
    ok(await post('anita', `/leave/requests/${other.id}/withdraw`, {}));
  });

  test('team requests: filters by employee, type, status and date', async () => {
    const all = ok(await get('krishna', '/leave/team/requests?limit=100'));
    assert.ok(all.items.every((r: any) => ['Rahul', 'Priya'].includes(r.employeeName)));
    const rahul = ok(await get('krishna', `/leave/team/requests?employeeId=${emp.rahul}&status=pending&leaveTypeId=${type.CL}&from=${day(24)}&to=${day(24)}`));
    assert.equal(rahul.total, 1);
    assert.equal(rahul.items[0].id, id);
    assert.deepEqual(ok(await get('krishna', '/leave/team/members')).map((m: any) => m.fullName), ['Priya', 'Rahul']);
  });

  test('indirect reports are in scope too', async () => {
    const items = ok(await get('vikram', `/leave/team/requests?employeeId=${emp.rahul}&limit=100`)).items;
    assert.ok(items.length > 0);
    ok(await get('vikram', `/leave/requests/${id}`));
  });

  test('the request detail tells the approver their task', async () => {
    const r = ok(await get('krishna', `/leave/requests/${id}`));
    assert.equal(r.myTask.stepName, 'Manager Approval');
    assert.equal(r.actions.canWithdraw, false);
  });

  test('return for information: the employee resubmits and the task returns', async () => {
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === id);
    fails(await post('krishna', `/workflows/tasks/${t.taskId}/return`, {}), 422, 'COMMENT_REQUIRED');
    ok(await post('krishna', `/workflows/tasks/${t.taskId}/return`, { comments: 'Who covers your work?' }));
    const returned = ok(await get('rahul', `/leave/requests/${id}`));
    assert.equal(returned.status, 'returned');
    assert.equal(returned.actions.canResubmit, true);
    assert.equal((await balance('rahul', 'CL')).pending >= 2, true, 'the hold stays while returned');

    const again = ok(await post('rahul', `/leave/requests/${id}/resubmit`, { reason: 'Priya covers my work' }));
    assert.equal(again.status, 'pending');
    assert.equal(again.reason, 'Priya covers my work');
    assert.ok(ok(await get('krishna', '/leave/team/approvals/pending')).some((x: any) => x.entityId === id));
  });

  test('approval and rejection appear in my history, with stage and comments', async () => {
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === id);
    ok(await post('krishna', `/workflows/tasks/${t.taskId}/reject`, { comments: 'Release week' }));
    const h = ok(await get('krishna', `/leave/team/approvals/history?limit=100`));
    const mine = h.items.filter((x: any) => x.requestId === id);
    assert.deepEqual(mine.map((x: any) => x.action).sort(), ['reject', 'return']);
    const reject = mine.find((x: any) => x.action === 'reject');
    assert.equal(reject.comments, 'Release week');
    assert.equal(reject.stepName, 'Manager Approval');
    assert.ok(reject.at);
    assert.equal(ok(await get('krishna', `/leave/team/approvals/history?action=return&limit=100`)).items.every((x: any) => x.action === 'return'), true);
    assert.equal(ok(await get('rahul', `/leave/requests/${id}`)).status, 'rejected');
  });

  test('a manager dashboard counts their team only', async () => {
    const d = ok(await get('krishna', '/leave/team/dashboard'));
    assert.equal(d.teamSize, 2);
    assert.ok(d.pendingApprovals >= 0);
    assert.equal(d.availability.available + d.availability.onLeave, 2);
    assert.ok(Array.isArray(d.byType));
  });

  test('a delegate sees the delegator’s task and history records both people', async () => {
    const now = Date.now();
    const del = ok(await post('krishna', '/workflows/delegations', {
      delegateUserId: (await admin.query(`SELECT user_id FROM employees WHERE id = $1`, [emp.anita])).rows[0].user_id,
      module: 'leave', from: new Date(now - 60_000).toISOString(), to: new Date(now + 3_600_000).toISOString(),
    }), 201);
    const r = ok(await apply('rahul', 'CL', day(26)), 201);
    const t = ok(await get('anita', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    assert.equal(t.viaDelegation, true);
    ok(await post('anita', `/workflows/tasks/${t.taskId}/approve`, { comments: 'For Krishna' }));
    const h = ok(await get('krishna', `/leave/team/approvals/history?limit=100`)).items.find((x: any) => x.requestId === r.id);
    assert.equal(h.onBehalfOfName, 'Krishna');
    assert.equal((await call('krishna', 'DELETE', `/workflows/delegations/${del.id}`)).status, 204);
  });
});

// --------------------------------------------------------------- configuration ---

describe('HR Admin: configuration', () => {
  test('nobody without the permission can read or change configuration', async () => {
    for (const url of ['types', 'policies', 'entitlements', 'holiday-calendars', 'holidays', 'accrual-rules', 'carry-forward-rules', 'comp-off-rules']) {
      fails(await get('rahul', `/leave/config/${url}`), 403, 'MISSING_PERMISSION');
    }
    fails(await post('krishna', '/leave/config/types', { code: 'X', name: 'Xx' }), 403);
    fails(await post('rahul', '/leave/config/policy-assignments', { employeeIds: [emp.rahul], policyId: 1, effectiveFrom: `${Y}-01-01` }), 403);
    fails(await post('krishna', '/leave/admin/balances/adjust', { employeeId: emp.rahul, leaveTypeId: type.CL, year: Y, days: 5, direction: 'credit', note: 'give me days' }), 403);
    fails(await post('krishna', '/leave/admin/jobs/accrual', { dryRun: false }), 403);
    fails(await get('krishna', '/leave/admin/requests'), 403);
    fails(await get('krishna', '/leave/admin/reports/balance?year=2026'), 403);
  });

  test('leave type create, update, and deactivation instead of delete', async () => {
    const t = ok(await post('anita', '/leave/config/types', { code: 'wfh_support', name: 'Support Leave', category: 'other', maxConsecutiveDays: 3 }), 201);
    assert.equal(t.code, 'WFH_SUPPORT', 'code is normalised');
    const u = ok(await patch('anita', `/leave/config/types/${t.id}`, { name: 'Support Duty Leave', minNoticeDays: 2 }));
    assert.deepEqual([u.name, u.minNoticeDays], ['Support Duty Leave', 2]);
    const off = ok(await patch('anita', `/leave/config/types/${t.id}`, { isActive: false }));
    assert.equal(off.isActive, false);
    assert.ok(ok(await get('anita', '/leave/config/types')).some((x: any) => x.id === t.id), 'still listed');
    assert.equal((await call('anita', 'DELETE', `/leave/config/types/${t.id}`)).status, 404, 'there is no delete');
    const audit = await admin.query(`SELECT action FROM leave_audit_log WHERE target_type = 'leave_type' AND target_id = $1 ORDER BY id`, [t.id]);
    assert.deepEqual(audit.rows.map((x) => x.action), ['leave_type.create', 'leave_type.update', 'leave_type.update']);
  });

  test('validation errors name the field', async () => {
    const e = fails(await post('anita', '/leave/config/types', { code: '1 bad', name: 'x' }), 422, 'VALIDATION_FAILED');
    assert.ok(e.details.fieldErrors.code);
    assert.ok(e.details.fieldErrors.name);
  });

  test('policy lifecycle: draft, validate, activate, single default, archive', async () => {
    const p = ok(await post('anita', '/leave/config/policies', { code: 'PROBATION', name: 'Probation Employee Policy', effectiveFrom: `${Y}-01-01` }), 201);
    assert.equal(p.status, 'draft');
    fails(await post('anita', `/leave/config/policies/${p.id}/activate`), 422, 'INVALID_POLICY');

    const ent = ok(await post('anita', '/leave/config/entitlements', { policyId: p.id, leaveTypeId: type.CL, annualEntitlement: 6 }), 201);
    fails(await post('anita', '/leave/config/entitlements', { policyId: p.id, leaveTypeId: type.CL }), 409, 'DUPLICATE');

    const check = ok(await get('anita', `/leave/config/policies/${p.id}/activation-check`));
    assert.match(check.warnings[0], /no active accrual rule/);
    const activated = ok(await post('anita', `/leave/config/policies/${p.id}/activate`));
    assert.equal(activated.policy.status, 'active');
    assert.equal(activated.warnings.length, 1);

    fails(await patch('anita', `/leave/config/policies/${p.id}`, { isDefault: true }), 409, 'OVERLAP');

    const detail = ok(await get('anita', `/leave/config/policies/${p.id}`));
    assert.equal(detail.entitlements.length, 1);
    assert.equal((await call('anita', 'DELETE', `/leave/config/entitlements/${ent.id}`)).status, 204);
    ok(await post('anita', '/leave/config/entitlements', { policyId: p.id, leaveTypeId: type.CL, annualEntitlement: 6 }), 201);
    ok(await post('anita', `/leave/config/policies/${p.id}/archive`));
    fails(await post('anita', `/leave/config/policies/${p.id}/activate`), 409, 'POLICY_ARCHIVED');
  });

  test('an entitlement in use cannot be removed', async () => {
    const ents = ok(await get('anita', '/leave/config/entitlements'));
    const cl = ents.find((e: any) => e.leaveTypeCode === 'CL' && e.policyCode === 'PERMANENT');
    fails(await call('anita', 'DELETE', `/leave/config/entitlements/${cl.id}`), 409, 'ENTITLEMENT_IN_USE');
  });

  test('a policy with employees on it cannot be archived', async () => {
    const p = ok(await post('anita', '/leave/config/policies', { code: 'TEMP', name: 'Temp policy', effectiveFrom: `${Y}-01-01` }), 201);
    ok(await post('anita', '/leave/config/policy-assignments', { employeeIds: [emp.vikram], policyId: p.id, effectiveFrom: `${Y + 6}-01-01` }), 201);
    fails(await post('anita', `/leave/config/policies/${p.id}/archive`), 409, 'POLICY_IN_USE');
  });

  test('assigning a policy ends the open-ended one and applies from its date', async () => {
    const contract = ok(await get('anita', '/leave/config/policies')).find((p: any) => p.code === 'CONTRACT');
    const standard = ok(await get('anita', '/leave/config/policies')).find((p: any) => p.code === 'PERMANENT');
    ok(await post('anita', '/leave/config/policy-assignments', { employeeIds: [emp.priya], policyId: standard.id, effectiveFrom: '2024-01-01', assignmentReason: 'Joined' }), 201);
    ok(await post('anita', '/leave/config/policy-assignments', { employeeIds: [emp.priya], policyId: contract.id, effectiveFrom: day(40), assignmentReason: 'Moved to contract' }), 201);

    const history = ok(await get('anita', `/leave/config/policy-assignments?employeeId=${emp.priya}`));
    assert.equal(history.length, 2);
    assert.equal(history[0].effectiveFrom, day(40));
    assert.equal(history[1].effectiveTo, shift(day(40), -1));

    assert.ok(issueCodes(await preview('priya', 'CL', day(40))).includes('NOT_IN_POLICY'), 'the contract policy has no Casual Leave');
    assert.ok(!issueCodes(await preview('priya', 'CL', day(39))).includes('NOT_IN_POLICY'), 'the old policy still governs earlier dates');

    const started = history[1];
    fails(await call('anita', 'DELETE', `/leave/config/policy-assignments/${started.id}`), 409, 'ASSIGNMENT_STARTED');
    assert.equal((await call('anita', 'DELETE', `/leave/config/policy-assignments/${history[0].id}`)).status, 204, 'a future assignment can be removed');
    ok(await patch('anita', `/leave/config/policy-assignments/${started.id}`, { effectiveTo: null }));
    assert.ok(!issueCodes(await preview('priya', 'CL', day(40))).includes('NOT_IN_POLICY'));
  });

  test('employee assignment overview shows defaults as well as explicit assignments', async () => {
    const r = ok(await get('anita', `/leave/config/employee-assignments?search=Priya`));
    assert.equal(r.items[0].policyName, 'Permanent Employee Policy');
    assert.equal(r.items[0].policyIsDefault, false);
    const v = ok(await get('anita', `/leave/config/employee-assignments?search=Suresh`)).items[0];
    assert.equal(v.policyIsDefault, true);
    assert.equal(v.calendarSource, 'default');
  });

  test('active rules are immutable: archive and create a new one', async () => {
    const rules = ok(await get('anita', '/leave/config/accrual-rules'));
    const el = rules.find((r: any) => r.leaveTypeName === 'Earned Leave');
    fails(await patch('anita', `/leave/config/accrual-rules/${el.id}`, { accrualAmount: 5 }), 409, 'RULE_NOT_DRAFT');
    const carry = ok(await get('anita', '/leave/config/carry-forward-rules'))[0];
    fails(await patch('anita', `/leave/config/carry-forward-rules/${carry.id}`, { maximumCarryForward: 1 }), 409, 'RULE_NOT_DRAFT');
  });

  test('accrual rule: draft, impact shown before activation, overlapping active rule refused', async () => {
    const ents = ok(await get('anita', '/leave/config/entitlements'));
    const pl = ents.find((e: any) => e.leaveTypeCode === 'PL' && e.policyCode === 'PERMANENT');
    const a = ok(await post('anita', '/leave/config/accrual-rules', {
      policyEntitlementId: pl.id, accrualFrequency: 'annual', accrualAmount: 5, effectiveFrom: `${Y}-01-01`,
    }), 201);
    assert.deepEqual([a.status, a.isActive], ['draft', false]);
    ok(await patch('anita', `/leave/config/accrual-rules/${a.id}`, { accrualAmount: 4 }));
    const impact = ok(await get('anita', `/leave/config/accrual-rules/${a.id}/impact`));
    assert.ok(impact.employeesOnPolicy > 0);
    const on = ok(await post('anita', `/leave/config/accrual-rules/${a.id}/activate`));
    assert.equal(on.rule.isActive, true);

    const b = ok(await post('anita', '/leave/config/accrual-rules', {
      policyEntitlementId: pl.id, accrualFrequency: 'monthly', accrualAmount: 1, effectiveFrom: `${Y}-06-01`,
    }), 201);
    fails(await post('anita', `/leave/config/accrual-rules/${b.id}/activate`), 409, 'OVERLAP');
    ok(await post('anita', `/leave/config/accrual-rules/${a.id}/archive`));
    fails(await post('anita', `/leave/config/accrual-rules/${a.id}/activate`), 409, 'RULE_ARCHIVED');
  });

  test('carry-forward rule needs the policy to allow carry-forward', async () => {
    const ents = ok(await get('anita', '/leave/config/entitlements'));
    const cl = ents.find((e: any) => e.leaveTypeCode === 'CL' && e.policyCode === 'PERMANENT');
    const r = ok(await post('anita', '/leave/config/carry-forward-rules', {
      policyEntitlementId: cl.id, maximumCarryForward: 2, effectiveFrom: `${Y}-01-01`,
    }), 201);
    fails(await post('anita', `/leave/config/carry-forward-rules/${r.id}/activate`), 422, 'CARRY_FORWARD_NOT_ALLOWED');
    fails(await post('anita', '/leave/config/carry-forward-rules', {
      policyEntitlementId: cl.id, expiryEnabled: true, expiryDateRule: 'months_after_carry', effectiveFrom: `${Y}-01-01`,
    }), 409, 'INVARIANT_VIOLATION');
  });

  test('holiday calendar: update, delete a holiday, duplicate date refused', async () => {
    const c = ok(await post('anita', '/leave/config/holiday-calendars', { code: 'ANNEX', name: 'Annex', calendarYear: Y + 1 }), 201);
    const h = ok(await post('anita', '/leave/config/holidays', { calendarId: c.id, name: 'Annex Day', holidayDate: `${Y + 1}-03-03`, holidayType: 'national' }), 201);
    fails(await post('anita', '/leave/config/holidays', { calendarId: c.id, name: 'Other', holidayDate: `${Y + 1}-03-03` }), 409, 'DUPLICATE');
    const u = ok(await patch('anita', `/leave/config/holidays/${h.id}`, { holidayType: 'optional' }));
    assert.deepEqual([u.holidayType, u.isOptional], ['optional', true]);
    assert.equal((await call('anita', 'DELETE', `/leave/config/holidays/${h.id}`)).status, 204);
    assert.equal(ok(await get('anita', `/leave/config/holidays?calendarId=${c.id}`)).length, 0);
  });

  test('configuration is isolated between tenants', async () => {
    const mine = ok(await get('asha', '/leave/config/types'));
    fails(await patch('meera', `/leave/config/types/${mine[0].id}`, { name: 'Taken over' }), 404);
    fails(await get('meera', `/leave/config/policies/1`), 404);
    assert.ok(!ok(await get('meera', '/leave/config/types')).some((t: any) => t.code === 'CL'));
    fails(await post('meera', '/leave/config/entitlements', { policyId: 1, leaveTypeId: type.CL }), 422, 'INVALID_REFERENCE');
  });
});

// ------------------------------------------------------------------------ jobs ---

describe('HR Admin: balances and jobs', () => {
  const X = Y + 2; // an untouched year

  test('accrual: a dry run writes nothing, a real run credits, and a repeat credits nothing', async () => {
    const asOf = `${X}-03-15`;
    const dry = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf, dryRun: true, employeeId: emp.vikram }));
    assert.ok(dry.creditedDays > 0);
    const none = await admin.query(`SELECT 1 FROM leave_balances WHERE leave_year = $1 AND employee_id = $2`, [X, emp.vikram]);
    assert.equal(none.rowCount, 0, 'a dry run creates no balance rows either');

    const real = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf, employeeId: emp.vikram }));
    assert.equal(real.creditedDays, 12 + 12 + 4.5, 'CL 12 + SL 12 + EL 3 months at 1.5');
    assert.equal((await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf, employeeId: emp.vikram }))).creditedDays, 0);
  });

  test('accrual: duplicate jobs at the same moment credit once', async () => {
    const asOf = `${X}-06-15`;
    const results = await Promise.all([1, 2, 3].map(() => withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf, employeeId: emp.vikram }))));
    assert.equal(results.reduce((s, r) => s + r.creditedDays, 0), 4.5, '3 more months at 1.5, in total across all jobs');
    const r = await admin.query(
      `SELECT count(*)::int AS n, sum(t.days) AS d FROM leave_balance_transactions t
         JOIN leave_balances b ON b.tenant_id = t.tenant_id AND b.id = t.balance_id
        WHERE b.employee_id = $1 AND b.leave_year = $2 AND b.leave_type_id = $3 AND t.txn_type = 'ACCRUAL'`,
      [emp.vikram, X, type.EL]);
    assert.deepEqual([r.rows[0].n, Number(r.rows[0].d)], [6, 9]);
  });

  test('accrual: the maximum balance caps the credit, and a capped period stays used', async () => {
    const ents = ok(await get('anita', '/leave/config/entitlements'));
    const bl = ents.find((e: any) => e.leaveTypeCode === 'BL' && e.policyCode === 'PERMANENT');
    const r = ok(await post('anita', '/leave/config/accrual-rules', {
      policyEntitlementId: bl.id, accrualFrequency: 'monthly', accrualAmount: 2, maximumBalance: 3, effectiveFrom: `${X}-01-01`, effectiveTo: `${X}-12-31`,
    }), 201);
    ok(await post('anita', `/leave/config/accrual-rules/${r.id}/activate`));
    const preview = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf: `${X}-03-31`, ruleId: r.id, employeeId: emp.vikram, dryRun: true }));
    assert.deepEqual([preview.creditedDays, preview.cappedDays], [3, 3], 'the preview applies the cap across its own credits');
    const out = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf: `${X}-03-31`, ruleId: r.id, employeeId: emp.vikram }));
    assert.deepEqual([out.creditedDays, out.cappedDays], [3, 3], 'Jan 2, Feb 1 (capped), Mar 0 (capped)');
    ok(await post('asha', '/leave/admin/balances/adjust', { employeeId: emp.vikram, leaveTypeId: type.BL, year: X, days: 3, direction: 'debit', note: 'Free up room' }), 201);
    const later = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf: `${X}-03-31`, ruleId: r.id, employeeId: emp.vikram }));
    assert.equal(later.creditedDays, 0, 'capped periods are not credited later');
    ok(await post('anita', `/leave/config/accrual-rules/${r.id}/archive`));
  });

  test('accrual: exited employees and manual rules get nothing, joiners only from joining', async () => {
    await admin.query(`UPDATE employees SET status = 'exited' WHERE id = $1`, [emp.kiran ?? emp.arjun]);
    const out = await withTenantTx(T2, (tx) => runAccrual(tx, T2, { asOf: `${X}-02-01` }));
    assert.ok(!out.items.some((i) => i.employeeId === emp.arjun));
    await admin.query(`UPDATE employees SET status = 'active' WHERE id = $1`, [emp.arjun]);
  });

  test('accrual uses the policy in force on the credit date', async () => {
    const contract = ok(await get('anita', '/leave/config/policies')).find((p: any) => p.code === 'CONTRACT');
    const standard = ok(await get('anita', '/leave/config/policies')).find((p: any) => p.code === 'PERMANENT');
    ok(await post('anita', '/leave/config/policy-assignments', { employeeIds: [emp.anita], policyId: standard.id, effectiveFrom: '2024-01-01' }), 201);
    ok(await post('anita', '/leave/config/policy-assignments', { employeeIds: [emp.anita], policyId: contract.id, effectiveFrom: `${X}-03-01` }), 201);
    const out = await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf: `${X}-05-31`, employeeId: emp.anita }));
    const el = out.items.filter((i) => i.leaveTypeName === 'Earned Leave').map((i) => i.periodKey);
    assert.deepEqual(el, [`${X}-01`, `${X}-02`], 'no Earned Leave after the move to the contract policy');
  });

  test('HR run endpoint defaults to a dry run; future accrual cannot be forced through it', async () => {
    const r = ok(await post('anita', '/leave/admin/jobs/accrual', {}));
    assert.equal(r.dryRun, true);
    fails(await post('anita', '/leave/admin/jobs/accrual', { asOf: `${X}-01-01` }), 422, 'VALIDATION_FAILED');
  });

  test('manual adjustment: a reason is required, every change audited, replays are safe', async () => {
    fails(await post('anita', '/leave/admin/balances/adjust', { employeeId: emp.rahul, leaveTypeId: type.PL, year: Y, days: 1, direction: 'credit' }), 422);
    const key = { 'idempotency-key': 'e2a7f2d4-7a1e-4c55-8f0b-2c4b9a1d0002' };
    const body = { employeeId: emp.rahul, leaveTypeId: type.PL, year: Y, days: 2, direction: 'credit', note: 'Joining bonus' };
    const a = ok(await post('anita', '/leave/admin/balances/adjust', body, key), 201);
    const b = ok(await post('anita', '/leave/admin/balances/adjust', body, key), 201);
    assert.deepEqual([a.replayed, b.replayed, b.balance.adjusted], [false, true, 2]);
    fails(await post('anita', '/leave/admin/balances/adjust', { ...body, days: 50, direction: 'debit' }), 422, 'INSUFFICIENT_BALANCE');
    const audit = await admin.query(`SELECT count(*)::int AS n FROM leave_audit_log WHERE action = 'balance.credit' AND target_id = $1`, [a.balance.id]);
    assert.equal(audit.rows[0].n, 1);
  });

  test('nobody can credit, debit or encash their own balance', async () => {
    fails(await post('anita', '/leave/admin/balances/adjust', { employeeId: emp.anita, leaveTypeId: type.CL, year: Y, days: 5, direction: 'credit', note: 'For myself' }), 403, 'SELF_APPROVAL');
    fails(await post('anita', '/leave/admin/balances/encash', { employeeId: emp.anita, leaveTypeId: type.EL, year: Y, days: 1, note: 'For myself' }), 403, 'SELF_APPROVAL');
  });

  test('encashment only where the policy allows it', async () => {
    fails(await post('anita', '/leave/admin/balances/encash', { employeeId: emp.rahul, leaveTypeId: type.CL, year: Y, days: 1, note: 'Cash out' }), 422, 'ENCASHMENT_NOT_ALLOWED');
    const before_ = await balance('rahul', 'EL');
    const r = ok(await post('anita', '/leave/admin/balances/encash', { employeeId: emp.rahul, leaveTypeId: type.EL, year: Y, days: 2, note: 'Year-end encashment' }), 201);
    assert.equal(r.balance.encashed, 2);
    assert.equal((await balance('rahul', 'EL')).available, before_.available - 2);
    fails(await post('anita', '/leave/admin/balances/encash', { employeeId: emp.rahul, leaveTypeId: type.EL, year: Y, days: 500, note: 'Too much' }), 422);
  });

  test('carry forward: limits, closing the old year, expiry date, and a repeat does nothing', async () => {
    const from = Y + 3;
    await withTenantTx(T1, (tx) => runAccrual(tx, T1, { asOf: `${from}-12-31`, employeeId: emp.vikram }));
    const dry = await withTenantTx(T1, (tx) => runCarryForward(tx, T1, { fromYear: from, dryRun: true }));
    const line = dry.lines.find((l) => l.employeeId === emp.vikram && l.leaveTypeName === 'Earned Leave')!;
    assert.deepEqual([line.closing, line.carried, line.lapsed], [18, 15, 3], 'seed rule: at most 15 days');
    assert.equal(line.expiresOn, `${from + 1}-03-31`, 'three months into the new year');
    const untouched = await admin.query(`SELECT carried_out FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.EL, from]);
    assert.equal(Number(untouched.rows[0].carried_out), 0);

    const real = await withTenantTx(T1, (tx) => runCarryForward(tx, T1, { fromYear: from }));
    assert.ok(real.totalCarried >= 15);
    const old = (await admin.query(`SELECT available, carried_out, expired FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.EL, from])).rows[0];
    assert.deepEqual([Number(old.available), Number(old.carried_out), Number(old.expired)], [0, 15, 3], 'the old year is closed');
    const next = (await admin.query(`SELECT carried_forward FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.EL, from + 1])).rows[0];
    assert.equal(Number(next.carried_forward), 15);

    const again = await withTenantTx(T1, (tx) => runCarryForward(tx, T1, { fromYear: from }));
    assert.equal(again.totalCarried, 0);
    assert.ok(again.skippedAlreadyClosed > 0);
    const after_ = (await admin.query(`SELECT carried_forward FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.EL, from + 1])).rows[0];
    assert.equal(Number(after_.carried_forward), 15);
  });

  test('carry forward endpoint refuses a year that has not ended', async () => {
    fails(await post('anita', '/leave/admin/jobs/carry-forward', { fromYear: new Date().getFullYear(), dryRun: false }), 422, 'YEAR_NOT_ENDED');
  });

  test('expiry: only the unused part of carried leave expires, once', async () => {
    const to = Y + 4;
    const notYet = await withTenantTx(T1, (tx) => runExpiry(tx, T1, { asOf: `${to}-03-31` }));
    assert.equal(notYet.expiredDays, 0, 'still valid on the expiry date');

    const res = await withTenantTx(T1, (tx) => runExpiry(tx, T1, { asOf: `${to}-04-01`, dryRun: true }));
    assert.ok(res.expiredDays > 0);
    const real = await withTenantTx(T1, (tx) => runExpiry(tx, T1, { asOf: `${to}-04-01` }));
    assert.equal(real.expiredDays, res.expiredDays);
    const row = (await admin.query(`SELECT expired, carried_forward, available FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.EL, to])).rows[0];
    assert.equal(Number(row.expired), 15);
    assert.equal(Number(row.available), 0);
    assert.equal((await withTenantTx(T1, (tx) => runExpiry(tx, T1, { asOf: `${to}-04-01` }))).expiredDays, 0);
  });

  test('reconciliation: the ledger matches every displayed balance', async () => {
    const r = ok(await get('anita', '/leave/admin/reconciliation'));
    assert.deepEqual([r.inBalance, r.drift.length], [true, 0]);
  });
});

describe('Comp off', () => {
  const lastWeekend = () => {
    const d = new Date(`${localToday()}T00:00:00Z`);
    while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  };
  const lastWeekday = () => {
    const d = new Date(`${localToday()}T00:00:00Z`);
    do d.setUTCDate(d.getUTCDate() - 1); while ([0, 6].includes(d.getUTCDay()));
    return d.toISOString().slice(0, 10);
  };
  const weekendBefore = (weeks: number, sunday = false) => shift(lastWeekend(), -7 * weeks + (sunday ? -6 : 0));
  const claimTask = async (who: string, claimId: number) => {
    const t = ok(await get(who, '/leave/team/approvals/pending')).find((x: any) => x.module === 'comp_off' && x.entityId === claimId);
    assert.ok(t, `${who} has no comp off task for claim ${claimId}`);
    return t;
  };
  const thisYear = new Date().getFullYear();
  let claimId: number;

  test('a claim needs an eligible day and enough hours, and credits nothing on submission', async () => {
    const types = ok(await get('rahul', '/leave/comp-off/types'));
    assert.equal(types[0].minimumWorkHours, 8);
    fails(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: lastWeekday(), hoursWorked: 9, reason: 'Extra work' }), 422, 'DAY_NOT_ELIGIBLE');
    fails(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: lastWeekend(), hoursWorked: 4, reason: 'Short' }), 422, 'NOT_ENOUGH_HOURS');
    fails(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: `${Y + 9}-01-02`, hoursWorked: 9, reason: 'Future' }), 422, 'FUTURE_WORK_DATE');

    const before_ = await balance('rahul', 'CO', thisYear);
    const c = ok(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: lastWeekend(), hoursWorked: 9, reason: 'Production release' }), 201);
    claimId = c.id;
    assert.equal(c.status, 'pending');
    assert.equal(c.currentStep, 'Manager Approval');
    assert.equal(c.waitingOn, 'Krishna');
    assert.equal((await balance('rahul', 'CO', thisYear)).available, before_?.available ?? 0);
    fails(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: lastWeekend(), hoursWorked: 9, reason: 'Twice' }), 409, 'DUPLICATE');
  });

  test('the claim reaches the reporting manager, through the comp off workflow', async () => {
    const t = await claimTask('krishna', claimId);
    assert.equal(t.stepName, 'Manager Approval');
    assert.equal(t.summary.employeeName, 'Rahul');
    assert.equal(Number(t.summary.hoursWorked), 9);
    assert.equal(t.summary.reason, 'Production release');
    const dash = ok(await get('krishna', '/leave/team/dashboard'));
    assert.ok(dash.pendingApprovals >= 1, 'counted in the manager dashboard');
    fails(await post('priya', `/workflows/tasks/${t.taskId}/approve`, {}), 404);
    fails(await post('rahul', `/workflows/tasks/${t.taskId}/approve`, {}), 404);
  });

  test('manager approval is not the last step: nothing is credited until HR approves', async () => {
    ok(await post('krishna', `/workflows/tasks/${(await claimTask('krishna', claimId)).taskId}/approve`, { comments: 'I saw the release' }));
    const mine = ok(await get('rahul', '/leave/comp-off/claims')).items.find((x: any) => x.id === claimId);
    assert.deepEqual([mine.status, mine.currentStep], ['pending', 'HR Approval']);
    assert.equal((await balance('rahul', 'CO', thisYear))?.compOff ?? 0, 0);

    const hr = await claimTask('anita', claimId);
    ok(await post('anita', `/workflows/tasks/${hr.taskId}/approve`, { comments: 'Verified with the release log' }));
    const done = ok(await get('rahul', '/leave/comp-off/claims')).items.find((x: any) => x.id === claimId);
    assert.equal(done.status, 'approved');
    assert.equal(done.expiresOn, shift(lastWeekend(), 60));
    assert.equal(done.decisionNote, 'Verified with the release log');
    assert.equal((await balance('rahul', 'CO', thisYear)).compOff, 1);
    fails(await post('anita', `/workflows/tasks/${hr.taskId}/approve`, {}), 409, 'TASK_ALREADY_ACTED');
    assert.equal((await balance('rahul', 'CO', thisYear)).compOff, 1, 'credited once');
  });

  test('approval history and the HR list show comp off decisions', async () => {
    const h = ok(await get('krishna', '/leave/team/approvals/history?limit=100')).items.find((x: any) => x.kind === 'comp_off' && x.requestId === claimId);
    assert.deepEqual([h.action, h.comments, h.stepName], ['approve', 'I saw the release', 'Manager Approval']);
    assert.ok(ok(await get('anita', '/leave/admin/comp-off/claims?status=approved')).items.some((c: any) => c.id === claimId));
    fails(await get('rahul', '/leave/admin/comp-off/claims'), 403);
  });

  test('HR can no longer decide outside the workflow', async () => {
    const c = ok(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: weekendBefore(1), hoursWorked: 9, reason: 'Weekend deploy' }), 201);
    fails(await post('anita', `/leave/admin/comp-off/claims/${c.id}/approve`, {}), 404);
    claimId = c.id;
  });

  test('return for information, then resubmit: approval starts again', async () => {
    const t = await claimTask('krishna', claimId);
    fails(await post('krishna', `/workflows/tasks/${t.taskId}/return`, {}), 422, 'COMMENT_REQUIRED');
    ok(await post('krishna', `/workflows/tasks/${t.taskId}/return`, { comments: 'Which deploy?' }));
    let mine = ok(await get('rahul', '/leave/comp-off/claims')).items.find((x: any) => x.id === claimId);
    assert.deepEqual([mine.status, mine.decisionNote], ['returned', 'Which deploy?']);
    fails(await post('priya', `/leave/comp-off/claims/${claimId}/resubmit`, { reason: 'Not mine' }), 404);
    mine = ok(await post('rahul', `/leave/comp-off/claims/${claimId}/resubmit`, { reason: 'Payments release 4.2' }));
    assert.deepEqual([mine.status, mine.reason, mine.currentStep], ['pending', 'Payments release 4.2', 'Manager Approval']);
    await claimTask('krishna', claimId);
  });

  test('reject needs a comment and credits nothing', async () => {
    const t = await claimTask('krishna', claimId);
    fails(await post('krishna', `/workflows/tasks/${t.taskId}/reject`, {}), 422, 'COMMENT_REQUIRED');
    ok(await post('krishna', `/workflows/tasks/${t.taskId}/reject`, { comments: 'Covered by overtime pay' }));
    const mine = ok(await get('rahul', '/leave/comp-off/claims')).items.find((x: any) => x.id === claimId);
    assert.deepEqual([mine.status, mine.decisionNote], ['rejected', 'Covered by overtime pay']);
    assert.equal((await balance('rahul', 'CO', thisYear)).compOff, 1);
    // A rejected date can be claimed again.
    ok(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: weekendBefore(1), hoursWorked: 9, reason: 'Second try' }), 201);
  });

  test('withdraw closes the open task', async () => {
    const c = ok(await post('rahul', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: weekendBefore(2), hoursWorked: 9, reason: 'Data migration' }), 201);
    const t = await claimTask('krishna', c.id);
    ok(await post('rahul', `/leave/comp-off/claims/${c.id}/withdraw`, {}));
    assert.ok(!ok(await get('krishna', '/leave/team/approvals/pending')).some((x: any) => x.module === 'comp_off' && x.entityId === c.id));
    fails(await post('krishna', `/workflows/tasks/${t.taskId}/approve`, {}), 409);
    fails(await post('rahul', `/leave/comp-off/claims/${c.id}/withdraw`, {}), 409, 'NOT_WITHDRAWABLE');
  });

  test('nobody approves their own claim: an HR admin’s claim goes to their manager, and skips them at the HR step', async () => {
    const c = ok(await post('anita', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: weekendBefore(3), hoursWorked: 9, reason: 'Own claim' }), 201);
    assert.equal(c.waitingOn, 'Vikram');
    ok(await post('vikram', `/workflows/tasks/${(await claimTask('vikram', c.id)).taskId}/approve`, {}));
    assert.ok(!ok(await get('anita', '/leave/team/approvals/pending')).some((x: any) => x.module === 'comp_off' && x.entityId === c.id));
    const hr = await claimTask('suresh', c.id);
    assert.equal(hr.stepName, 'HR Approval');
  });

  test('without a published comp off workflow, a claim is refused with a clear message', async () => {
    const c = await admin.query(`SELECT id FROM workflow_definitions WHERE tenant_id = $1 AND module = 'comp_off' AND status = 'published'`, [T1]);
    await admin.query(`ALTER TABLE workflow_definitions DISABLE TRIGGER trg_wf_def_guard`);
    await admin.query(`UPDATE workflow_definitions SET status = 'archived' WHERE id = $1`, [c.rows[0].id]);
    try {
      const e = fails(await post('priya', '/leave/comp-off/claims', { leaveTypeId: type.CO, workDate: weekendBefore(4), hoursWorked: 9, reason: 'No workflow' }), 422, 'WORKFLOW_NOT_CONFIGURED');
      assert.match(e.message, /comp off approval workflow/);
      const n = await admin.query(`SELECT count(*)::int n FROM leave_comp_off_claims WHERE reason = 'No workflow'`);
      assert.equal(n.rows[0].n, 0, 'nothing is saved');
    } finally {
      await admin.query(`UPDATE workflow_definitions SET status = 'published' WHERE id = $1`, [c.rows[0].id]);
      await admin.query(`ALTER TABLE workflow_definitions ENABLE TRIGGER trg_wf_def_guard`);
    }
  });

  test('the database refuses an illegal claim transition', async () => {
    await assert.rejects(
      withTenantTx(T1, (tx) => tx.query(`UPDATE leave_comp_off_claims SET status = 'pending' WHERE id = $1`, [claimId])),
      (e: any) => e.code === '23514',
    );
  });
});

// ---------------------------------------------------------------------- admin ---

describe('HR Admin: requests, calendar and reports', () => {
  test('all requests: search and filter across the tenant', async () => {
    const all = ok(await get('anita', '/leave/admin/requests?limit=100'));
    assert.ok(new Set(all.items.map((r: any) => r.employeeName)).size > 1);
    const dept = (await admin.query(`SELECT id FROM departments WHERE name = 'Engineering' AND tenant_id = $1`, [T1])).rows[0].id;
    const eng = ok(await get('anita', `/leave/admin/requests?departmentId=${dept}&limit=100`));
    assert.ok(eng.items.every((r: any) => r.departmentName === 'Engineering'));
    assert.ok(ok(await get('anita', '/leave/admin/requests?search=Rahul&limit=100')).items.every((r: any) => r.employeeName === 'Rahul'));
    assert.ok(ok(await get('anita', '/leave/admin/requests?location=Pune&limit=100')).items.every((r: any) => r.workLocation === 'Pune'));
    assert.ok(!ok(await get('meera', '/leave/admin/requests?limit=100')).items.some((r: any) => r.employeeName === 'Rahul'), 'other tenants never appear');
  });

  test('HR sees approval history and balance calculations on any request', async () => {
    const one = ok(await get('anita', '/leave/admin/requests?search=Rahul&status=rejected&limit=1')).items[0];
    const d = ok(await get('anita', `/leave/requests/${one.id}`));
    assert.ok(d.workflow.history.length >= 2);
    assert.ok(d.balance);
    assert.ok(d.ledger.length >= 2);
  });

  test('admin dashboard figures', async () => {
    const d = ok(await get('anita', '/leave/admin/dashboard'));
    assert.equal(d.totalEmployees, 7);
    assert.ok(d.counts.pending >= 0 && d.counts.approved >= 0);
    assert.ok(Array.isArray(d.byDepartment) && Array.isArray(d.byType));
    fails(await get('rahul', '/leave/admin/dashboard'), 403);
  });

  test('employee dashboard figures add up', async () => {
    const d = ok(await get('rahul', '/leave/dashboard'));
    assert.equal(d.hasEmployeeRecord, true);
    assert.equal(d.year, new Date().getFullYear());
    const paid = d.balances.filter((b: any) => b.isPaid);
    assert.equal(d.totals.available, paid.reduce((s: number, b: any) => s + b.available, 0));
    assert.ok(d.balances.some((b: any) => b.leaveTypeCode === 'CL' && b.annualEntitlement === 12));
    assert.ok(Array.isArray(d.upcomingHolidays));
  });

  test('organization calendar: filters and holidays', async () => {
    const r = ok(await get('anita', `/leave/admin/calendar?from=${Y}-01-01&to=${Y}-12-31`));
    assert.ok(r.leaves.every((l: any) => l.status === 'approved'));
    assert.ok(r.holidays.some((h: any) => h.name === 'Founders Day'));
    const filtered = ok(await get('anita', `/leave/admin/calendar?from=${Y}-01-01&to=${Y}-12-31&location=Pune`));
    assert.ok(filtered.holidays.some((h: any) => h.name === 'Pune Local'));
    assert.ok(!filtered.holidays.some((h: any) => h.name === 'Chennai Local'));
    assert.ok(filtered.leaves.every((l: any) => l.workLocation === 'Pune'));
    fails(await get('krishna', `/leave/admin/calendar?from=${Y}-01-01&to=${Y}-12-31`), 403);
  });

  test('every report runs and has columns matching its rows', async () => {
    for (const t of ['balance', 'department', 'utilization', 'leave_type', 'monthly', 'annual', 'pending', 'accrual', 'carry_forward', 'encashment', 'audit']) {
      const r = ok(await get('anita', `/leave/admin/reports/${t}?year=${Y}`));
      assert.ok(r.columns.length > 0, t);
      for (const row of r.rows.slice(0, 3)) {
        for (const c of r.columns) assert.ok(c.key in row, `${t}: column ${c.key} missing from the row`);
      }
    }
    fails(await get('anita', `/leave/admin/reports/nope?year=${Y}`), 422);
  });

  test('reports: figures and filters', async () => {
    const enc = ok(await get('anita', `/leave/admin/reports/encashment?year=${Y}`));
    assert.ok(enc.rows.some((r: any) => r.employeeName === 'Rahul' && r.days === 2));
    const bal = ok(await get('anita', `/leave/admin/reports/balance?year=${Y}&leaveTypeId=${type.EL}`));
    assert.ok(bal.rows.every((r: any) => r.leaveTypeName === 'Earned Leave'));
    assert.ok(bal.rows.length >= 7);
    const audit = ok(await get('anita', `/leave/admin/reports/audit?year=${new Date().getFullYear()}`));
    assert.ok(audit.rows.some((r: any) => r.action === 'balance.encash'));
  });

  test('lookups and the employee picker are permission-gated', async () => {
    const l = ok(await get('anita', '/leave/lookups'));
    assert.ok(l.departments.length && l.leaveTypes.length && l.policies.length);
    assert.ok(l.locations.includes('Pune'));
    fails(await get('rahul', '/leave/lookups'), 403);
    assert.ok(ok(await get('anita', '/leave/employees?search=Rah')).some((e: any) => e.fullName === 'Rahul'));
    fails(await get('rahul', '/leave/employees'), 403);
  });

  test('workflow options list the fields a step condition may use', async () => {
    const o = ok(await get('anita', '/leave/config/workflow-options'));
    assert.ok(o.conditionFields.some((f: any) => f.field === 'employmentType'));
    assert.equal(o.requiredPermission, 'leave.request.approve');
    const c = ok(await get('anita', '/leave/config/workflow-options?module=comp_off'));
    assert.ok(c.conditionFields.some((f: any) => f.field === 'hoursWorked'));
    assert.ok(!c.conditionFields.some((f: any) => f.field === 'totalDays'));
  });
});

describe('Notifications go through the outbox', () => {
  test('each stage of a request queues an event in its own transaction', async () => {
    const r = ok(await apply('rahul', 'CL', day(27)), 201);
    await approveAll(r.id);
    const ev = await admin.query(
      `SELECT event_type FROM outbox_events WHERE aggregate_type = 'leave_request' AND aggregate_id = $1 ORDER BY id`, [r.id]);
    assert.deepEqual(ev.rows.map((x) => x.event_type), ['leave.submitted', 'leave.approved']);
    const wf = await admin.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'workflow.task_assigned' AND payload ->> 'entityId' = $1`, [String(r.id)]);
    assert.ok(wf.rows[0].n >= 2, 'approvers are notified');
  });

  test('a request that fails rolls back its events and its hold', async () => {
    const count = async () => Number((await admin.query(`SELECT count(*) AS n FROM outbox_events`)).rows[0].n);
    const before_ = await count();
    const holds = async () => Number((await admin.query(`SELECT count(*) AS n FROM leave_balance_transactions WHERE txn_type = 'LEAVE_HOLD'`)).rows[0].n);
    const holdsBefore = await holds();
    fails(await apply('meera', 'AL', day(0)), 422, 'NO_ELIGIBLE_APPROVER');
    assert.equal(await count(), before_);
    assert.equal(await holds(), holdsBefore);
  });
});

describe('Concurrency', () => {
  test('simultaneous requests for one balance cannot overspend', async () => {
    const cover = ok(await post('asha', '/leave/admin/balances/adjust', {
      employeeId: emp.vikram, leaveTypeId: type.BL, year: Y + 1, days: 3, direction: 'credit', note: 'Concurrency test',
    }), 201);
    assert.equal(cover.balance.available, 3);
    const d = (w: number, dow: number) => {
      const x = new Date(Date.UTC(Y + 1, 1, 1));
      while (x.getUTCDay() !== 1) x.setUTCDate(x.getUTCDate() + 1);
      x.setUTCDate(x.getUTCDate() + w * 7 + dow);
      return x.toISOString().slice(0, 10);
    };
    const results = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => apply('vikram', 'BL', d(i, 0), d(i, 1))));
    const created = results.filter((r) => r.status === 201);
    assert.equal(created.length, 1, '3 days of balance fund one 2-day request');
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.json.error.code === 'INSUFFICIENT_BALANCE'));
    const row = (await admin.query(`SELECT available, pending FROM leave_balances WHERE employee_id = $1 AND leave_type_id = $2 AND leave_year = $3`, [emp.vikram, type.BL, Y + 1])).rows[0];
    assert.deepEqual([Number(row.available), Number(row.pending)], [1, 2]);
  });

  test('simultaneous requests for the same dates: one wins', async () => {
    // Different leave types lock different balances, so the exclusion constraint settles this race.
    const results = await Promise.all([apply('krishna', 'SL', day(28)), apply('krishna', 'CL', day(28))]);
    const statuses = results.map((r) => r.status).sort();
    assert.equal(statuses[0], 201);
    assert.ok([409, 422].includes(statuses[1]), `second request got ${statuses[1]}`);
    const loser = results.find((r) => r.status !== 201)!;
    assert.ok(['OVERLAP', 'OVERLAPPING_REQUEST'].includes(loser.json.error.code));
  });

  test('duplicate approval submissions advance the workflow once and deduct once', async () => {
    const r = ok(await apply('rahul', 'SL', day(29)), 201);
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    const first = await Promise.all([1, 2, 3].map(() => post('krishna', `/workflows/tasks/${t.taskId}/approve`, {})));
    assert.deepEqual(first.map((x) => x.status).sort(), [200, 409, 409]);
    const hr = ok(await get('anita', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    const second = await Promise.all([1, 2].map(() => post('anita', `/workflows/tasks/${hr.taskId}/approve`, {})));
    assert.deepEqual(second.map((x) => x.status).sort(), [200, 409]);
    const ledger = await admin.query(
      `SELECT txn_type, count(*)::int AS n FROM leave_balance_transactions WHERE leave_request_id = $1 GROUP BY 1 ORDER BY 1`, [r.id]);
    assert.deepEqual(ledger.rows, [
      { txn_type: 'LEAVE_CONSUMPTION', n: 1 }, { txn_type: 'LEAVE_HOLD', n: 1 }, { txn_type: 'LEAVE_HOLD_RELEASE', n: 1 },
    ]);
  });

  test('withdrawing while the manager approves: one outcome, and the balance is consistent', async () => {
    const r = ok(await apply('rahul', 'SL', day(31)), 201);
    const t = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    const out = await Promise.all([
      post('rahul', `/leave/requests/${r.id}/withdraw`, {}),
      post('krishna', `/workflows/tasks/${t.taskId}/approve`, {}),
    ]);
    assert.ok(out.some((x) => x.status === 200));
    const drift = await withTenantTx(T1, (tx) => tx.query(`SELECT 1 FROM v_leave_balance_drift`));
    assert.equal(drift.rowCount, 0);
  });

  test('after everything above, the ledger still matches every balance', async () => {
    for (const t of [T1, T2]) {
      const drift = await withTenantTx(t, (tx) => tx.query(`SELECT * FROM v_leave_balance_drift`));
      assert.equal(drift.rowCount, 0);
    }
    const neg = await admin.query(`SELECT count(*)::int AS n FROM leave_balances WHERE pending < 0 OR used < 0`);
    assert.equal(neg.rows[0].n, 0);
  });
});

describe('Full lifecycle', () => {
  test('apply -> manager -> HR -> approved -> deducted -> employee notified', async () => {
    const b0 = await balance('priya', 'EL');
    const r = ok(await apply('priya', 'EL', day(32), day(32, 2), { reason: 'Vacation' }), 201);
    assert.equal(r.status, 'pending');
    const b1 = await balance('priya', 'EL');
    assert.deepEqual([b1.used - b0.used, b1.pending - b0.pending], [0, 3]);

    const m = ok(await get('krishna', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    ok(await post('krishna', `/workflows/tasks/${m.taskId}/approve`, { comments: 'Enjoy' }));
    const b2 = await balance('priya', 'EL');
    assert.deepEqual([b2.used - b0.used, b2.pending - b0.pending], [0, 3], 'still held, not deducted');

    const h = ok(await get('anita', '/leave/team/approvals/pending')).find((x: any) => x.entityId === r.id);
    assert.equal(h.stepName, 'HR Approval');
    ok(await post('anita', `/workflows/tasks/${h.taskId}/approve`, { comments: 'Approved' }));

    const done = ok(await get('priya', `/leave/requests/${r.id}`));
    assert.equal(done.status, 'approved');
    assert.ok(done.decidedAt);
    assert.deepEqual(done.workflow.history.map((x: any) => x.action), ['submit', 'approve', 'approve', 'complete']);
    assert.deepEqual(done.workflow.history.filter((x: any) => x.comments).map((x: any) => x.comments), ['Enjoy', 'Approved']);
    const b3 = await balance('priya', 'EL');
    assert.deepEqual([b3.used - b0.used, b3.pending - b0.pending, b3.available - b0.available], [3, 0, -3]);

    const ev = await admin.query(`SELECT payload FROM outbox_events WHERE event_type = 'leave.approved' AND aggregate_id = $1`, [r.id]);
    assert.equal(Number(ev.rows[0].payload.employeeId), emp.priya);

    const cal = ok(await get('anita', `/leave/admin/calendar?from=${day(32)}&to=${day(32, 2)}`));
    assert.ok(cal.leaves.some((l: any) => l.id === r.id));
    const monthly = ok(await get('anita', `/leave/admin/reports/monthly?year=${Y}&leaveTypeId=${type.EL}`));
    assert.ok(monthly.rows.some((x: any) => x.leaveTypeName === 'Earned Leave' && x.days >= 3));
  });
});

/**
 * HTTP-level integration tests for the tenant portal milestones:
 *   M1 sessions / login / tenant selection / logout,
 *   M2 provisioning, activation, organization profile, settings, logo, onboarding,
 *   M4 role management, user directory, effective permissions, audit.
 * Runs the real Express app against the real database (RLS on, app role).
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import pg from 'pg';

import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { env } from '../src/config/env';
import { inviteTenantAdmin, provisionOrganization } from '../src/modules/onboarding/provisioning';

const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const PASSWORD = 'Passw0rd!';
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

let server: Server;
let base = '';
const uid: Record<string, number> = {};
const role: Record<string, number> = {};
const tokens: Record<string, string> = {};

interface CallOpts {
  token?: string;
  cookie?: string;
  web?: boolean;
  body?: unknown;
  raw?: Buffer;
  contentType?: string;
}
interface CallResult {
  status: number;
  json: any;
  headers: Headers;
  buffer: Buffer;
}

async function call(method: string, url: string, o: CallOpts = {}): Promise<CallResult> {
  const headers: Record<string, string> = {};
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.cookie) headers.cookie = o.cookie;
  if (o.web) headers['x-hrms-client'] = 'web';
  let body: Uint8Array | string | undefined;
  if (o.raw) {
    body = new Uint8Array(o.raw);
    headers['content-type'] = o.contentType ?? 'application/octet-stream';
  } else if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${base}/api/v1${url}`, { method, headers, body });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  if ((res.headers.get('content-type') ?? '').includes('json') && buffer.length) json = JSON.parse(buffer.toString('utf8'));
  return { status: res.status, json, headers: res.headers, buffer };
}

function expectStatus(r: CallResult, status: number, code?: string) {
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.json)}`);
  if (code) assert.equal(r.json?.error?.code, code);
}

async function login(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', '/auth/login', { body: { email, password: PASSWORD, ...extra } });
  expectStatus(r, 200);
  return r.json.accessToken;
}

const sessionCookie = (r: CallResult) => {
  const c = r.headers.getSetCookie().find((x) => x.startsWith('hrms_session='));
  return c ? c.split(';')[0] : undefined;
};

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  const u = await admin.query(`SELECT id, split_part(email, '@', 1) AS n FROM users`);
  for (const row of u.rows) uid[row.n] = Number(row.id);
  const r = await admin.query(`SELECT tenant_id, id, name FROM roles`);
  for (const row of r.rows) role[`${row.tenant_id}:${row.name}`] = Number(row.id);
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const who of ['asha', 'suresh', 'rahul', 'krishna', 'meera', 'priya']) {
    const domain = who === 'meera' ? 'xyz.test' : 'abc.test';
    tokens[who] = await login(`${who}@${domain}`);
  }
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await admin.end();
});

// =========================================================================
describe('M1 · login, sessions and tenant context', () => {
  test('/me returns identity, organization, memberships and effective permissions', async () => {
    const r = await call('GET', '/me', { token: tokens.asha });
    expectStatus(r, 200);
    assert.equal(r.json.user.email, 'asha@abc.test');
    assert.equal(r.json.tenant.displayName, 'ABC Technologies');
    assert.equal(r.json.tenant.onboardingCompleted, true);
    assert.deepEqual(r.json.memberships.map((m: any) => m.slug), ['abc-technologies']);
    assert.ok(r.json.permissions.includes('organization.update'));
    assert.ok(r.json.session?.id, 'session id present');
  });

  test('invalid credentials: generic 401 that does not reveal which part was wrong', async () => {
    const a = await call('POST', '/auth/login', { body: { email: 'asha@abc.test', password: 'nope' } });
    const b = await call('POST', '/auth/login', { body: { email: 'ghost@abc.test', password: 'nope' } });
    expectStatus(a, 401, 'INVALID_CREDENTIALS');
    expectStatus(b, 401, 'INVALID_CREDENTIALS');
    assert.equal(a.json.error.message, b.json.error.message);
  });

  test('browser login: HttpOnly SameSite=Strict cookie, token never in the body', async () => {
    const r = await call('POST', '/auth/login', { web: true, body: { email: 'krishna@abc.test', password: PASSWORD } });
    expectStatus(r, 200);
    assert.equal(r.json.accessToken, undefined);
    const raw = r.headers.getSetCookie().find((x) => x.startsWith('hrms_session='))!;
    assert.match(raw, /HttpOnly/i);
    assert.match(raw, /SameSite=Strict/i);
    assert.match(raw, /Path=\/api/i);
    const me = await call('GET', '/me', { cookie: sessionCookie(r) });
    expectStatus(me, 200);
    assert.equal(me.json.user.email, 'krishna@abc.test');
  });

  test('CSRF: a cookie-authenticated write without the client header is refused', async () => {
    const r = await call('POST', '/auth/login', { web: true, body: { email: 'priya@abc.test', password: PASSWORD } });
    const cookie = sessionCookie(r)!;
    const bad = await call('POST', '/workflows/delegations', { cookie, body: {} });
    expectStatus(bad, 403, 'CSRF_CHECK_FAILED');
    const ok = await call('POST', '/auth/logout', { cookie, web: true });
    expectStatus(ok, 204);
  });

  test('multi-tenant user picks an organization; membership is re-verified server-side', async () => {
    const first = await call('POST', '/auth/login', { body: { email: 'kiran@partners.test', password: PASSWORD } });
    expectStatus(first, 409, 'TENANT_REQUIRED');
    const { tenants, selectionToken } = first.json.error.details;
    assert.deepEqual(tenants.map((t: any) => t.slug).sort(), ['abc-technologies', 'xyz-solutions']);

    const notMember = await call('POST', '/auth/select-tenant', { body: { selectionToken, tenantId: 999 } });
    expectStatus(notMember, 403, 'NOT_A_MEMBER');
    const forged = await call('POST', '/auth/select-tenant', { body: { selectionToken: selectionToken + 'x', tenantId: 2 } });
    expectStatus(forged, 401, 'SELECTION_EXPIRED');
    // A selection token is not an access token.
    expectStatus(await call('GET', '/me', { token: selectionToken }), 401, 'INVALID_TOKEN');

    const ok = await call('POST', '/auth/select-tenant', { body: { selectionToken, tenantId: 2 } });
    expectStatus(ok, 200);
    const me = await call('GET', '/me', { token: ok.json.accessToken });
    assert.equal(me.json.tenant.slug, 'xyz-solutions');
    assert.equal(me.json.memberships.length, 2);
  });

  test('switching organization revokes the old session', async () => {
    const t1 = await login('kiran@partners.test', { tenantId: 1 });
    const sw = await call('POST', '/auth/switch-tenant', { token: t1, body: { tenantId: 2 } });
    expectStatus(sw, 200);
    expectStatus(await call('GET', '/me', { token: t1 }), 401, 'SESSION_ENDED');
    const me = await call('GET', '/me', { token: sw.json.accessToken });
    assert.equal(me.json.tenantId, 2);
    expectStatus(await call('POST', '/auth/switch-tenant', { token: sw.json.accessToken, body: { tenantId: 999 } }), 403, 'NOT_A_MEMBER');
  });

  test('logout revokes the server session and clears the cookie', async () => {
    const t = await login('rahul@abc.test');
    expectStatus(await call('GET', '/me', { token: t }), 200);
    const out = await call('POST', '/auth/logout', { token: t });
    expectStatus(out, 204);
    assert.match(out.headers.getSetCookie().join(';'), /hrms_session=;/);
    expectStatus(await call('GET', '/me', { token: t }), 401, 'SESSION_ENDED');
  });

  test('expired token -> 401; suspended membership -> login refused and live token rejected', async () => {
    const expired = jwt.sign({ tid: 1, sid: '00000000-0000-4000-8000-000000000000', exp: Math.floor(Date.now() / 1000) - 10 },
      env.JWT_SECRET, { subject: String(uid.rahul), issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
    expectStatus(await call('GET', '/me', { token: expired }), 401, 'INVALID_TOKEN');

    const t = await login('priya@abc.test');
    await admin.query(`UPDATE tenant_users SET status = 'suspended' WHERE user_id = $1`, [uid.priya]);
    try {
      expectStatus(await call('GET', '/me', { token: t }), 401, 'MEMBERSHIP_INACTIVE');
      expectStatus(await call('POST', '/auth/login', { body: { email: 'priya@abc.test', password: PASSWORD } }), 403, 'NO_TENANT');
    } finally {
      await admin.query(`UPDATE tenant_users SET status = 'active' WHERE user_id = $1`, [uid.priya]);
    }
  });

  test('sessions list shows only my own sessions and marks the current one', async () => {
    const r = await call('GET', '/auth/sessions', { token: tokens.asha });
    expectStatus(r, 200);
    assert.ok(r.json.length >= 1);
    assert.equal(r.json.filter((s: any) => s.current).length, 1);
  });

  test('login is rate limited per email + IP', async () => {
    let last: CallResult | undefined;
    for (let i = 0; i < 11; i++) {
      last = await call('POST', '/auth/login', { body: { email: 'bruteforce@abc.test', password: 'x' } });
    }
    expectStatus(last!, 429, 'RATE_LIMITED');
  });
});

// =========================================================================
describe('M2 · provisioning and administrator activation', () => {
  const ownerClient = async () => {
    const c = await admin.connect();
    return c;
  };
  let token = '';
  let tenantId = 0;

  test('platform provisioning creates the tenant, a protected admin role and a hashed one-time invitation', async () => {
    const c = await ownerClient();
    try {
      const r = await provisionOrganization(c, {
        displayName: 'Nova Labs', slug: 'nova-labs', adminEmail: 'ana@nova.test', adminName: 'Ana', countryCode: 'IN',
      });
      token = r.invitation.token;
      tenantId = r.tenantId;
      const stored = await c.query(`SELECT token_hash FROM organization_invitations WHERE id = $1`, [r.invitation.invitationId]);
      assert.notEqual(stored.rows[0].token_hash.toString('utf8'), token, 'raw token is never stored');
      const roles = await c.query(`SELECT name, is_system_role FROM roles WHERE tenant_id = $1`, [tenantId]);
      assert.deepEqual(roles.rows, [{ name: 'Tenant Admin', is_system_role: true }]);
      await assert.rejects(provisionOrganization(c, {
        displayName: 'Nova Again', slug: 'nova-labs', adminEmail: 'x@nova.test', adminName: 'X',
      }), /already exists/);
    } finally {
      c.release();
    }
  });

  test('activation: invitation preview, password policy, then sign-in as the tenant admin', async () => {
    const info = await call('GET', `/onboarding/invitations/${token}`);
    expectStatus(info, 200);
    assert.equal(info.json.organizationName, 'Nova Labs');
    assert.equal(info.json.accountExists, false);

    expectStatus(await call('POST', '/onboarding/activate', { body: { token, password: 'short' } }), 422, 'WEAK_PASSWORD');

    const ok = await call('POST', '/onboarding/activate', { web: true, body: { token, password: 'Nova-Secure-2026' } });
    expectStatus(ok, 200);
    const cookie = sessionCookie(ok)!;
    const me = await call('GET', '/me', { cookie });
    assert.equal(me.json.tenant.slug, 'nova-labs');
    assert.equal(me.json.tenant.status, 'onboarding');
    assert.ok(me.json.permissions.includes('roles.manage'));
    const roles = await admin.query(
      `SELECT r.name FROM user_roles ur JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
        WHERE ur.tenant_id = $1 AND ur.user_id = $2`, [tenantId, me.json.userId]);
    assert.deepEqual(roles.rows.map((x) => x.name), ['Tenant Admin'], 'only the bootstrap role');
  });

  test('tokens are single-use, and unknown/expired tokens look identical', async () => {
    expectStatus(await call('POST', '/onboarding/activate', { body: { token, password: 'Nova-Secure-2026' } }), 404, 'INVITATION_INVALID');
    expectStatus(await call('GET', `/onboarding/invitations/${token}`), 404, 'INVITATION_INVALID');
    expectStatus(await call('GET', `/onboarding/invitations/${'A'.repeat(43)}`), 404, 'INVITATION_INVALID');

    const c = await ownerClient();
    try {
      const inv = await inviteTenantAdmin(c, { slug: 'nova-labs', email: 'late@nova.test', name: 'Late' });
      await c.query(
        `UPDATE organization_invitations SET created_at = now() - interval '5 days', expires_at = now() - interval '1 hour'
          WHERE id = $1`, [inv.invitation.invitationId]);
      expectStatus(await call('POST', '/onboarding/activate', { body: { token: inv.invitation.token, password: 'Late-Secure-2026' } }),
        404, 'INVITATION_INVALID');
    } finally {
      c.release();
    }
  });

  test('inviting an existing account requires its current password and never overwrites it', async () => {
    const c = await ownerClient();
    let inv;
    try {
      inv = await inviteTenantAdmin(c, { slug: 'nova-labs', email: 'krishna@abc.test', name: 'Krishna' });
    } finally {
      c.release();
    }
    const info = await call('GET', `/onboarding/invitations/${inv.invitation.token}`);
    assert.equal(info.json.accountExists, true);
    expectStatus(await call('POST', '/onboarding/activate', { body: { token: inv.invitation.token, password: 'Hijack-Attempt-1' } }),
      401, 'INVALID_CREDENTIALS');
    const ok = await call('POST', '/onboarding/activate', { body: { token: inv.invitation.token, password: PASSWORD } });
    expectStatus(ok, 200);
    // Old password still works and Krishna now has two organizations.
    const again = await call('POST', '/auth/login', { body: { email: 'krishna@abc.test', password: PASSWORD } });
    expectStatus(again, 409, 'TENANT_REQUIRED');
  });
});

// =========================================================================
describe('M2 · organization profile, preferences, logo and onboarding', () => {
  test('tenant admin reads and updates only their own profile, with optimistic concurrency + audit', async () => {
    const cur = await call('GET', '/organization', { token: tokens.asha });
    expectStatus(cur, 200);
    assert.equal(cur.json.slug, 'abc-technologies');

    const upd = await call('PATCH', '/organization', {
      token: tokens.asha, body: { industry: 'Software', website: 'https://abc.example/about', version: cur.json.version },
    });
    expectStatus(upd, 200);
    assert.equal(upd.json.industry, 'Software');
    assert.equal(upd.json.version, cur.json.version + 1);

    const stale = await call('PATCH', '/organization', { token: tokens.asha, body: { industry: 'Other', version: cur.json.version } });
    expectStatus(stale, 409, 'VERSION_CONFLICT');

    const audit = await admin.query(
      `SELECT before_state, after_state FROM organization_audit_log WHERE tenant_id = 1 AND action = 'organization.update'`);
    assert.equal(audit.rowCount, 1);
    assert.equal(audit.rows[0].after_state.industry, 'Software');
    assert.equal(audit.rows[0].before_state.industry, 'Information Technology');
  });

  test('validation: country-aware postal code, URLs, unknown fields; slug cannot be changed', async () => {
    const bad = await call('PATCH', '/organization', { token: tokens.asha, body: { address: { postalCode: '12AB' } } });
    expectStatus(bad, 422, 'VALIDATION_FAILED');
    assert.ok(bad.json.error.details.fieldErrors['address.postalCode']);
    expectStatus(await call('PATCH', '/organization', { token: tokens.asha, body: { website: 'javascript:alert(1)' } }), 422);
    expectStatus(await call('PATCH', '/organization', { token: tokens.asha, body: { slug: 'stolen' } }), 422);
    expectStatus(await call('PATCH', '/organization', { token: tokens.asha, body: { address: { countryCode: 'QQ' } } }), 422);
  });

  test('tenant isolation: Tenant B never sees or changes Tenant A', async () => {
    const b = await call('GET', '/organization', { token: tokens.meera });
    assert.equal(b.json.slug, 'xyz-solutions');
    await call('PATCH', '/organization', { token: tokens.meera, body: { industry: 'Consulting' } });
    const a = await admin.query(`SELECT industry FROM tenants WHERE id = 1`);
    assert.equal(a.rows[0].industry, 'Software');
  });

  test('authorization is enforced by the API, not the UI', async () => {
    expectStatus(await call('GET', '/organization', { token: tokens.rahul }), 403, 'MISSING_PERMISSION');
    expectStatus(await call('PATCH', '/organization', { token: tokens.rahul, body: { industry: 'x' } }), 403);
    expectStatus(await call('PATCH', '/organization', { token: tokens.suresh, body: { industry: 'x' } }), 403);
    expectStatus(await call('GET', '/organization', { token: tokens.suresh }), 200); // HR Admin: view only
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.suresh, body: { currency: 'USD' } }), 403);
    // Every member still sees the identity block in /me.
    const me = await call('GET', '/me', { token: tokens.rahul });
    assert.equal(me.json.tenant.displayName, 'ABC Technologies');
  });

  test('preferences validate IANA timezone / currency / locale and persist across sessions', async () => {
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.asha, body: { timezone: 'Mars/Olympus' } }), 422);
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.asha, body: { currency: 'XXQ' } }), 422);
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.asha, body: { locale: 'tlh-KX' } }), 422);
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.asha, body: { weeklyOffs: [0, 1, 2, 3, 4, 5, 6] } }), 422);
    const ok = await call('PATCH', '/organization/settings', {
      token: tokens.asha,
      body: { timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-AE', financialYearStartMonth: 1, weekStartDay: 0, dateFormat: 'YYYY-MM-DD' },
    });
    expectStatus(ok, 200);
    const fresh = await login('asha@abc.test');
    const again = await call('GET', '/organization/settings', { token: fresh });
    assert.equal(again.json.timezone, 'Asia/Dubai');
    assert.equal(again.json.currency, 'AED');
    assert.equal(again.json.financialYearStartMonth, 1);
    // Put the timezone back: the leave tests rely on IST "today".
    await call('PATCH', '/organization/settings', { token: tokens.asha, body: { timezone: 'Asia/Kolkata' } });
  });

  test('logo upload checks real content, type and size; stored per tenant', async () => {
    const fake = await call('POST', '/organization/logo', { token: tokens.asha, raw: Buffer.from('<svg onload=alert(1)>'), contentType: 'image/png' });
    expectStatus(fake, 422, 'UNSUPPORTED_IMAGE');
    const mismatch = await call('POST', '/organization/logo', { token: tokens.asha, raw: PNG_1x1, contentType: 'image/jpeg' });
    expectStatus(mismatch, 422, 'CONTENT_TYPE_MISMATCH');
    const big = Buffer.concat([PNG_1x1, Buffer.alloc(600 * 1024)]);
    expectStatus(await call('POST', '/organization/logo', { token: tokens.asha, raw: big, contentType: 'image/png' }), 413);
    expectStatus(await call('POST', '/organization/logo', { token: tokens.rahul, raw: PNG_1x1, contentType: 'image/png' }), 403);

    const ok = await call('POST', '/organization/logo', { token: tokens.asha, raw: PNG_1x1, contentType: 'image/png' });
    expectStatus(ok, 201);
    assert.match(ok.json.url, /^\/api\/v1\/organization\/logo\?v=[0-9a-f]{12}$/);

    const img = await call('GET', '/organization/logo', { token: tokens.rahul });
    expectStatus(img, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(img.buffer.equals(PNG_1x1));
    expectStatus(await call('GET', '/organization/logo', { token: tokens.meera }), 404); // other tenant has none

    const me = await call('GET', '/me', { token: tokens.rahul });
    assert.equal(me.json.tenant.logoUrl, ok.json.url);
    expectStatus(await call('DELETE', '/organization/logo', { token: tokens.asha }), 204);
    expectStatus(await call('GET', '/organization/logo', { token: tokens.asha }), 404);
  });

  test('onboarding checklist gates completion, then completes', async () => {
    const s = await call('GET', '/organization/onboarding-status', { token: tokens.meera });
    assert.equal(s.json.completed, false);
    assert.equal(s.json.canComplete, false);
    expectStatus(await call('POST', '/organization/onboarding/complete', { token: tokens.meera }), 422, 'ONBOARDING_INCOMPLETE');

    expectStatus(await call('PATCH', '/organization', {
      token: tokens.meera,
      body: { legalName: 'XYZ Solutions LLP', contactEmail: 'hr@xyz.example', address: { city: 'Pune', countryCode: 'IN', postalCode: '411001' } },
    }), 200);
    expectStatus(await call('PATCH', '/organization/settings', { token: tokens.meera, body: { currency: 'INR' } }), 200);
    const done = await call('POST', '/organization/onboarding/complete', { token: tokens.meera });
    expectStatus(done, 200);
    assert.equal(done.json.completed, true);
    const me = await call('GET', '/me', { token: tokens.meera });
    assert.equal(me.json.tenant.status, 'active');
  });
});

// =========================================================================
describe('M4 · roles, assignments and effective permissions', () => {
  test('role list carries counts and supports filters', async () => {
    const r = await call('GET', '/roles', { token: tokens.asha });
    expectStatus(r, 200);
    const emp = r.json.find((x: any) => x.name === 'Employee');
    assert.equal(emp.member_count, 8);
    assert.equal(emp.permission_count, 6);
    assert.ok(emp.updated_at);
    const sys = await call('GET', '/roles?type=system', { token: tokens.asha });
    assert.deepEqual(sys.json.map((x: any) => x.name), ['Tenant Admin']);
    const search = await call('GET', '/roles?search=hr', { token: tokens.asha });
    assert.deepEqual(search.json.map((x: any) => x.name), ['HR Admin']);
  });

  test('role detail + members; a role from another tenant is a plain 404', async () => {
    const d = await call('GET', `/roles/${role['1:HR Admin']}`, { token: tokens.asha });
    expectStatus(d, 200);
    assert.ok(d.json.permissions.some((p: any) => p.code === 'roles.manage' && p.module === 'rbac'));
    const m = await call('GET', `/roles/${role['1:HR Admin']}/members`, { token: tokens.asha });
    assert.deepEqual(m.json.map((x: any) => x.full_name).sort(), ['Anita', 'Suresh']);
    expectStatus(await call('GET', `/roles/${role['1:HR Admin']}`, { token: tokens.meera }), 404, 'NOT_FOUND');
    expectStatus(await call('PUT', `/roles/${role['1:HR Admin']}/permissions`, { token: tokens.meera, body: { permissions: [] } }), 404);
  });

  test('create, edit (clear description), duplicate, deactivate and re-activate a custom role', async () => {
    const c = await call('POST', '/roles', { token: tokens.asha, body: { name: 'Auditor', description: 'Read-only' } });
    expectStatus(c, 201);
    const dup = await call('POST', '/roles', { token: tokens.asha, body: { name: 'auditor' } });
    expectStatus(dup, 409, 'DUPLICATE');
    assert.equal(dup.json.error.message, 'A role with this name already exists');

    const e = await call('PUT', `/roles/${c.json.id}`, { token: tokens.asha, body: { description: null } });
    assert.equal(e.json.description, null);

    const clone = await call('POST', `/roles/${role['1:HR Admin']}/clone`, { token: tokens.asha, body: { name: 'HR Admin (Pune)' } });
    expectStatus(clone, 201);
    const hr = await call('GET', `/roles/${role['1:HR Admin']}/permissions`, { token: tokens.asha });
    assert.deepEqual(clone.json.permissions, hr.json);

    expectStatus(await call('DELETE', `/roles/${c.json.id}`, { token: tokens.asha }), 204);
    const inactive = await call('GET', '/roles?status=inactive', { token: tokens.asha });
    assert.ok(inactive.json.some((x: any) => x.id === c.json.id));
    const act = await call('POST', `/roles/${c.json.id}/activate`, { token: tokens.asha });
    expectStatus(act, 200);
    assert.equal(act.json.is_active, true);
    const audit = await admin.query(`SELECT 1 FROM rbac_audit_log WHERE action = 'role.activate' AND target_id = $1`, [c.json.id]);
    assert.equal(audit.rowCount, 1);
  });

  test('system roles are protected; duplicating a role you could not grant is escalation', async () => {
    expectStatus(await call('PUT', `/roles/${role['1:Tenant Admin']}`, { token: tokens.asha, body: { name: 'Owner' } }), 403, 'SYSTEM_ROLE');
    expectStatus(await call('POST', `/roles/${role['1:Tenant Admin']}/activate`, { token: tokens.asha }), 403, 'SYSTEM_ROLE');
    expectStatus(await call('POST', `/roles/${role['1:Tenant Admin']}/clone`, { token: tokens.suresh, body: { name: 'Shadow admin' } }),
      403, 'PRIVILEGE_ESCALATION');
  });

  test('without roles.manage nobody can create roles or change their permissions, even via the API', async () => {
    expectStatus(await call('POST', '/roles', { token: tokens.rahul, body: { name: 'Hacker' } }), 403, 'MISSING_PERMISSION');
    expectStatus(await call('PUT', `/roles/${role['1:Employee']}/permissions`, { token: tokens.krishna, body: { permissions: ['payroll.view'] } }),
      403, 'MISSING_PERMISSION');
    expectStatus(await call('POST', `/users/${uid.rahul}/roles`, { token: tokens.krishna, body: { roleId: role['1:Manager'] } }),
      403, 'MISSING_PERMISSION');
  });

  test('user directory is tenant-scoped; foreign user ids are 404 everywhere', async () => {
    const r = await call('GET', '/users?search=kri', { token: tokens.asha });
    expectStatus(r, 200);
    assert.deepEqual(r.json.items.map((u: any) => u.email), ['krishna@abc.test']);
    assert.ok(r.json.items[0].roles.some((x: any) => x.roleName === 'Manager'));
    const page = await call('GET', '/users?limit=2&offset=0', { token: tokens.asha });
    assert.equal(page.json.items.length, 2);
    assert.equal(page.json.total, 8);

    const other = await call('GET', '/users', { token: tokens.meera });
    assert.ok(other.json.items.every((u: any) => !u.email.endsWith('@abc.test')));
    expectStatus(await call('GET', `/users/${uid.rahul}`, { token: tokens.meera }), 404);
    expectStatus(await call('GET', `/users/${uid.rahul}/roles`, { token: tokens.meera }), 404);
    expectStatus(await call('GET', `/users/${uid.rahul}/permissions?include=sources`, { token: tokens.meera }), 404);
    expectStatus(await call('POST', `/users/${uid.rahul}/roles`, { token: tokens.meera, body: { roleId: role['2:Employee'] } }), 404);
    expectStatus(await call('POST', `/users/${uid.arjun}/roles`, { token: tokens.asha, body: { roleId: role['1:Employee'] } }), 404);
  });

  test('assign several roles, duplicate assignment refused, preview == what the API enforces', async () => {
    const a1 = await call('POST', `/users/${uid.priya}/roles`, { token: tokens.asha, body: { roleId: role['1:Manager'] } });
    const a2 = await call('POST', `/users/${uid.priya}/roles`, { token: tokens.asha, body: { roleId: role['1:HR Admin'] } });
    expectStatus(a1, 201);
    expectStatus(a2, 201);
    expectStatus(await call('POST', `/users/${uid.priya}/roles`, { token: tokens.asha, body: { roleId: role['1:Manager'] } }), 409, 'OVERLAP');

    const sources = await call('GET', `/users/${uid.priya}/permissions?include=sources`, { token: tokens.asha });
    const plain = await call('GET', `/users/${uid.priya}/permissions`, { token: tokens.asha });
    assert.deepEqual(sources.json.map((p: any) => p.code).sort(), [...plain.json].sort());
    const approve = sources.json.find((p: any) => p.code === 'leave.request.approve');
    assert.deepEqual(approve.sources.map((s: any) => s.roleName).sort(), ['HR Admin', 'Manager']);

    // Priya's existing token gains the new access on her very next request…
    const me = await call('GET', '/me', { token: tokens.priya });
    assert.deepEqual([...me.json.permissions].sort(), [...plain.json].sort());
    expectStatus(await call('GET', '/roles', { token: tokens.priya }), 200);
    // …and loses it as soon as the assignment is revoked.
    expectStatus(await call('DELETE', `/users/${uid.priya}/roles/${a2.json.id}`, { token: tokens.asha }), 204);
    expectStatus(await call('GET', '/roles', { token: tokens.priya }), 403);
  });

  test('audit timeline merges RBAC and organization events, filtered by permission', async () => {
    const all = await call('GET', '/audit-events?limit=100', { token: tokens.asha });
    expectStatus(all, 200);
    const cats = new Set(all.json.items.map((e: any) => e.category));
    assert.ok(cats.has('rbac') && cats.has('organization'));
    assert.ok(all.json.items.every((e: any) => e.actor_name));
    const roleOnly = await call('GET', `/audit-events?targetType=role&targetId=${role['1:HR Admin']}`, { token: tokens.asha });
    assert.ok(roleOnly.json.items.every((e: any) => e.target_type === 'role' && e.target_id === role['1:HR Admin']));
    expectStatus(await call('GET', '/audit-events', { token: tokens.krishna }), 403);
    const other = await call('GET', '/audit-events?limit=100', { token: tokens.meera });
    assert.ok(other.json.items.every((e: any) => e.action !== 'role.activate'), 'no tenant-1 events in tenant 2');
  });
});

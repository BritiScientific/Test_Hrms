import { Router } from 'express';
import { z } from 'zod';
import { queryNoTenant, withTenantTx } from '../../config/db';
import { authenticate } from '../../middleware/authenticate';
import { handle, tenantHandler } from '../../middleware/http';
import { loginLimiter, publicTokenLimiter } from '../../middleware/rate-limit';
import { AppError, notFound } from '../../shared/errors';
import { getTenantSummary } from '../organization/organization.service';
import { getUserEffectivePermissions } from '../rbac/rbac.service';
import { verifyDummy, verifyPassword } from './password';
import {
  SESSION_COOKIE, clearSessionCookie, createSession, deliverSession, readCookie, revokeSession,
  signSelectionToken, verifyAccessToken, verifySelectionToken,
} from './session';

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  tenantId: z.number().int().positive().optional(),
});
const SelectTenantBody = z.object({
  selectionToken: z.string().min(10).max(2000),
  tenantId: z.coerce.number().int().positive(),
});
const SwitchTenantBody = z.object({ tenantId: z.coerce.number().int().positive() });

export interface Membership {
  id: number;
  name: string;
  slug: string;
}

export async function listMemberships(userId: number): Promise<Membership[]> {
  const t = await queryNoTenant(`SELECT * FROM auth_user_tenants($1)`, [userId]);
  return t.rows.map((r) => ({ id: Number(r.tenant_id), name: r.tenant_name, slug: r.tenant_slug }));
}

export const authRouter = Router();

/**
 * POST /auth/login. The tenant comes from verified membership, never from an
 * unvalidated header. A multi-tenant user without `tenantId` gets 409
 * TENANT_REQUIRED with the memberships and a 5-minute selection token for
 * POST /auth/select-tenant (so the browser need not keep the password).
 */
authRouter.post('/auth/login', ...loginLimiter, handle(async (req, res) => {
  const body = LoginBody.parse(req.body);
  const u = await queryNoTenant(`SELECT * FROM auth_find_user($1)`, [body.email]);
  const user = u.rows[0];
  const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyDummy(body.password);
  if (!user || !ok || !user.is_active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  const userId = Number(user.user_id);
  const tenants = await listMemberships(userId);
  if (!tenants.length) throw new AppError(403, 'NO_TENANT', 'No active tenant membership');

  let tenantId = body.tenantId;
  if (tenantId === undefined) {
    if (tenants.length > 1) {
      throw new AppError(409, 'TENANT_REQUIRED', 'Choose a tenant', { tenants, selectionToken: signSelectionToken(userId) });
    }
    tenantId = tenants[0].id;
  }
  if (!tenants.some((x) => x.id === tenantId)) throw new AppError(403, 'NOT_A_MEMBER', 'Not a member of that tenant');

  const session = await createSession(req, userId, tenantId);
  deliverSession(req, res, session, { tenantId, tenants });
}));

/** Second step of a multi-tenant login. Membership is re-verified server-side. */
authRouter.post('/auth/select-tenant', publicTokenLimiter, handle(async (req, res) => {
  const body = SelectTenantBody.parse(req.body);
  const userId = verifySelectionToken(body.selectionToken);
  if (!userId) throw new AppError(401, 'SELECTION_EXPIRED', 'Your sign-in has expired. Please sign in again.');
  const tenants = await listMemberships(userId);
  if (!tenants.some((x) => x.id === body.tenantId)) throw new AppError(403, 'NOT_A_MEMBER', 'Not a member of that tenant');
  const session = await createSession(req, userId, body.tenantId);
  deliverSession(req, res, session, { tenantId: body.tenantId, tenants });
}));

/** Switch the signed-in user to another of their organizations (new session, old one revoked). */
authRouter.post('/auth/switch-tenant', authenticate, handle(async (req, res) => {
  const auth = req.auth!;
  const { tenantId } = SwitchTenantBody.parse(req.body);
  const tenants = await listMemberships(auth.userId);
  if (!tenants.some((x) => x.id === tenantId)) throw new AppError(403, 'NOT_A_MEMBER', 'Not a member of that tenant');
  if (auth.sessionId) await withTenantTx(auth.tenantId, (tx) => revokeSession(tx, auth.sessionId!, 'switch_tenant'));
  const session = await createSession(req, auth.userId, tenantId);
  deliverSession(req, res, session, { tenantId, tenants });
}));

/**
 * POST /auth/logout — revokes the server session and clears the cookie.
 * Accepts an expired-but-genuine token so "sign out" always works; always 204.
 */
authRouter.post('/auth/logout', handle(async (req, res) => {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : readCookie(req, SESSION_COOKIE);
  if (token) {
    try {
      const c = verifyAccessToken(token, { ignoreExpiration: true });
      const tenantId = Number(c.tid);
      if (Number.isSafeInteger(tenantId) && typeof c.sid === 'string') {
        await withTenantTx(tenantId, (tx) => revokeSession(tx, c.sid, 'logout'));
      }
    } catch {
      /* forged or malformed: nothing to revoke */
    }
  }
  clearSessionCookie(res);
  res.status(204).end();
}));

/** GET /me — identity, organization and permissions for the shell (UX only; the API re-checks everything). */
authRouter.get('/me', authenticate, tenantHandler(async (tx, auth) => {
  const u = await tx.query(`SELECT id, email, full_name FROM users WHERE id = $1`, [auth.userId]);
  const permissions = await getUserEffectivePermissions(tx, auth.userId);
  const tenant = await getTenantSummary(tx);
  return {
    userId: auth.userId,
    tenantId: auth.tenantId,
    employeeId: auth.employeeId,
    permissions,
    user: { id: auth.userId, email: u.rows[0]?.email ?? null, fullName: u.rows[0]?.full_name ?? null },
    tenant,
    memberships: await listMemberships(auth.userId),
    session: auth.sessionId ? { id: auth.sessionId, expiresAt: auth.sessionExpiresAt } : null,
  };
}));

/** GET /auth/sessions — my live sessions in this organization (Security page). */
authRouter.get('/auth/sessions', authenticate, tenantHandler(async (tx, auth) => {
  const r = await tx.query(
    `SELECT id, created_at, last_seen_at, absolute_expires_at, user_agent, host(ip) AS ip
       FROM auth_sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
      ORDER BY created_at DESC LIMIT 50`,
    [auth.userId],
  );
  return r.rows.map((s) => ({
    id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.absolute_expires_at,
    userAgent: s.user_agent, ip: s.ip, current: s.id === auth.sessionId,
  }));
}));

/** DELETE /auth/sessions/:sid — sign out one of my own sessions. */
authRouter.delete('/auth/sessions/:sid', authenticate, tenantHandler(async (tx, auth, req) => {
  const sid = String(req.params.sid);
  if (!/^[0-9a-f-]{36}$/i.test(sid)) throw new AppError(400, 'BAD_ID', 'Invalid session id');
  const r = await tx.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout'
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [sid, auth.userId],
  );
  if (!r.rowCount) throw notFound('Session');
}));

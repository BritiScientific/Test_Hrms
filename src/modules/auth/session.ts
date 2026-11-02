import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { withTenantTx, type Tx } from '../../config/db';

/**
 * Session strategy (Milestone 1):
 *  - Every login creates an auth_sessions row. The access JWT carries its id
 *    (`sid`), and authenticate() checks the row on every request, so logout,
 *    tenant switch and admin revocation take effect immediately.
 *  - Browser (the SPA identifies itself with `X-HRMS-Client: web`): the token
 *    is delivered ONLY as an HttpOnly, SameSite=Strict cookie and never
 *    appears in a response body, so page JavaScript cannot read it. While the
 *    user is active the cookie is re-issued (sliding idle timeout), capped by
 *    the session's absolute lifetime.
 *  - Other clients (Postman, scripts, tests) keep receiving a bearer token.
 *  - CSRF: cookie-authenticated unsafe requests must carry X-HRMS-Client. A
 *    cross-site form cannot set custom headers, and no CORS is configured.
 *  - Permissions are NOT in the token; they are loaded fresh per request, so
 *    role changes apply on the user's very next request.
 */

export const SESSION_COOKIE = 'hrms_session';
export const CLIENT_HEADER = 'x-hrms-client';
export const COOKIE_PATH = '/api';

export interface AccessTokenClaims {
  sub: string; // user id
  tid: number; // tenant id the token was issued for (membership verified at login)
  sid: string; // auth_sessions.id
}

export const isWebClient = (req: Request) => req.header(CLIENT_HEADER) === 'web';

export function signAccessToken(userId: number, tenantId: number, sessionId: string, ttlSeconds = env.ACCESS_TOKEN_TTL_SECONDS): string {
  return jwt.sign({ tid: tenantId, sid: sessionId } satisfies Omit<AccessTokenClaims, 'sub'>, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: Math.max(1, Math.floor(ttlSeconds)),
  });
}

export function verifyAccessToken(token: string, opts: { ignoreExpiration?: boolean } = {}) {
  return jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    ignoreExpiration: opts.ignoreExpiration,
  }) as unknown as AccessTokenClaims & { exp: number };
}

// --------------------------------------------- tenant-selection token -----
// Issued when a multi-tenant user logs in without choosing a tenant, so the
// browser never has to keep the password around for a second login call.
const SELECT_AUDIENCE = () => `${env.JWT_AUDIENCE}:tenant-select`;

export function signSelectionToken(userId: number): string {
  return jwt.sign({ typ: 'tenant_select' }, env.JWT_SECRET, {
    algorithm: 'HS256', subject: String(userId), issuer: env.JWT_ISSUER, audience: SELECT_AUDIENCE(), expiresIn: 300,
  });
}

export function verifySelectionToken(token: string): number | null {
  try {
    const c = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'], issuer: env.JWT_ISSUER, audience: SELECT_AUDIENCE(),
    }) as jwt.JwtPayload;
    const id = Number(c.sub);
    return c.typ === 'tenant_select' && Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ cookies -----

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, absoluteExpiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: env.COOKIE_SECURE,
    path: COOKIE_PATH,
    expires: absoluteExpiresAt,
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', secure: env.COOKIE_SECURE, path: COOKIE_PATH });
}

// ----------------------------------------------------------- sessions -----

export interface IssuedSession {
  sessionId: string;
  token: string;
  absoluteExpiresAt: Date;
}

export async function createSession(req: Request, userId: number, tenantId: number): Promise<IssuedSession> {
  const sessionId = randomUUID();
  const absoluteExpiresAt = new Date(Date.now() + env.SESSION_ABSOLUTE_TTL_HOURS * 3600_000);
  await withTenantTx(tenantId, (tx) =>
    tx.query(
      `INSERT INTO auth_sessions (tenant_id, id, user_id, absolute_expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, sessionId, userId, absoluteExpiresAt, (req.header('user-agent') ?? '').slice(0, 300) || null, req.ip ?? null],
    ),
  );
  return { sessionId, token: signAccessToken(userId, tenantId, sessionId), absoluteExpiresAt };
}

/** Deliver a new session: cookie for the SPA, bearer token for everything else. */
export function deliverSession(req: Request, res: Response, s: IssuedSession, body: Record<string, unknown>) {
  if (isWebClient(req)) {
    setSessionCookie(res, s.token, s.absoluteExpiresAt);
    return res.json({ ...body, session: { expiresAt: s.absoluteExpiresAt } });
  }
  return res.json({ accessToken: s.token, tokenType: 'Bearer', ...body });
}

export async function revokeSession(tx: Tx, sessionId: string, reason: 'logout' | 'switch_tenant' | 'admin') {
  await tx.query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

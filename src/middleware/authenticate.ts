import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { withTenantTx } from '../config/db';
import { AppError } from '../shared/errors';
import { loadAuthContext } from '../modules/rbac/rbac.service';
import {
  CLIENT_HEADER, SESSION_COOKIE, readCookie, setSessionCookie, signAccessToken, verifyAccessToken,
  type AccessTokenClaims,
} from '../modules/auth/session';

export { signAccessToken, type AccessTokenClaims };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Verifies the JWT (bearer header, or the HttpOnly session cookie), checks
 * that its server-side session is still live, then loads membership, employee
 * link and permissions FRESH from the database on every request. Permissions
 * are deliberately NOT embedded in the token: a revoked role must stop working
 * immediately, not when the token expires.
 */
export const authenticate: RequestHandler = (req, res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, bearer] = header.split(' ');
  let token: string | undefined;
  let viaCookie = false;
  if (scheme === 'Bearer' && bearer) {
    token = bearer;
  } else {
    token = readCookie(req, SESSION_COOKIE);
    viaCookie = !!token;
  }
  if (!token) return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));

  // CSRF: a cookie rides along on cross-site requests; a custom header cannot.
  if (viaCookie && !SAFE_METHODS.has(req.method) && req.header(CLIENT_HEADER) !== 'web') {
    return next(new AppError(403, 'CSRF_CHECK_FAILED', 'Missing client header'));
  }

  let claims: AccessTokenClaims & { exp: number };
  try {
    claims = verifyAccessToken(token);
  } catch {
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }

  const userId = Number(claims.sub);
  const tenantId = Number(claims.tid);
  const sessionId = typeof claims.sid === 'string' ? claims.sid : '';
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(tenantId) || !/^[0-9a-f-]{36}$/i.test(sessionId)) {
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid token claims'));
  }

  withTenantTx(tenantId, async (tx) => {
    const s = await tx.query(
      `SELECT absolute_expires_at, revoked_at FROM auth_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    const session = s.rows[0];
    if (!session || session.revoked_at || new Date(session.absolute_expires_at) <= new Date()) {
      throw new AppError(401, 'SESSION_ENDED', 'Your session has ended. Please sign in again.');
    }
    const ctx = await loadAuthContext(tx, tenantId, userId, req.requestId);
    if (!ctx) throw new AppError(401, 'MEMBERSHIP_INACTIVE', 'Account is not active in this tenant');

    // Sliding idle timeout for the browser: renew once half the TTL is used.
    const absolute = new Date(session.absolute_expires_at);
    const secondsLeft = claims.exp - Date.now() / 1000;
    if (viaCookie && secondsLeft < env.ACCESS_TOKEN_TTL_SECONDS / 2) {
      const ttl = Math.min(env.ACCESS_TOKEN_TTL_SECONDS, (absolute.getTime() - Date.now()) / 1000);
      setSessionCookie(res, signAccessToken(userId, tenantId, sessionId, ttl), absolute);
      await tx.query(`UPDATE auth_sessions SET last_seen_at = now() WHERE id = $1`, [sessionId]);
    }
    return { ...ctx, sessionId, sessionExpiresAt: absolute.toISOString() };
  })
    .then((ctx) => {
      req.auth = ctx;
      next();
    })
    .catch(next);
};

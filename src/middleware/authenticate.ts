import jwt from 'jsonwebtoken';
import type { RequestHandler } from 'express';
import { env } from '../config/env';
import { withTenantTx } from '../config/db';
import { AppError } from '../shared/errors';
import { loadAuthContext } from '../modules/rbac/rbac.service';

export interface AccessTokenClaims {
  sub: string; // user id
  tid: number; // tenant id the token was issued for (membership verified at login)
}

export function signAccessToken(userId: number, tenantId: number): string {
  return jwt.sign({ tid: tenantId } satisfies Omit<AccessTokenClaims, 'sub'>, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: String(userId),
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Verifies the JWT, then loads membership, employee link and permissions
 * FRESH from the database on every request. Permissions are deliberately NOT
 * embedded in the token: a revoked role must stop working immediately, not
 * when the token expires. (Add a short-TTL cache keyed by tenant+user if the
 * extra query ever matters; invalidate it on RBAC changes.)
 */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization') ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return next(new AppError(401, 'UNAUTHENTICATED', 'Missing bearer token'));
  }

  let claims: AccessTokenClaims;
  try {
    claims = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    }) as unknown as AccessTokenClaims;
  } catch {
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid or expired token'));
  }

  const userId = Number(claims.sub);
  const tenantId = Number(claims.tid);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(tenantId)) {
    return next(new AppError(401, 'INVALID_TOKEN', 'Invalid token claims'));
  }

  withTenantTx(tenantId, (tx) => loadAuthContext(tx, tenantId, userId, req.requestId))
    .then((ctx) => {
      if (!ctx) throw new AppError(401, 'MEMBERSHIP_INACTIVE', 'Account is not active in this tenant');
      req.auth = ctx;
      next();
    })
    .catch(next);
};

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { withTenantTx, type Tx } from '../config/db';
import { AppError } from '../shared/errors';
import type { AuthContext } from '../shared/types';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      requestId?: string;
    }
  }
}

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.header('x-request-id');
  req.requestId = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
};

/** Wrap an async handler so rejections reach the error middleware. */
export const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res).catch(next);
  };

/**
 * Run a handler inside a tenant-scoped transaction for the authenticated user.
 * The ONLY way route code touches the database.
 */
export const tenantHandler =
  <T>(fn: (tx: Tx, auth: AuthContext, req: Request) => Promise<T>, status = 200): RequestHandler =>
  (req, res, next) => {
    const auth = req.auth;
    if (!auth) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    withTenantTx(auth.tenantId, (tx) => fn(tx, auth, req))
      .then((body) => (body === undefined ? res.status(204).end() : res.status(status).json(body)))
      .catch(next);
  };

export const idParam = (req: Request, name = 'id'): number => {
  const v = Number(req.params[name]);
  if (!Number.isSafeInteger(v) || v <= 0) throw new AppError(400, 'BAD_ID', `Invalid ${name}`);
  return v;
};

export type { NextFunction };

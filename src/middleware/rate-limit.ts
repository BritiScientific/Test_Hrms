import type { Request, RequestHandler } from 'express';
import { env } from '../config/env';
import { AppError } from '../shared/errors';

/**
 * Small in-memory fixed-window limiter for the unauthenticated endpoints
 * (login, tenant selection, activation). Per process: behind several API
 * instances put a shared limiter (gateway / Redis) in front as well.
 */
export function rateLimit(opts: { name: string; windowMs: number; max: number; key: (req: Request) => string }): RequestHandler {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = Date.now();

  return (req, res, next) => {
    if (env.RATE_LIMIT_DISABLED) return next();
    const now = Date.now();
    if (now - lastSweep > opts.windowMs) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      lastSweep = now;
    }
    const key = `${opts.name}:${opts.key(req)}`;
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    if (entry.count > opts.max) {
      res.setHeader('retry-after', String(Math.ceil((entry.resetAt - now) / 1000)));
      return next(new AppError(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.'));
    }
    next();
  };
}

const ip = (req: Request) => req.ip ?? 'unknown';
const email = (req: Request) =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '-';

/** 10 attempts per email+IP and 100 per IP, per 15 minutes. */
export const loginLimiter: RequestHandler[] = [
  rateLimit({ name: 'login-ip', windowMs: 15 * 60_000, max: 100, key: ip }),
  rateLimit({ name: 'login-email', windowMs: 15 * 60_000, max: 10, key: (r) => `${ip(r)}|${email(r)}` }),
];

export const publicTokenLimiter = rateLimit({ name: 'token', windowMs: 15 * 60_000, max: 30, key: ip });

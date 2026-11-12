function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

/** Fails fast on a missing/empty password or database name. Never echoes the URL (it holds the password). */
function validateDatabaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL (expected postgres://user:password@host:port/database)');
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw new Error('DATABASE_URL must use the postgres:// scheme');
  if (!u.username) throw new Error('DATABASE_URL has no user');
  if (!u.password) throw new Error('DATABASE_URL has an empty or missing password');
  if (!u.hostname) throw new Error('DATABASE_URL has no host');
  if (u.pathname.length <= 1) throw new Error('DATABASE_URL has no database name');
  return raw;
}

const NODE_ENV =process.env.NODE_ENV ?? 'development';

export const env = {
  NODE_ENV,
  PORT: Number(process.env.PORT ?? 4000),
  // Runtime connection MUST use the non-owner, NOBYPASSRLS role (hrms_app).
  // No fallback: a default password would let the API connect with credentials
  // that are not in .env. Validated (user, password, database) before the pool exists.
  DATABASE_URL: validateDatabaseUrl(required('DATABASE_URL')),
  JWT_SECRET: required('JWT_SECRET', NODE_ENV === 'production' ? undefined : 'dev-only-secret-change-me'),
  JWT_ISSUER: process.env.JWT_ISSUER ?? 'hrms-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'hrms-web',
  /** Access-token lifetime = idle timeout. The browser cookie slides while the user is active. */
  ACCESS_TOKEN_TTL_SECONDS: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
  /** Hard cap on a session regardless of activity. */
  SESSION_ABSOLUTE_TTL_HOURS: Number(process.env.SESSION_ABSOLUTE_TTL_HOURS ?? 12),
  /** Secure cookies need HTTPS; default on in production only. */
  COOKIE_SECURE: (process.env.COOKIE_SECURE ?? (NODE_ENV === 'production' ? 'true' : 'false')) === 'true',
  /** Public URL of the web app, used to build activation links. */
  APP_BASE_URL: process.env.APP_BASE_URL ?? 'http://localhost:5173',
  /** Organization shown on /careers when the URL carries no ?org=. Optional (single-organization deployments). */
  CAREERS_DEFAULT_TENANT_SLUG: process.env.CAREERS_DEFAULT_TENANT_SLUG?.trim().toLowerCase() || undefined,
  /** Set to "true" only for local load testing. */
  RATE_LIMIT_DISABLED: process.env.RATE_LIMIT_DISABLED === 'true',
};

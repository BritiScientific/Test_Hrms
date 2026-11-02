function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

const NODE_ENV = process.env.NODE_ENV ?? 'development';

export const env = {
  NODE_ENV,
  PORT: Number(process.env.PORT ?? 4000),
  // Runtime connection MUST use the non-owner, NOBYPASSRLS role (hrms_app).
  DATABASE_URL: required('DATABASE_URL', 'postgres://hrms_app:change_me_app@localhost:5432/hrms'),
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
  /** Set to "true" only for local load testing. */
  RATE_LIMIT_DISABLED: process.env.RATE_LIMIT_DISABLED === 'true',
};

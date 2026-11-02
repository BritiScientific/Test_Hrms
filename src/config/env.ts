function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') throw new Error(`Missing environment variable ${name}`);
  return v;
}

export const env = {
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  PORT: Number(process.env.PORT ?? 4000),
  // Runtime connection MUST use the non-owner, NOBYPASSRLS role (hrms_app).
  DATABASE_URL: required('DATABASE_URL', 'postgres://hrms_app:change_me_app@localhost:5432/hrms'),
  JWT_SECRET: required('JWT_SECRET', process.env.NODE_ENV === 'production' ? undefined : 'dev-only-secret-change-me'),
  JWT_ISSUER: process.env.JWT_ISSUER ?? 'hrms-api',
  JWT_AUDIENCE: process.env.JWT_AUDIENCE ?? 'hrms-web',
  ACCESS_TOKEN_TTL_SECONDS: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900),
};

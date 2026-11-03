/** Only same-app relative paths are accepted as return targets (no open redirects). */
export function safeReturnTo(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return fallback;
  if (/^\/(login|select-organization|session-expired|activate)\b/.test(value)) return fallback;
  return value;
}

/** Where to go right after signing in. */
export function landingPath(me: { tenant: { onboardingCompleted: boolean }; permissions: string[] }, returnTo?: string | null) {
  if (!me.tenant.onboardingCompleted && me.permissions.includes('organization.update')) return '/onboarding';
  return safeReturnTo(returnTo);
}

/** Right after activating: admins finish organization setup, new employees complete their own profile. */
export function postActivationPath(me: Parameters<typeof landingPath>[0] & { employee?: { profileCompleted: boolean } | null }) {
  const first = landingPath(me);
  if (first === '/onboarding') return first;
  if (me.employee && !me.employee.profileCompleted) return '/my-profile?welcome=1';
  return first;
}

/**
 * Remembers the last route visited in the main portal, so the Settings back
 * arrow returns there (falls back to /dashboard after a reload or deep link).
 */
let lastPortalPath: string | null = null;
export const rememberPortalPath = (path: string) => {
  lastPortalPath = path;
};
export const portalReturnPath = () => lastPortalPath ?? '/dashboard';

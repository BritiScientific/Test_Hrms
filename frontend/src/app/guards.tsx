import { useEffect, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useSearchParams } from 'react-router';
import { Loader2 } from 'lucide-react';
import { ME_KEY, useAuth } from './providers/AuthProvider';
import { AccessDenied } from '@/modules/auth/UnauthorizedPage';
import { landingPath } from '@/utils/navigation';

export function FullPageLoader({ label = 'Loading your workspace' }: { label?: string }) {
  return (
    <div role="status" className="flex min-h-dvh items-center justify-center bg-canvas text-muted">
      <Loader2 className="mr-2 size-5 animate-spin text-primary" aria-hidden />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

/** Signed-in area: anonymous visitors go to /login, lost sessions to /session-expired (with a safe return path). */
export function RequireAuth() {
  const { status } = useAuth();
  const loc = useLocation();
  const qc = useQueryClient();
  // Permissions and session validity are re-checked as the user moves around,
  // so revoked access shows up promptly in the UI (the API enforces it anyway).
  useEffect(() => {
    const updated = qc.getQueryState(ME_KEY)?.dataUpdatedAt ?? 0;
    if (status === 'authenticated' && Date.now() - updated > 30_000) qc.invalidateQueries({ queryKey: ME_KEY });
  }, [loc.pathname, status, qc]);
  const returnTo = encodeURIComponent(loc.pathname + loc.search);
  if (status === 'loading') return <FullPageLoader />;
  if (status === 'expired') return <Navigate to={`/session-expired?returnTo=${returnTo}`} replace />;
  if (status === 'anonymous') return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  return <Outlet />;
}

/** Login/activation screens: a signed-in user is sent into the portal. */
export function GuestOnly() {
  const { status, me } = useAuth();
  const [params] = useSearchParams();
  if (status === 'loading') return <FullPageLoader label="Checking your session" />;
  if (status === 'authenticated' && me) return <Navigate to={landingPath(me, params.get('returnTo'))} replace />;
  return <Outlet />;
}

/**
 * Hides a screen the user cannot use. This is UX only — the API checks the
 * same permission on every request and is the real enforcement point.
 */
export function RequirePermission({ anyOf, children }: { anyOf: readonly string[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(...anyOf)) return <AccessDenied inline required={anyOf} />;
  return <>{children}</>;
}

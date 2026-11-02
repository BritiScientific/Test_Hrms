import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { ApiError } from '@/services/api-client';
import { authApi } from '@/services/auth-api';
import type { TenantRequiredDetails } from '@/types/api';
import { usePageTitle } from '@/hooks/usePageTitle';
import { landingPath } from '@/utils/navigation';
import { cn } from '@/utils/cn';

type State = TenantRequiredDetails & { email: string; returnTo?: string | null };

/**
 * Shown only when the account belongs to several organizations. The list and
 * the 5-minute selection token come from the login response; the server
 * re-verifies membership when an organization is chosen.
 */
export default function SelectOrganizationPage() {
  usePageTitle('Choose organization');
  const state = useLocation().state as State | null;
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!state?.selectionToken || !state.tenants?.length) return <Navigate to="/login" replace />;

  const choose = async (tenantId: number) => {
    setPending(tenantId);
    setError(null);
    try {
      await authApi.selectTenant(state.selectionToken, tenantId);
      const me = await refresh();
      if (me) navigate(landingPath(me, state.returnTo), { replace: true });
    } catch (e) {
      setPending(null);
      if (e instanceof ApiError && e.code === 'SELECTION_EXPIRED') {
        navigate('/login', { replace: true });
        return;
      }
      setError(e instanceof ApiError && e.code === 'NOT_A_MEMBER'
        ? 'You are no longer a member of that organization.'
        : 'Could not open that organization. Please try again.');
    }
  };

  return (
    <div>
      <Link to="/login" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> Back to sign in
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Choose an organization</h1>
      <p className="mt-1.5 text-sm text-muted">
        <span className="font-medium text-ink">{state.email}</span> has access to {state.tenants.length} organizations.
      </p>
      {error && <div className="mt-5"><InlineAlert>{error}</InlineAlert></div>}
      <ul className="mt-6 space-y-2.5" aria-label="Your organizations">
        {state.tenants.map((t) => (
          <li key={t.id}>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => choose(t.id)}
              aria-busy={pending === t.id}
              className={cn(
                'flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3.5 text-left shadow-card transition',
                'hover:border-primary/40 hover:bg-primary-soft/40 disabled:opacity-60',
              )}
            >
              <Avatar name={t.name} square size="lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{t.name}</span>
                <span className="block truncate text-xs text-muted">{t.slug}</span>
              </span>
              <ChevronRight className={cn('size-5 text-slate-400', pending === t.id && 'animate-pulse text-primary')} aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

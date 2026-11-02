import { Link, NavLink, useMatches, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Check, ChevronRight, LogOut, Menu as MenuIcon, PanelLeftClose, PanelLeftOpen, Settings, ShieldCheck } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { authApi } from '@/services/auth-api';
import { cn } from '@/utils/cn';
import { landingPath } from '@/utils/navigation';
import { Avatar } from '../ui/Avatar';
import { Menu, type MenuItem } from '../ui/Menu';
import { useToast } from '../ui/Toast';

export interface Crumb {
  label: string;
  to?: string;
}

/** Breadcrumbs come from each route's `handle.crumb`. */
export function useCrumbs(): Crumb[] {
  const matches = useMatches();
  return matches
    .map((m): Crumb | null => {
      const h = m.handle as { crumb?: string; crumbTo?: string } | undefined;
      return h?.crumb ? { label: h.crumb, to: h.crumbTo ?? m.pathname } : null;
    })
    .filter((c): c is Crumb => !!c);
}

export function Topbar({ onOpenNav, collapsed, onToggleCollapsed, inSettings }: {
  onOpenNav: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  inSettings: boolean;
}) {
  const crumbs = useCrumbs();
  const current = crumbs[crumbs.length - 1];

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-surface/80 sm:gap-3 sm:px-5 lg:px-6">
      <button
        type="button"
        onClick={onOpenNav}
        className="inline-flex size-10 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden"
        aria-label="Open navigation"
      >
        <MenuIcon className="size-5" aria-hidden />
      </button>
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="hidden size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-ink lg:inline-flex"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
      >
        {collapsed ? <PanelLeftOpen className="size-[18px]" aria-hidden /> : <PanelLeftClose className="size-[18px]" aria-hidden />}
      </button>

      <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
        {/* Phones: current page only. Larger screens: full trail. */}
        <p className="truncate text-sm font-semibold text-ink sm:hidden">{current?.label}</p>
        <ol className="hidden min-w-0 items-center gap-1.5 text-sm sm:flex">
          {crumbs.map((c, i) => (
            <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-slate-300" aria-hidden />}
              {i < crumbs.length - 1 && c.to ? (
                <Link to={c.to} className="truncate text-muted hover:text-ink">{c.label}</Link>
              ) : (
                <span className="truncate font-medium text-ink" aria-current="page">{c.label}</span>
              )}
            </li>
          ))}
        </ol>
      </nav>

      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <OrganizationMenu />
        <NavLink
          to="/settings"
          className={cn(
            'inline-flex size-10 items-center justify-center rounded-lg hover:bg-slate-100',
            inSettings ? 'bg-primary-soft text-primary' : 'text-slate-500 hover:text-ink',
          )}
          aria-label="Settings"
          title="Settings"
        >
          <Settings className="size-5" aria-hidden />
        </NavLink>
        <UserMenu />
      </div>
    </header>
  );
}

function OrganizationMenu() {
  const me = useMe();
  const { refresh, canAny } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { notify } = useToast();

  const switchTo = async (tenantId: number, name: string) => {
    try {
      await authApi.switchTenant(tenantId);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      const fresh = await refresh();
      notify({ tone: 'success', title: `Switched to ${name}` });
      if (fresh) navigate(landingPath(fresh), { replace: true });
    } catch (e) {
      notify({ tone: 'error', title: 'Could not switch organization', description: (e as Error).message });
    }
  };

  const items: MenuItem[] = me.memberships.map((m) => ({
    key: `t-${m.id}`,
    label: m.name,
    icon: m.id === me.tenantId ? <Check /> : <Building2 />,
    disabled: m.id === me.tenantId,
    onSelect: () => switchTo(m.id, m.name),
  }));
  if (canAny('organization.view', 'organization.update')) {
    items.push({ key: 'profile', label: 'Organization profile', icon: <Settings />, onSelect: () => navigate('/settings/organization/profile') });
  }

  return (
    <Menu
      label="Organization"
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{me.tenant.displayName}</p>
          <p className="truncate text-xs text-muted">
            {me.memberships.length > 1 ? 'Switch organization' : me.tenant.legalName ?? me.tenant.slug}
          </p>
        </div>
      }
      items={items}
      trigger={(p) => (
        <button
          {...p}
          type="button"
          className="flex h-10 max-w-[13rem] items-center gap-2 rounded-lg px-1.5 text-left hover:bg-slate-100 sm:border sm:border-line sm:px-2"
          aria-label={`Organization: ${me.tenant.displayName}`}
        >
          <Avatar name={me.tenant.displayName} src={me.tenant.logoUrl} square size="sm" />
          <span className="hidden truncate text-sm font-medium text-ink md:block">{me.tenant.displayName}</span>
        </button>
      )}
    />
  );
}

function UserMenu() {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  return (
    <Menu
      label="Account"
      header={
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{me.user.fullName}</p>
          <p className="truncate text-xs text-muted">{me.user.email}</p>
        </div>
      }
      items={[
        { key: 'security', label: 'Security & sessions', icon: <ShieldCheck />, onSelect: () => navigate('/settings/security') },
        {
          key: 'logout', label: 'Sign out', icon: <LogOut />, tone: 'danger',
          onSelect: async () => {
            await logout();
            navigate('/login', { replace: true });
          },
        },
      ]}
      trigger={(p) => (
        <button {...p} type="button" className="rounded-full p-0.5 hover:ring-4 hover:ring-slate-100" aria-label={`Account: ${me.user.fullName}`}>
          <Avatar name={me.user.fullName} size="md" />
        </button>
      )}
    />
  );
}

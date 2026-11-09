import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { ArrowLeft, ChevronDown, LogOut } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { cn } from '@/utils/cn';
import { Avatar } from '../ui/Avatar';
import { Badge } from '../ui/Badge';
import {
  MAIN_NAV, SETTINGS_NAV, SETTINGS_UPCOMING, UPCOMING_MODULES, visibleGroups, type NavGroup, type UpcomingItem,
} from './nav-config';

export type SidebarVariant = 'main' | 'settings';

export function Sidebar({ variant, collapsed = false, onNavigate, onBack }: {
  variant: SidebarVariant;
  collapsed?: boolean;
  onNavigate?: () => void;
  onBack?: () => void;
}) {
  const { canAny } = useAuth();
  const me = useMe();
  const groups = visibleGroups(variant === 'main' ? MAIN_NAV : SETTINGS_NAV, canAny, !!me.employee);
  const upcoming = variant === 'main' ? UPCOMING_MODULES : SETTINGS_UPCOMING;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className={cn('flex h-16 shrink-0 items-center gap-3 border-b border-line', collapsed ? 'justify-center px-2' : 'px-4')}>
        {variant === 'main' ? (
          <>
            <Avatar name={me.tenant.displayName} src={me.tenant.logoUrl} square size="md" />
            {!collapsed && (
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink">{me.tenant.displayName}</p>
                <p className="text-xs text-muted">HRMS Portal</p>
              </div>
            )}
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-line text-slate-600 hover:bg-slate-50 hover:text-ink"
              aria-label="Back to the portal"
              title="Back"
            >
              <ArrowLeft className="size-4" aria-hidden />
            </button>
            {!collapsed && (
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Settings</p>
                <p className="truncate text-xs text-muted">{me.tenant.displayName}</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Navigation */}
      <nav aria-label={variant === 'main' ? 'Main navigation' : 'Settings navigation'} className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {groups.map((g, gi) => <NavSection key={gi} group={g} collapsed={collapsed} onNavigate={onNavigate} />)}
        <UpcomingSection items={upcoming} collapsed={collapsed} />
      </nav>

      <SidebarFooter collapsed={collapsed} onNavigate={onNavigate} />
    </div>
  );
}

function NavSection({ group, collapsed, onNavigate }: { group: NavGroup; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <div className="mb-5">
      {group.label && !collapsed && (
        <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">{group.label}</p>
      )}
      <ul className="space-y-0.5">
        {group.items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end}
              onClick={onNavigate}
              title={collapsed ? item.label : undefined}
              aria-label={collapsed ? item.label : undefined}
              className={({ isActive }) => cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors pointer-coarse:py-2.5',
                collapsed && 'justify-center px-0',
                isActive ? 'bg-primary-soft text-primary-dark' : 'text-slate-600 hover:bg-slate-100 hover:text-ink',
              )}
            >
              {({ isActive }) => (
                <>
                  <item.icon className={cn('size-[18px] shrink-0', isActive ? 'text-primary' : 'text-slate-400 group-hover:text-slate-600')} aria-hidden />
                  {!collapsed && <span className="min-w-0 leading-snug">{item.label}</span>}
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  );
}

function UpcomingSection({ items, collapsed }: { items: UpcomingItem[]; collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  if (!items.length || collapsed) return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold tracking-wider text-slate-400 uppercase hover:text-slate-600"
      >
        Coming later
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5" aria-label="Modules not yet available">
          {items.map((m) => (
            <li
              key={m.label}
              aria-disabled="true"
              className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400"
            >
              <m.icon className="size-[18px] shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{m.label}</span>
              <Badge tone="neutral" className="text-[10px]">Soon</Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SidebarFooter({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const me = useMe();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const signOut = async () => {
    onNavigate?.();
    await logout();
    navigate('/login', { replace: true });
  };
  return (
    <div className={cn('safe-bottom shrink-0 border-t border-line pt-3', collapsed ? 'px-2' : 'px-3')}>
      <div className={cn('flex items-center gap-3', collapsed && 'flex-col')}>
        <Avatar name={me.user.fullName} size="md" />
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">{me.user.fullName}</p>
            <p className="truncate text-xs text-muted">{me.user.email}</p>
          </div>
        )}
        <button
          type="button"
          onClick={signOut}
          className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-danger"
          aria-label="Sign out"
          title="Sign out"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

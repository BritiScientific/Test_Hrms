import {
  BriefcaseBusiness, Building2, CalendarCheck, CalendarDays, ChartNoAxesCombined, ChartPie, GraduationCap, History,
  KeyRound, LayoutDashboard, ShieldCheck, SlidersHorizontal, UserCog, Users, Wallet, type LucideIcon,
} from 'lucide-react';
import { PERMS } from '@/app/providers/AuthProvider';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Shown only when the user holds at least one of these (UX only; the API enforces). */
  anyOf?: readonly string[];
  end?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

export interface UpcomingItem {
  label: string;
  icon: LucideIcon;
}

export const MAIN_NAV: NavGroup[] = [
  {
    items: [{ label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Organization', to: '/settings/organization/profile', icon: Building2, anyOf: PERMS.orgProfile },
      { label: 'Roles & access', to: '/settings/access/roles', icon: ShieldCheck, anyOf: PERMS.rolesView },
    ],
  },
];

/**
 * Future modules from the product vision. Rendered as clearly unavailable
 * ("Coming later"), never as working links.
 */
export const UPCOMING_MODULES: UpcomingItem[] = [
  { label: 'Employee Management', icon: Users },
  { label: 'Attendance Management', icon: CalendarCheck },
  { label: 'Leave Management', icon: CalendarDays },
  { label: 'Payroll Management', icon: Wallet },
  { label: 'Recruitment Management', icon: BriefcaseBusiness },
  { label: 'Performance Management', icon: ChartNoAxesCombined },
  { label: 'Training & Development', icon: GraduationCap },
  { label: 'Reports & Analytics', icon: ChartPie },
];

export const SETTINGS_NAV: NavGroup[] = [
  {
    label: 'Organization',
    items: [
      { label: 'Organization profile', to: '/settings/organization/profile', icon: Building2, anyOf: PERMS.orgProfile },
      { label: 'Organization settings', to: '/settings/organization/preferences', icon: SlidersHorizontal, anyOf: PERMS.orgSettings },
    ],
  },
  {
    label: 'Access control',
    items: [
      { label: 'Role management', to: '/settings/access/roles', icon: ShieldCheck, anyOf: PERMS.rolesView },
      { label: 'Permission management', to: '/settings/access/permissions', icon: KeyRound, anyOf: PERMS.rolesView },
      { label: 'Role assignment', to: '/settings/access/assignments', icon: UserCog, anyOf: PERMS.rolesView },
    ],
  },
  {
    label: 'Security',
    items: [{ label: 'Security & audit', to: '/settings/security', icon: History }],
  },
];

export const SETTINGS_UPCOMING: UpcomingItem[] = [{ label: 'Employee & user administration', icon: Users }];

export function visibleGroups(groups: NavGroup[], canAny: (...c: string[]) => boolean): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.anyOf || canAny(...i.anyOf)) }))
    .filter((g) => g.items.length > 0);
}

/** First settings page this user may open (target of /settings). */
export function firstSettingsPath(canAny: (...c: string[]) => boolean): string {
  return visibleGroups(SETTINGS_NAV, canAny)[0]?.items[0]?.to ?? '/settings/security';
}

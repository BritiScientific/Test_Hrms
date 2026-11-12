import {
  BriefcaseBusiness, Building2, CalendarCheck, CalendarClock, CalendarDays, CalendarPlus, CalendarRange, ChartNoAxesCombined, ChartPie,
  ClipboardList, FileBarChart, GitBranch, GraduationCap, History, IdCard, KeyRound, LayoutDashboard, ListChecks, Network,
  Repeat, ScrollText, UsersRound, ShieldCheck, SlidersHorizontal, Tags, UserCog, Users, Wallet, type LucideIcon,
} from 'lucide-react';
import { PERMS } from '@/app/providers/AuthProvider';

export interface NavItem {
  label: string;
  to: string;
  icon: LucideIcon;
  /** Shown only when the user holds at least one of these (UX only; the API enforces). */
  anyOf?: readonly string[];
  /** Only for people who have an employee record (self-service). */
  requiresEmployee?: boolean;
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
    items: [
      { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard },
      { label: 'My profile', to: '/my-profile', icon: IdCard, requiresEmployee: true },
    ],
  },
  {
    label: 'People',
    items: [{ label: 'Employees', to: '/employees', icon: Users, anyOf: ['employee.view'] }],
  },
  {
    label: 'Leave Management',
    items: [
      { label: 'My Leave Dashboard', to: '/leave/dashboard', icon: LayoutDashboard, anyOf: PERMS.leaveMyDashboard, requiresEmployee: true },
      { label: 'Apply for Leave', to: '/leave/apply', icon: CalendarPlus, anyOf: PERMS.leaveApply, requiresEmployee: true },
      { label: 'My Leave Requests & Balance', to: '/leave/my-requests', icon: ClipboardList, anyOf: PERMS.leaveMyRequests, requiresEmployee: true },
      { label: 'Holiday Calendar', to: '/leave/holidays', icon: CalendarDays, anyOf: PERMS.leaveHolidays, requiresEmployee: true },
    ],
  },
  {
    label: 'Leave Management · Team',
    items: [
      { label: 'Leave Dashboard', to: '/leave/team/dashboard', icon: LayoutDashboard, anyOf: PERMS.leaveTeamDashboard },
      { label: 'Team Leave Requests & Approvals', to: '/leave/team/requests', icon: ListChecks, anyOf: PERMS.leaveTeamRequests },
    ],
  },
  {
    label: 'Leave Management · HR',
    items: [
      { label: 'Leave Dashboard', to: '/leave/admin/dashboard', icon: LayoutDashboard, anyOf: PERMS.leaveAdminDashboard },
      { label: 'All Leave Requests', to: '/leave/admin/requests', icon: ClipboardList, anyOf: PERMS.leaveAllRequests },
      { label: 'Leave Calendar', to: '/leave/admin/calendar', icon: CalendarRange, anyOf: PERMS.leaveAdminCalendar },
      { label: 'Leave Reports', to: '/leave/admin/reports', icon: FileBarChart, anyOf: PERMS.leaveReports },
    ],
  },
  {
    label: 'Leave Configuration',
    items: [
      { label: 'Leave Types', to: '/leave/config/types', icon: Tags, anyOf: PERMS.leaveConfig },
      { label: 'Leave Policies', to: '/leave/config/policies', icon: ScrollText, anyOf: PERMS.leaveConfig },
      { label: 'Holiday Calendars', to: '/leave/config/holiday-calendars', icon: CalendarDays, anyOf: PERMS.leaveConfig },
      { label: 'Approval Workflows', to: '/leave/config/workflows', icon: GitBranch, anyOf: PERMS.leaveWorkflows },
      { label: 'Accrual & Carry Forward', to: '/leave/config/accrual', icon: Repeat, anyOf: PERMS.leaveConfig },
      { label: 'Employee Leave Assignments', to: '/leave/config/assignments', icon: UserCog, anyOf: PERMS.leaveAssignments },
    ],
  },
  {
    label: 'Recruitment',
    items: [
      { label: 'Pipeline', to: '/recruitment/pipeline', icon: BriefcaseBusiness, anyOf: PERMS.recruitmentPipeline },
      { label: 'Candidates', to: '/recruitment/candidates', icon: UsersRound, anyOf: PERMS.recruitmentCandidates },
      { label: 'Interviews', to: '/recruitment/interviews', icon: CalendarClock, anyOf: PERMS.recruitmentInterviews },
      { label: 'Recruitment Configuration', to: '/recruitment/configuration', icon: SlidersHorizontal, anyOf: PERMS.recruitmentConfig },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Organization', to: '/settings/organization/profile', icon: Building2, anyOf: PERMS.orgProfile },
      { label: 'Work Schedule', to: '/settings/work-schedule', icon: CalendarClock, anyOf: PERMS.workSchedule },
      { label: 'Roles & access', to: '/settings/access/roles', icon: ShieldCheck, anyOf: PERMS.rolesView },
    ],
  },
];

/**
 * Future modules from the product vision. Rendered as clearly unavailable
 * ("Coming later"), never as working links.
 */
export const UPCOMING_MODULES: UpcomingItem[] = [
  { label: 'Attendance Management', icon: CalendarCheck },
  { label: 'Payroll Management', icon: Wallet },
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
      { label: 'Organization Chart', to: '/settings/organization-chart', icon: Network, anyOf: PERMS.orgChart },
    ],
  },
  {
    label: 'Work Schedule',
    items: [
      { label: 'Work Schedule Configurations', to: '/settings/work-schedule', icon: CalendarClock, anyOf: PERMS.workSchedule },
      { label: 'Work Schedules', to: '/settings/work-schedules', icon: UsersRound, anyOf: PERMS.workSchedules },
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

export const SETTINGS_UPCOMING: UpcomingItem[] = [];

export function visibleGroups(groups: NavGroup[], canAny: (...c: string[]) => boolean, hasEmployee = false): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.anyOf || canAny(...i.anyOf)) && (!i.requiresEmployee || hasEmployee)) }))
    .filter((g) => g.items.length > 0);
}

/** First settings page this user may open (target of /settings). */
export function firstSettingsPath(canAny: (...c: string[]) => boolean): string {
  return visibleGroups(SETTINGS_NAV, canAny)[0]?.items[0]?.to ?? '/settings/security';
}

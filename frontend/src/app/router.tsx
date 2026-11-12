import type { ComponentType } from 'react';
import { Navigate, Outlet, createBrowserRouter, useRouteError, type RouteObject } from 'react-router';
import { PERMS, useAuth } from './providers/AuthProvider';
import { GuestOnly, RequireAuth, RequirePermission } from './guards';
import { AuthLayout } from '@/layouts/AuthLayout';
import { SettingsLayout } from '@/layouts/SettingsLayout';
import { TenantLayout } from '@/layouts/TenantLayout';
import { MAIN_NAV, firstSettingsPath, visibleGroups } from '@/components/navigation/nav-config';
import { ErrorState } from '@/components/feedback/States';
import UnauthorizedPage, { NotFoundPage } from '@/modules/auth/UnauthorizedPage';
import { WORK_SCHEDULE_TABS, firstVisibleTab, tabPath, tabPermissions } from '@/modules/work-schedule/tabs';
import { ASSIGN_TABS, assignTabPath, assignTabPermissions, firstVisibleAssignTab } from '@/modules/work-schedules/tabs';

/** Route-level code splitting: each screen is its own chunk. */
const page = (load: () => Promise<{ default: ComponentType }>) => async () => ({ Component: (await load()).default });

function guarded(anyOf: readonly string[], load: () => Promise<{ default: ComponentType }>): RouteObject['lazy'] {
  return async () => {
    const C = (await load()).default;
    return {
      Component: () => (
        <RequirePermission anyOf={anyOf}>
          <C />
        </RequirePermission>
      ),
    };
  };
}

function SettingsIndex() {
  const { canAny } = useAuth();
  return <Navigate to={firstSettingsPath(canAny)} replace />;
}

/** /leave goes to the first leave screen this user can open. */
function LeaveIndex() {
  const { canAny, me } = useAuth();
  const items = visibleGroups(MAIN_NAV, canAny, !!me?.employee).flatMap((g) => g.items).filter((i) => i.to.startsWith('/leave/'));
  return <Navigate to={items[0]?.to ?? '/unauthorized'} replace />;
}

/** /settings/work-schedule goes to the first tab this user may view. */
function WorkScheduleIndex() {
  const { canAny } = useAuth();
  const first = firstVisibleTab(canAny);
  return <Navigate to={first ? tabPath(first.key) : '/unauthorized'} replace />;
}

/** /settings/work-schedules goes to the first assignment tab this user may view. */
function WorkSchedulesIndex() {
  const { canAny } = useAuth();
  const first = firstVisibleAssignTab(canAny);
  return <Navigate to={first ? assignTabPath(first.key) : '/unauthorized'} replace />;
}

/** /recruitment goes to the first recruitment screen this user can open. */
function RecruitmentIndex() {
  const { canAny, me } = useAuth();
  const items = visibleGroups(MAIN_NAV, canAny, !!me?.employee).flatMap((g) => g.items).filter((i) => i.to.startsWith('/recruitment/'));
  return <Navigate to={items[0]?.to ?? '/unauthorized'} replace />;
}

function RouteError() {
  const error = useRouteError();
  return <div className="p-6"><ErrorState error={error} onRetry={() => window.location.reload()} /></div>;
}

export const routes: RouteObject[] = [
  {
    errorElement: <RouteError />,
    children: [
      // Public / sign-in screens
      {
        element: <AuthLayout />,
        children: [
          {
            element: <GuestOnly />,
            children: [
              { path: '/login', lazy: page(() => import('@/modules/auth/LoginPage')) },
              { path: '/select-organization', lazy: page(() => import('@/modules/auth/SelectOrganizationPage')) },
            ],
          },
          // Activation works whether or not someone is signed in (existing users may be invited).
          { path: '/activate', lazy: page(() => import('@/modules/auth/ActivatePage')) },
          { path: '/session-expired', lazy: page(() => import('@/modules/auth/SessionExpiredPage')) },
        ],
      },
      { path: '/unauthorized', element: <UnauthorizedPage /> },

      // Public careers site: no sign-in, no portal chrome.
      {
        lazy: page(() => import('@/modules/recruitment/careers/CareersLayout')),
        children: [
          { path: '/careers', lazy: page(() => import('@/modules/recruitment/careers/CareersPage')) },
          { path: '/careers/:jobSlug', lazy: page(() => import('@/modules/recruitment/careers/JobPage')) },
          { path: '/careers/:jobSlug/apply', lazy: page(() => import('@/modules/recruitment/careers/ApplyPage')) },
          { path: '/careers/:jobSlug/applied', lazy: page(() => import('@/modules/recruitment/careers/AppliedPage')) },
        ],
      },

      // Signed-in area
      {
        element: <RequireAuth />,
        children: [
          { path: '/', element: <Navigate to="/dashboard" replace /> },
          { path: '/onboarding', lazy: page(() => import('@/modules/onboarding/OnboardingPage')) },
          {
            element: <TenantLayout />,
            children: [
              { path: '/dashboard', handle: { crumb: 'Dashboard' }, lazy: page(() => import('@/modules/dashboard/DashboardPage')) },
              { path: '/my-profile', handle: { crumb: 'My profile' }, lazy: page(() => import('@/modules/employees/MyProfilePage')) },
              {
                path: '/employees',
                handle: { crumb: 'Employees', crumbTo: '/employees' },
                children: [
                  { index: true, lazy: guarded(['employee.view'], () => import('@/modules/employees/EmployeesListPage')) },
                  // Own record is allowed by the API without employee.view; others need it.
                  { path: ':employeeId', handle: { crumb: 'Profile' }, lazy: page(() => import('@/modules/employees/EmployeeDetailPage')) },
                ],
              },
              {
                path: '/recruitment',
                handle: { crumb: 'Recruitment' },
                children: [
                  { index: true, element: <RecruitmentIndex /> },
                  { path: 'pipeline', handle: { crumb: 'Pipeline' }, lazy: guarded(PERMS.recruitmentPipeline, () => import('@/modules/recruitment/PipelinePage')) },
                  {
                    path: 'candidates',
                    handle: { crumb: 'Candidates', crumbTo: '/recruitment/candidates' },
                    children: [
                      { index: true, lazy: guarded(PERMS.recruitmentCandidates, () => import('@/modules/recruitment/CandidatesPage')) },
                      { path: ':candidateId', handle: { crumb: 'Profile' }, lazy: guarded(PERMS.recruitmentCandidates, () => import('@/modules/recruitment/CandidateDetailPage')) },
                    ],
                  },
                  { path: 'interviews', handle: { crumb: 'Interviews' }, lazy: guarded(PERMS.recruitmentInterviews, () => import('@/modules/recruitment/InterviewsPage')) },
                  { path: 'configuration', handle: { crumb: 'Configuration' }, lazy: guarded(PERMS.recruitmentConfig, () => import('@/modules/recruitment/ConfigurationPage')) },
                ],
              },
              {
                path: '/leave',
                handle: { crumb: 'Leave Management' },
                children: [
                  { index: true, element: <LeaveIndex /> },
                  { path: 'dashboard', handle: { crumb: 'My Leave Dashboard' }, lazy: guarded(PERMS.leaveMyDashboard, () => import('@/modules/leave/employee/MyLeaveDashboardPage')) },
                  { path: 'apply', handle: { crumb: 'Apply for Leave' }, lazy: guarded(PERMS.leaveApply, () => import('@/modules/leave/employee/ApplyLeavePage')) },
                  { path: 'my-requests', handle: { crumb: 'My Leave Requests & Balance' }, lazy: guarded(PERMS.leaveMyRequests, () => import('@/modules/leave/employee/MyRequestsBalancePage')) },
                  { path: 'holidays', handle: { crumb: 'Holiday Calendar' }, lazy: guarded(PERMS.leaveHolidays, () => import('@/modules/leave/employee/HolidayCalendarPage')) },
                  {
                    path: 'team',
                    handle: { crumb: 'Team' },
                    children: [
                      { path: 'dashboard', handle: { crumb: 'Leave Dashboard' }, lazy: guarded(PERMS.leaveTeamDashboard, () => import('@/modules/leave/manager/TeamDashboardPage')) },
                      { path: 'requests', handle: { crumb: 'Team Leave Requests & Approvals' }, lazy: guarded(PERMS.leaveTeamRequests, () => import('@/modules/leave/manager/TeamRequestsPage')) },
                    ],
                  },
                  {
                    path: 'admin',
                    handle: { crumb: 'HR' },
                    children: [
                      { path: 'dashboard', handle: { crumb: 'Leave Dashboard' }, lazy: guarded(PERMS.leaveAdminDashboard, () => import('@/modules/leave/admin/AdminDashboardPage')) },
                      { path: 'requests', handle: { crumb: 'All Leave Requests' }, lazy: guarded(PERMS.leaveAllRequests, () => import('@/modules/leave/admin/AllRequestsPage')) },
                      { path: 'calendar', handle: { crumb: 'Leave Calendar' }, lazy: guarded(PERMS.leaveAdminCalendar, () => import('@/modules/leave/admin/AdminCalendarPage')) },
                      { path: 'reports', handle: { crumb: 'Leave Reports' }, lazy: guarded(PERMS.leaveReports, () => import('@/modules/leave/admin/ReportsPage')) },
                    ],
                  },
                  {
                    path: 'config',
                    handle: { crumb: 'Leave Configuration' },
                    children: [
                      { path: 'types', handle: { crumb: 'Leave Types' }, lazy: guarded(PERMS.leaveConfig, () => import('@/modules/leave/config/LeaveTypesPage')) },
                      { path: 'policies', handle: { crumb: 'Leave Policies' }, lazy: guarded(PERMS.leaveConfig, () => import('@/modules/leave/config/LeavePoliciesPage')) },
                      { path: 'holiday-calendars', handle: { crumb: 'Holiday Calendars' }, lazy: guarded(PERMS.leaveConfig, () => import('@/modules/leave/config/HolidayCalendarsPage')) },
                      { path: 'workflows', handle: { crumb: 'Approval Workflows' }, lazy: guarded(PERMS.leaveWorkflows, () => import('@/modules/leave/config/ApprovalWorkflowsPage')) },
                      { path: 'accrual', handle: { crumb: 'Accrual & Carry Forward' }, lazy: guarded(PERMS.leaveConfig, () => import('@/modules/leave/config/AccrualCarryForwardPage')) },
                      { path: 'assignments', handle: { crumb: 'Employee Leave Assignments' }, lazy: guarded(PERMS.leaveAssignments, () => import('@/modules/leave/config/EmployeeAssignmentsPage')) },
                    ],
                  },
                ],
              },
            ],
          },
          {
            path: '/settings',
            element: <SettingsLayout />,
            handle: { crumb: 'Settings', crumbTo: '/settings' },
            children: [
              { index: true, element: <SettingsIndex /> },
              {
                path: 'organization',
                handle: { crumb: 'Organization', crumbTo: '/settings/organization/profile' },
                children: [
                  { index: true, element: <Navigate to="profile" replace /> },
                  { path: 'profile', handle: { crumb: 'Profile' }, lazy: guarded(PERMS.orgProfile, () => import('@/modules/organization/OrganizationProfilePage')) },
                  { path: 'preferences', handle: { crumb: 'Settings' }, lazy: guarded(PERMS.orgSettings, () => import('@/modules/organization/OrganizationPreferencesPage')) },
                ],
              },
              { path: 'organization-chart', handle: { crumb: 'Organization Chart' }, lazy: guarded(PERMS.orgChart, () => import('@/modules/organization/OrganizationChartPage')) },
              {
                // Settings > Work Schedule > Work Schedules. The pathless parent adds the "Work Schedule" crumb,
                // so the trail reads like the configuration screens that sit beside it.
                handle: { crumb: 'Work Schedule', crumbTo: '/settings/work-schedule' },
                children: [{
                  path: 'work-schedules',
                  handle: { crumb: 'Work Schedules', crumbTo: '/settings/work-schedules' },
                  lazy: guarded(PERMS.workSchedules, () => import('@/modules/work-schedules/WorkSchedulesPage')),
                  children: [
                    { index: true, element: <WorkSchedulesIndex /> },
                    ...ASSIGN_TABS.map((t): RouteObject => ({
                      path: t.key,
                      lazy: guarded(assignTabPermissions(t), () => import('@/modules/work-schedules/WorkSchedulesTab')),
                    })),
                  ],
                }],
              },
              {
                // Settings > Work Schedule > <tab>: a layout (header + tab strip) and one guarded child per tab.
                path: 'work-schedule',
                handle: { crumb: 'Work Schedule', crumbTo: '/settings/work-schedule' },
                lazy: guarded(PERMS.workSchedule, () => import('@/modules/work-schedule/WorkSchedulePage')),
                children: [
                  { index: true, element: <WorkScheduleIndex /> },
                  ...WORK_SCHEDULE_TABS.map((t): RouteObject => ({
                    path: t.key,
                    handle: { crumb: t.label },
                    lazy: guarded(tabPermissions(t), () => import('@/modules/work-schedule/WorkScheduleTab')),
                  })),
                ],
              },
              {
                path: 'access',
                handle: { crumb: 'Access control', crumbTo: '/settings/access/roles' },
                children: [
                  { index: true, element: <Navigate to="roles" replace /> },
                  {
                    path: 'roles',
                    handle: { crumb: 'Roles' },
                    element: <Outlet />,
                    children: [
                      { index: true, lazy: guarded(PERMS.rolesView, () => import('@/modules/roles/RolesListPage')) },
                      { path: 'new', handle: { crumb: 'New role' }, lazy: guarded(['roles.manage'], () => import('@/modules/roles/RoleCreatePage')) },
                      { path: ':roleId', handle: { crumb: 'Role' }, lazy: guarded(PERMS.rolesView, () => import('@/modules/roles/RoleDetailPage')) },
                      { path: ':roleId/permissions', handle: { crumb: 'Permissions' }, lazy: guarded(PERMS.rolesView, () => import('@/modules/roles/RolePermissionsPage')) },
                    ],
                  },
                  { path: 'permissions', handle: { crumb: 'Permissions' }, lazy: guarded(PERMS.rolesView, () => import('@/modules/permissions/PermissionCataloguePage')) },
                  { path: 'assignments', handle: { crumb: 'Assignments' }, lazy: guarded(PERMS.rolesView, () => import('@/modules/role-assignments/AssignmentsPage')) },
                  // Self is always allowed (the API permits it); others need roles.* — enforced by the API.
                  { path: 'users/:userId/permissions', handle: { crumb: 'Effective permissions' }, lazy: page(() => import('@/modules/role-assignments/UserPermissionsPage')) },
                ],
              },
              { path: 'security', handle: { crumb: 'Security & audit' }, lazy: page(() => import('@/modules/security/SecurityAuditPage')) },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
          {
            element: <TenantLayout />,
            children: [{ path: '*', handle: { crumb: 'Not found' }, element: <NotFoundPage /> }],
          },
        ],
      },
    ],
  },
];

export const createRouter = () => createBrowserRouter(routes);

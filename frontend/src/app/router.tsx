import type { ComponentType } from 'react';
import { Navigate, Outlet, createBrowserRouter, useRouteError, type RouteObject } from 'react-router';
import { PERMS, useAuth } from './providers/AuthProvider';
import { GuestOnly, RequireAuth, RequirePermission } from './guards';
import { AuthLayout } from '@/layouts/AuthLayout';
import { SettingsLayout } from '@/layouts/SettingsLayout';
import { TenantLayout } from '@/layouts/TenantLayout';
import { firstSettingsPath } from '@/components/navigation/nav-config';
import { ErrorState } from '@/components/feedback/States';
import UnauthorizedPage, { NotFoundPage } from '@/modules/auth/UnauthorizedPage';

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

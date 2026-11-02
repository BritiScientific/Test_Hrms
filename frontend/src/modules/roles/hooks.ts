import { useQuery, useQueryClient } from '@tanstack/react-query';
import { rbacApi } from '@/services/rbac-api';

export const rbacKeys = {
  roles: ['roles'] as const,
  role: (id: number) => ['roles', id] as const,
  members: (id: number) => ['roles', id, 'members'] as const,
  permissions: ['permissions'] as const,
  users: (q: object) => ['users', q] as const,
  user: (id: number) => ['users', 'detail', id] as const,
  effective: (id: number) => ['users', id, 'effective'] as const,
  audit: (q: object) => ['audit', q] as const,
};

export const useRoles = () => useQuery({ queryKey: rbacKeys.roles, queryFn: rbacApi.roles });
export const useRole = (id: number) => useQuery({ queryKey: rbacKeys.role(id), queryFn: () => rbacApi.role(id) });
export const usePermissionCatalogue = () =>
  useQuery({ queryKey: rbacKeys.permissions, queryFn: rbacApi.permissions, staleTime: 5 * 60_000 });

/** After any RBAC change: roles, users, effective permissions, audit and my own /me may all change. */
export function useInvalidateRbac() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['roles'] }),
    qc.invalidateQueries({ queryKey: ['users'] }),
    qc.invalidateQueries({ queryKey: ['audit'] }),
    qc.invalidateQueries({ queryKey: ['me'] }),
  ]);
}

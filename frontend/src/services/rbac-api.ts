import type {
  AuditEvent, DirectoryUser, EffectivePermission, MyTask, Paged, Permission, RoleDetail, RoleMember, RoleSummary,
} from '@/types/api';
import { api, qs } from './api-client';

export const rbacApi = {
  permissions: () => api.get<Permission[]>('/permissions'),
  roles: () => api.get<RoleSummary[]>('/roles'),
  role: (id: number) => api.get<RoleDetail>(`/roles/${id}`),
  roleMembers: (id: number) => api.get<RoleMember[]>(`/roles/${id}/members`),
  rolePermissions: (id: number) => api.get<string[]>(`/roles/${id}/permissions`),
  createRole: (body: { name: string; description?: string | null }) => api.post<RoleSummary>('/roles', body),
  cloneRole: (id: number, body: { name: string; description?: string | null }) =>
    api.post<RoleSummary>(`/roles/${id}/clone`, body),
  updateRole: (id: number, body: { name?: string; description?: string | null }) => api.put<RoleSummary>(`/roles/${id}`, body),
  deactivateRole: (id: number) => api.del(`/roles/${id}`),
  activateRole: (id: number) => api.post<RoleSummary>(`/roles/${id}/activate`),
  setRolePermissions: (id: number, permissions: string[]) =>
    api.put<{ added: string[]; removed: string[] }>(`/roles/${id}/permissions`, { permissions }),

  users: (q: { search?: string; limit?: number; offset?: number }) => api.get<Paged<DirectoryUser>>(`/users${qs(q)}`),
  user: (id: number) => api.get<DirectoryUser>(`/users/${id}`),
  assignRole: (userId: number, body: { roleId: number; effectiveFrom?: string }) =>
    api.post<{ id: number }>(`/users/${userId}/roles`, body),
  revokeRole: (userId: number, assignmentId: number) => api.del(`/users/${userId}/roles/${assignmentId}`),
  effectivePermissions: (userId: number) =>
    api.get<EffectivePermission[]>(`/users/${userId}/permissions?include=sources`),

  auditEvents: (q: { limit?: number; offset?: number; category?: string; targetType?: string; targetId?: number }) =>
    api.get<{ items: AuditEvent[]; hasMore: boolean }>(`/audit-events${qs(q)}`),

  myTasks: () => api.get<MyTask[]>('/workflows/my-tasks'),
};

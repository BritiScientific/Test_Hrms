import type { Department, Employee, Paged, QuickAddResult } from '@/types/api';
import { api, qs } from './api-client';

export interface QuickAddBody {
  fullName: string;
  workEmail: string;
  dateOfJoining: string;
  employeeCode?: string | null;
  departmentId?: number | null;
  managerId?: number | null;
  jobTitle?: string | null;
  employmentType?: string;
  roleIds?: number[];
  sendInvite?: boolean;
}

export type EmployeePatch = Record<string, unknown> & { version?: number };

export const employeesApi = {
  list: (q: { search?: string; departmentId?: number; access?: string; status?: string; limit?: number; offset?: number }) =>
    api.get<Paged<Employee>>(`/employees${qs(q)}`),
  get: (id: number) => api.get<Employee>(`/employees/${id}`),
  nextCode: () => api.get<{ employeeCode: string }>('/employees/next-code'),
  quickAdd: (body: QuickAddBody) => api.post<QuickAddResult>('/employees', body),
  update: (id: number, patch: EmployeePatch) => api.patch<Employee>(`/employees/${id}`, patch),
  reissueInvitation: (id: number) => api.post<{ url: string; expiresAt: string }>(`/employees/${id}/invitation`),
  mine: () => api.get<Employee>('/me/employee'),
  updateMine: (patch: EmployeePatch) => api.patch<Employee>('/me/employee', patch),
  departments: () => api.get<Department[]>('/departments'),
  createDepartment: (name: string) => api.post<Department>('/departments', { name }),
};

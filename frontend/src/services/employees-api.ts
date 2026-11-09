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
  /** Legacy: still accepted, mapped to the default type for that category. Prefer employeeTypeId. */
  employmentType?: string;
  employeeTypeId?: number;
  roleIds?: number[];
  sendInvite?: boolean;
}

export type EmployeePatch = Record<string, unknown> & { version?: number };

/** An active employee type, for the create/edit dropdown. */
export interface EmployeeTypeOption {
  id: number;
  name: string;
  baseCategory: 'full_time' | 'part_time' | 'contract' | 'intern';
}

export const employeesApi = {
  list: (q: { search?: string; departmentId?: number; access?: string; status?: string; limit?: number; offset?: number }) =>
    api.get<Paged<Employee>>(`/employees${qs(q)}`),
  get: (id: number) => api.get<Employee>(`/employees/${id}`),
  nextCode: () => api.get<{ employeeCode: string }>('/employees/next-code'),
  /** Active types only; needs employee.create or employee.update (no work schedule permission). */
  employeeTypes: () => api.get<EmployeeTypeOption[]>('/employees/lookups/employee-types'),
  quickAdd: (body: QuickAddBody) => api.post<QuickAddResult>('/employees', body),
  update: (id: number, patch: EmployeePatch) => api.patch<Employee>(`/employees/${id}`, patch),
  reissueInvitation: (id: number) => api.post<{ url: string; expiresAt: string }>(`/employees/${id}/invitation`),
  mine: () => api.get<Employee>('/me/employee'),
  updateMine: (patch: EmployeePatch) => api.patch<Employee>('/me/employee', patch),
  departments: () => api.get<Department[]>('/departments'),
  createDepartment: (name: string) => api.post<Department>('/departments', { name }),
};

import { api, qs } from '@/services/api-client';
import type { Assignment, AssignmentFilters, Paged, PickerEmployee, PickerFilters, PickerOptions, RotationRule } from './types';

const BASE = '/work-schedule';

/** Blank filters are dropped by qs(). */
const filterQuery = (f: AssignmentFilters) => ({
  search: f.search.trim() || undefined,
  status: f.status === 'all' ? undefined : f.status,
  patternId: f.patternId || undefined,
  from: f.from || undefined,
  to: f.to || undefined,
});

export function assignmentApi(path: string) {
  const root = `${BASE}/${path}`;
  return {
    list: (f: AssignmentFilters, page: number, limit: number) =>
      api.get<Paged<Assignment>>(`${root}${qs({ ...filterQuery(f), page, limit })}`),
    create: (body: { employeeIds: number[]; patternId: number; startDate: string; rotation: RotationRule; reason?: string | null }) =>
      api.post<{ items: Assignment[]; total: number }>(root, body),
    update: (id: number, body: Record<string, unknown> & { updatedAt: string }) => api.patch<Assignment>(`${root}/${id}`, body),
    end: (id: number, body: { endDate?: string | null; updatedAt: string }) => api.patch<Assignment>(`${root}/${id}/end`, body),
    cancel: (id: number, body: { reason?: string | null; updatedAt: string }) => api.patch<Assignment>(`${root}/${id}/cancel`, body),
    bulkEnd: (ids: number[], endDate?: string | null) =>
      api.post<{ items: Assignment[]; total: number }>(`${root}/bulk-end`, { ids, endDate: endDate || undefined }),
    /** CSV of the filtered list; the browser downloads it with the session cookie. */
    exportUrl: (f: AssignmentFilters) => `/api/v1${root}/export${qs({ ...filterQuery(f) })}`,
  };
}
export type AssignmentApi = ReturnType<typeof assignmentApi>;

const pickerQuery = (kind: string, f: PickerFilters) => ({
  kind,
  search: f.search.trim() || undefined,
  departmentId: f.departmentId || undefined,
  jobTitle: f.jobTitle || undefined,
  employeeTypeId: f.employeeTypeId || undefined,
  roleId: f.roleId || undefined,
  managerId: f.managerId || undefined,
  joinedFrom: f.joinedFrom || undefined,
  joinedTo: f.joinedTo || undefined,
  assignment: f.assignment || undefined,
});

export const pickerApi = {
  list: (kind: string, f: PickerFilters, page: number, limit: number) =>
    api.get<Paged<PickerEmployee>>(`${BASE}/employee-picker${qs({ ...pickerQuery(kind, f), page, limit })}`),
  allIds: (kind: string, f: PickerFilters) =>
    api.get<{ ids: number[]; total: number; truncated: boolean }>(`${BASE}/employee-picker${qs({ ...pickerQuery(kind, f), idsOnly: 'true' })}`),
  options: () => api.get<PickerOptions>(`${BASE}/employee-picker/options`),
};

import { api, qs } from '@/services/api-client';
import type {
  EmployeeType, ListParams, Option, Paged, Rotation, RotationUnit, Shift, ShiftSchedule, WorkType, BaseCategory,
} from './types';

/** Typed client for /api/v1/work-schedule. There is no delete call anywhere: records are deactivated. */

const BASE = '/work-schedule';

function resource<T>(path: string) {
  return {
    list: (q: ListParams) => api.get<Paged<T>>(`${BASE}/${path}${qs({ ...q })}`),
    get: (id: number) => api.get<T>(`${BASE}/${path}/${id}`),
    create: (body: Record<string, unknown>) => api.post<T>(`${BASE}/${path}`, body),
    update: (id: number, body: Record<string, unknown> & { updatedAt: string }) => api.patch<T>(`${BASE}/${path}/${id}`, body),
    setStatus: (id: number, body: { isActive: boolean; updatedAt: string }) => api.patch<T>(`${BASE}/${path}/${id}/status`, body),
  };
}

export const workScheduleApi = {
  employeeTypes: resource<EmployeeType>('employee-types'),
  shifts: resource<Shift>('shifts'),
  workTypes: resource<WorkType>('work-types'),
  rotatingShifts: resource<Rotation>('rotating-shifts'),
  rotatingWorkTypes: resource<Rotation>('rotating-work-types'),
  shiftSchedules: resource<ShiftSchedule>('shift-schedules'),
  /** Active records only, for pickers. */
  shiftOptions: () => api.get<(Option & { graceTimeMinutes: number })[]>(`${BASE}/lookups/shifts`),
  workTypeOptions: () => api.get<Option[]>(`${BASE}/lookups/work-types`),
};

export type ResourceApi<T> = ReturnType<typeof resource<T>>;

export interface EmployeeTypeBody { name: string; description?: string | null; baseCategory: BaseCategory }
export interface ShiftBody { name: string; description?: string | null; graceTimeMinutes: number }
export interface WorkTypeBody { name: string; description?: string | null }
export interface RotationBody {
  name: string; description?: string | null; rotationInterval: number; rotationUnit: RotationUnit; items: number[];
}

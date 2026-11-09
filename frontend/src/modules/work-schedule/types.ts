/** Shapes returned by /api/v1/work-schedule/*. Mirrors the backend services. */

export type StatusFilter = 'all' | 'active' | 'inactive';
export type BaseCategory = 'full_time' | 'part_time' | 'contract' | 'intern';
export type RotationUnit = 'days' | 'weeks';

export interface BaseRecord {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  /** Optimistic-lock token: send it back on every PATCH. */
  updatedAt: string;
  createdBy: number | null;
  updatedBy: number | null;
}

export interface EmployeeType extends BaseRecord {
  baseCategory: BaseCategory;
  employeeCount: number;
}

export interface Shift extends BaseRecord {
  graceTimeMinutes: number;
  usage: { activeSchedules: number; activeRotations: number };
}

export interface WorkType extends BaseRecord {
  usage: { activeRotations: number };
}

export interface RotationItem {
  /** Id of the referenced shift or work type. */
  id: number;
  name: string;
  isActive: boolean;
  sequenceOrder: number;
}

export interface Rotation extends BaseRecord {
  rotationInterval: number;
  rotationUnit: RotationUnit;
  items: RotationItem[];
  sequenceSummary: string;
}

export interface ScheduleDay {
  /** ISO weekday: 1 = Monday .. 7 = Sunday. */
  dayOfWeek: number;
  isWorkingDay: boolean;
  startTime: string | null;
  endTime: string | null;
  minimumWorkingMinutes: number;
  isNightShift: boolean;
  spanMinutes: number;
}

export interface ShiftSchedule extends BaseRecord {
  shiftId: number;
  shiftName: string;
  shiftActive: boolean;
  defaultMinimumWorkingMinutes: number;
  automaticCheckoutEnabled: boolean;
  days: ScheduleDay[];
  workingDaysSummary: string;
  /** Only on create/update responses: e.g. a working day on the organization's weekly off. */
  warnings?: string[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
}

export interface ListParams {
  search?: string;
  status?: StatusFilter;
  page?: number;
  limit?: number;
  sort?: string;
}

export interface Option {
  id: number;
  name: string;
}

export interface Blocker {
  type: 'employee' | 'shift_schedule' | 'rotating_shift' | 'rotating_work_type';
  id: number;
  name: string;
}

export const BASE_CATEGORY_OPTIONS: { value: BaseCategory; label: string }[] = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'intern', label: 'Intern' },
];

export const baseCategoryLabel = (c: BaseCategory) => BASE_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c;

export const BLOCKER_LABEL: Record<Blocker['type'], string> = {
  employee: 'Employee',
  shift_schedule: 'Shift schedule',
  rotating_shift: 'Rotating shift',
  rotating_work_type: 'Rotating work type',
};

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

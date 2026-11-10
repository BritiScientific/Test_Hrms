/** Shapes returned by /api/v1/work-schedule/*-assignments and /employee-picker. */

/** How a rotation repeats; weekday is 1 (Monday) to 7 (Sunday). */
export type RotationRule =
  | { basedOn: 'after'; afterDays: number }
  | { basedOn: 'weekly'; weekday: number }
  | { basedOn: 'monthly'; monthDay: number | 'last' };
export type AssignmentStatus = 'active' | 'ended' | 'cancelled';
export type Phase = 'upcoming' | 'current' | 'completed' | 'cancelled';

export interface Entry { id: number; name: string }

export interface Assignment {
  id: number;
  employee: { id: number; name: string; code: string; jobTitle: string | null };
  pattern: { id: number; name: string; isActive: boolean };
  rotation: RotationRule;
  /** "Every 5 days", "Every Monday", "Monthly on the last day" */
  rotateLabel: string;
  sequenceSummary: string;
  startDate: string;
  endDate: string | null;
  status: AssignmentStatus;
  phase: Phase;
  reason: string | null;
  createdAt: string;
  /** Optimistic-lock token: send it back on every change. */
  updatedAt: string;
  current: Entry | null;
  nextSwitch: string | null;
  next: Entry | null;
}

export interface Paged<T> { items: T[]; total: number; page: number; limit: number }

export interface AssignmentFilters {
  search: string;
  status: 'all' | 'active' | 'ended' | 'cancelled';
  patternId: string;
  from: string;
  to: string;
}
export const EMPTY_FILTERS: AssignmentFilters = { search: '', status: 'all', patternId: '', from: '', to: '' };

export interface PickerEmployee {
  id: number; name: string; code: string; jobTitle: string | null; department: string | null;
  employeeType: string | null; assigned: boolean;
}

export interface PickerFilters {
  search: string; departmentId: string; jobTitle: string; employeeTypeId: string; roleId: string; managerId: string;
  joinedFrom: string; joinedTo: string; assignment: '' | 'assigned' | 'unassigned';
}
export const EMPTY_PICKER: PickerFilters = {
  search: '', departmentId: '', jobTitle: '', employeeTypeId: '', roleId: '', managerId: '',
  joinedFrom: '', joinedTo: '', assignment: '',
};

export interface PickerOptions {
  jobTitles: string[];
  departments: { id: number; name: string }[];
  employeeTypes: { id: number; name: string }[];
  roles: { id: number; name: string }[];
  managers: { id: number; name: string }[];
}

export interface OverlapConflict {
  employeeId: number; employeeName: string; assignmentId: number; patternName: string; startDate: string; endDate: string | null;
}

export const PHASE_LABEL: Record<Phase, { label: string; tone: 'primary' | 'success' | 'neutral' | 'warning' }> = {
  upcoming: { label: 'Upcoming', tone: 'primary' },
  current: { label: 'Current', tone: 'success' },
  completed: { label: 'Ended', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

/**
 * The six Work Schedule tabs, in one place. The router (one guarded route per
 * tab, each with its own breadcrumb), the settings navigation and the page
 * shell all read this array, so a tab is added or reordered here only.
 *
 * Kept free of component imports so the router can use it without pulling
 * the screens into the main bundle.
 */

export type TabKey = 'shift' | 'shift-schedule' | 'rotating-shift' | 'work-type' | 'rotating-work-type' | 'employee-type';

export interface WorkScheduleTab {
  key: TabKey;
  label: string;
  /** What the tab is for, shown under the page title. */
  description: string;
  view: string;
  manage: string;
}

const perm = (resource: string) => ({
  view: `workschedule.${resource}.view`,
  manage: `workschedule.${resource}.manage`,
});

export const WORK_SCHEDULE_TABS: readonly WorkScheduleTab[] = [
  {
    key: 'shift', label: 'Shift', ...perm('shift'),
    description: 'Named shifts and the lateness grace time each one allows.',
  },
  {
    key: 'shift-schedule', label: 'Shift Schedule', ...perm('shift_schedule'),
    description: 'Weekly timetables for a shift: working days, start and end times, and minimum working time.',
  },
  {
    key: 'rotating-shift', label: 'Rotating Shift', ...perm('rotating_shift'),
    description: 'A fixed sequence of shifts that repeats every few days or weeks.',
  },
  {
    key: 'work-type', label: 'Work Type', ...perm('work_type'),
    description: 'Where or how work happens, such as office, home or field.',
  },
  {
    key: 'rotating-work-type', label: 'Rotating Work Type', ...perm('rotating_work_type'),
    description: 'A fixed sequence of work types that repeats every few days or weeks.',
  },
  {
    key: 'employee-type', label: 'Employee Type', ...perm('employee_type'),
    description: 'Your own employee categories. Each one maps to a base category used across the system.',
  },
];

export const tabPermissions = (t: WorkScheduleTab) => [t.view, t.manage] as const;

/** Every work schedule permission: the sidebar entry shows when the user holds any of them. */
export const ALL_WORK_SCHEDULE_PERMS: readonly string[] = WORK_SCHEDULE_TABS.flatMap((t) => [t.view, t.manage]);

export const tabPath = (key: TabKey) => `/settings/work-schedule/${key}`;

/** First tab this user may view (target of /settings/work-schedule). */
export function firstVisibleTab(canAny: (...codes: string[]) => boolean): WorkScheduleTab | undefined {
  return WORK_SCHEDULE_TABS.find((t) => canAny(...tabPermissions(t)));
}

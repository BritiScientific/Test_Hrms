/**
 * The two Work Schedules tabs (assignments), in one place: the router, the
 * navigation and the page shell all read this array. Pure data, so the router
 * can import it without pulling the screens into the main bundle.
 */

export type AssignTabKey = 'rotating-shift' | 'rotating-work-type';

export interface AssignTab {
  key: AssignTabKey;
  label: string;
  description: string;
  /** API path segment under /work-schedule. */
  path: string;
  /** Singular noun for the pattern, e.g. "Rotating shift". */
  patternLabel: string;
  view: string;
  manage: string;
}

export const ASSIGN_TABS: readonly AssignTab[] = [
  {
    key: 'rotating-shift', label: 'Rotating Shift Assign', path: 'rotating-shift-assignments', patternLabel: 'Rotating shift',
    description: 'Put employees on a rotating shift pattern from a start date. The current shift and the next switch are worked out for you.',
    view: 'workschedule.rotating_shift_assignment.view', manage: 'workschedule.rotating_shift_assignment.manage',
  },
  {
    key: 'rotating-work-type', label: 'Rotating Work Type Assign', path: 'rotating-work-type-assignments', patternLabel: 'Rotating work type',
    description: 'Put employees on a rotating work type pattern from a start date. The current work type and the next switch are worked out for you.',
    view: 'workschedule.rotating_work_type_assignment.view', manage: 'workschedule.rotating_work_type_assignment.manage',
  },
];

export const assignTabPermissions = (t: AssignTab) => [t.view, t.manage] as const;
export const ALL_ASSIGN_PERMS: readonly string[] = ASSIGN_TABS.flatMap((t) => [t.view, t.manage]);
export const assignTabPath = (key: AssignTabKey) => `/settings/work-schedules/${key}`;

export function firstVisibleAssignTab(canAny: (...codes: string[]) => boolean): AssignTab | undefined {
  return ASSIGN_TABS.find((t) => canAny(...assignTabPermissions(t)));
}

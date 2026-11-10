import { AppError, conflict, unprocessable } from '../../shared/errors';

/**
 * Business errors for the work schedule module, all in the existing error
 * envelope `{ error: { code, message, details, requestId } }`.
 *
 * Validation failures reuse the global VALIDATION_FAILED (422) from the zod
 * error handler; a missing permission reuses MISSING_PERMISSION (403) from
 * requirePermission; an unknown or other-tenant id reuses NOT_FOUND (404),
 * which never reveals whether the record exists in another tenant.
 */

export interface Blocker {
  type: 'employee' | 'shift_schedule' | 'rotating_shift' | 'rotating_work_type'
    | 'rotating_shift_assignment' | 'rotating_work_type_assignment';
  id: number;
  name: string;
}

/** Maximum blockers listed in HAS_ACTIVE_DEPENDENTS details. */
export const MAX_BLOCKERS = 20;

export const nameTaken = (label: string) =>
  conflict('NAME_TAKEN', `A ${label.toLowerCase()} with this name already exists`, {
    fieldErrors: { name: `A ${label.toLowerCase()} with this name already exists` },
  });

export const staleVersion = (currentUpdatedAt: Date) =>
  conflict('STALE_VERSION', 'This record was changed by someone else. Reload and try again.', {
    currentUpdatedAt: currentUpdatedAt.toISOString(),
  });

export const hasActiveDependents = (label: string, total: number, items: Blocker[]) =>
  conflict('HAS_ACTIVE_DEPENDENTS',
    `This ${label.toLowerCase()} is still in use by ${total} active record${total === 1 ? '' : 's'}. Deactivate or change those first.`,
    { total, items: items.slice(0, MAX_BLOCKERS) });

/** A pattern with live assignments cannot change its interval, unit or entries. */
export const patternFrozen = (label: string, total: number, items: Blocker[]) =>
  conflict('HAS_ACTIVE_DEPENDENTS',
    `This ${label.toLowerCase()} is assigned to ${total} employee${total === 1 ? '' : 's'}, so its interval and entries cannot change. End those assignments first, or create a new pattern.`,
    { total, items: items.slice(0, MAX_BLOCKERS) });

export interface OverlapConflict {
  employeeId: number;
  employeeName: string;
  assignmentId: number;
  patternName: string;
  startDate: string;
  endDate: string | null;
}

/** Bulk create is all-or-nothing: nothing is saved, and every clash is listed. */
export const assignmentOverlap = (conflicts: OverlapConflict[]) =>
  conflict('ASSIGNMENT_OVERLAP',
    `${conflicts.length} employee${conflicts.length === 1 ? ' already has' : 's already have'} a rotation in this period. Nothing was saved.`,
    { conflicts: conflicts.slice(0, 200), total: conflicts.length });

/** The assignment is in a state that does not allow this action (ended, cancelled, started, not started). */
export const invalidAssignmentState = (message: string, fieldErrors?: Record<string, string>) =>
  conflict('INVALID_ASSIGNMENT_STATE', message, fieldErrors ? { fieldErrors } : undefined);

export const inactiveReference =(message: string, field?: string) =>
  unprocessable('INACTIVE_REFERENCE', message, field ? { fieldErrors: { [field]: message } } : undefined);

/** Service-level field validation, same shape as the employee module. */
export const fieldValidation = (message: string, fieldErrors: Record<string, string>) =>
  unprocessable('VALIDATION_FAILED', message, { fieldErrors });

/** Base category of a type that employees already hold cannot move: their employment_type would drift. */
export const baseCategoryInUse = (count: number) =>
  conflict('BASE_CATEGORY_IN_USE',
    `${count} employee${count === 1 ? ' holds' : 's hold'} this type, so its base category cannot change. Create a new type instead.`,
    { fieldErrors: { baseCategory: 'Cannot change while employees hold this type' }, total: count });

/**
 * A unique-name violation can still arrive from the database when two
 * requests race past the pre-check. Turn exactly that into NAME_TAKEN.
 */
export function rethrowNameTaken(err: unknown, nameIndex: string, label: string): never {
  const e = err as { code?: string; constraint?: string };
  if (e?.code === '23505' && e.constraint === nameIndex) throw nameTaken(label);
  throw err;
}

export { AppError };

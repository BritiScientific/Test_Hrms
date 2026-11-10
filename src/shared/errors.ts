export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const forbidden = (code: string, message: string) => new AppError(403, code, message);
export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

/** Map PostgreSQL errors to API errors without leaking SQL to clients. */
export function fromPgError(err: any): AppError | null {
  switch (err?.code) {
    case '23P01':
      return conflict('OVERLAP', overlapMessage(err.constraint));
    case '23505':
      return conflict('DUPLICATE', duplicateMessage(err.constraint), { constraint: err.constraint });
    case '23503':
      return unprocessable('INVALID_REFERENCE', 'Referenced record does not exist in this tenant');
    case '23514':
      return conflict('INVARIANT_VIOLATION', err.message);
    case '42501':
      return forbidden('FORBIDDEN', 'Operation not permitted');
    default:
      return null;
  }
}

function duplicateMessage(constraint?: string): string {
  switch (constraint) {
    case 'uq_roles_name':
      return 'A role with this name already exists';
    case 'departments_tenant_id_name_key':
      return 'A department with this name already exists';
    case 'employees_tenant_id_employee_code_key':
      return 'This employee code is already used';
    case 'uq_tenants_slug':
      return 'An organization with this slug already exists';
    case 'leave_types_tenant_id_code_key':
      return 'A leave type with this code already exists';
    case 'uq_leave_types_name':
      return 'A leave type with this name already exists';
    case 'leave_policies_tenant_id_code_key':
      return 'A leave policy with this code already exists';
    case 'leave_policy_entitlements_tenant_id_policy_id_leave_type_id_key':
      return 'This policy already has an entitlement for that leave type';
    case 'leave_holiday_calendars_tenant_id_code_calendar_year_key':
      return 'A holiday calendar with this code already exists for that year';
    case 'uq_leave_calendar_one_default':
      return 'Another active calendar is already the default for that year';
    case 'leave_holidays_tenant_id_calendar_id_holiday_date_key':
      return 'This calendar already has a holiday on that date';
    case 'uq_leave_comp_off_date':
      return 'You already have a comp off claim for that date';
    default:
      return 'A record with the same unique values already exists';
  }
}

function overlapMessage(constraint?: string): string {
  switch (constraint) {
    case 'ex_leave_no_overlap':
      return 'You already have leave applied for some of these dates';
    case 'ex_user_roles_no_overlap':
      return 'User already has this role for an overlapping period';
    case 'ex_reporting_no_overlap':
      return 'Employee already has a manager for an overlapping period';
    case 'ex_delegation_no_overlap':
      return 'An active delegation already exists for this period';
    case 'ex_leave_policy_assignment_no_overlap':
      return 'This employee already has a leave policy for an overlapping period';
    case 'ex_leave_calendar_assignment_no_overlap':
      return 'This employee already has a holiday calendar for an overlapping period';
    case 'ex_leave_policy_one_default':
      return 'Another active policy is already the default for an overlapping period';
    case 'ex_leave_accrual_one_active':
      return 'An active accrual rule already covers this entitlement for an overlapping period';
    case 'ex_leave_carry_one_active':
      return 'An active carry-forward rule already covers this entitlement for an overlapping period';
    case 'ex_rotating_shift_assignment_no_overlap':
    case 'ex_rotating_work_type_assignment_no_overlap':
      return 'This employee already has a rotation for an overlapping period';
    case 'ex_leave_comp_off_one_active':
      return 'An active comp off rule already covers this leave type for an overlapping period';
    default:
      return 'Overlapping record exists';
  }
}

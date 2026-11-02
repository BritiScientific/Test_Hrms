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
      return conflict('DUPLICATE', 'A record with the same unique values already exists', {
        constraint: err.constraint,
      });
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
    default:
      return 'Overlapping record exists';
  }
}

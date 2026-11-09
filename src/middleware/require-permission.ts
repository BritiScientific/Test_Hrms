import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors';

/**
 * Coarse gate: the user holds at least one of `codes`. This answers "may this
 * user perform this KIND of action?" — services still enforce data scope
 * (whose record) and workflow state (is this task mine and current).
 * Workflow task actions deliberately do NOT use this middleware: the required
 * permission comes from the workflow step (leave.request.approve, expense.approve, ...).
 */
export function requirePermission(...codes: string[]): RequestHandler {
  if (!codes.length) throw new Error('requirePermission needs at least one code');
  return (req, _res, next) => {
    const perms = req.auth?.permissions;
    if (!perms) return next(new AppError(401, 'UNAUTHENTICATED', 'Authentication required'));
    if (!codes.some((c) => perms.has(c))) {
      return next(new AppError(403, 'MISSING_PERMISSION', 'Permission denied'));
    }
    next();
  };
}

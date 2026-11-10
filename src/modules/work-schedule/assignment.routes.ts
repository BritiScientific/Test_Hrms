import { Router, type Request, type RequestHandler } from 'express';
import { withTenantTx, type Tx } from '../../config/db';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { forbidden } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { pickEmployees, pickerOptions } from './employee-picker.service';
import * as svc from './rotation-assignment.service';
import {
  AssignmentBulkEnd, AssignmentCancel, AssignmentCreate, AssignmentEnd, AssignmentListQuery, AssignmentPatch, PickerQuery,
} from './work-schedule.schemas';

/** Permission codes, one view/manage pair per kind of assignment. */
export const WSA = {
  rotatingShift: {
    view: 'workschedule.rotating_shift_assignment.view',
    manage: 'workschedule.rotating_shift_assignment.manage',
  },
  rotatingWorkType: {
    view: 'workschedule.rotating_work_type_assignment.view',
    manage: 'workschedule.rotating_work_type_assignment.manage',
  },
} as const;

type Perms = { view: string; manage: string };

/**
 * Assignment routes carry their own authenticate, scoped to their own paths,
 * rather than relying on router order. It is skipped when the request is
 * already authenticated (the parent /work-schedule guard runs first).
 */
const authOnce: RequestHandler = (req, res, next) => (req.auth ? next() : authenticate(req, res, next));

export const assignmentRouter = Router();
for (const prefix of ['rotating-shift-assignments', 'rotating-work-type-assignments', 'employee-picker']) {
  assignmentRouter.use(`/work-schedule/${prefix}`, authOnce);
}

type Handler = (tx: Tx, auth: AuthContext, req: Request) => Promise<unknown>;

function mount(path: string, perms: Perms, kind: svc.AssignmentKind) {
  const base = `/work-schedule/${path}`;
  const canView = requirePermission(perms.view, perms.manage);
  const canManage = requirePermission(perms.manage);
  const on = (h: Handler, status = 200) => tenantHandler(h, status);

  assignmentRouter.get(base, canView, on((tx, _a, r) => svc.listAssignments(tx, kind, AssignmentListQuery.parse(r.query))));

  // Fixed paths before /:id, so "export" and "bulk-end" are never read as an id.
  assignmentRouter.get(`${base}/export`, canView, (req, res, next) => {
    const auth = req.auth!;
    Promise.resolve()
      .then(() => {
        const q = AssignmentListQuery.parse(req.query);
        return withTenantTx(auth.tenantId, (tx) => svc.exportAssignmentsCsv(tx, kind, q));
      })
      .then(({ csv, truncated }) => {
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.setHeader('content-disposition', `attachment; filename="${kind.slug}-assignments.csv"`);
        res.setHeader('cache-control', 'no-store');
        if (truncated) res.setHeader('x-export-truncated', 'true');
        res.send(`﻿${csv}`); // BOM, so Excel reads UTF-8 names correctly
      })
      .catch(next);
  });
  assignmentRouter.post(`${base}/bulk-end`, canManage,
    on((tx, a, r) => svc.bulkEndAssignments(tx, a, kind, AssignmentBulkEnd.parse(r.body))));

  assignmentRouter.get(`${base}/:id`, canView, on((tx, _a, r) => svc.getAssignment(tx, kind, idParam(r))));
  assignmentRouter.post(base, canManage,
    on((tx, a, r) => svc.createAssignments(tx, a, kind, AssignmentCreate.parse(r.body)), 201));
  assignmentRouter.patch(`${base}/:id`, canManage,
    on((tx, a, r) => svc.updateAssignment(tx, a, kind, idParam(r), AssignmentPatch.parse(r.body))));
  assignmentRouter.patch(`${base}/:id/end`, canManage,
    on((tx, a, r) => svc.endAssignment(tx, a, kind, idParam(r), AssignmentEnd.parse(r.body))));
  assignmentRouter.patch(`${base}/:id/cancel`, canManage,
    on((tx, a, r) => svc.cancelAssignment(tx, a, kind, idParam(r), AssignmentCancel.parse(r.body))));
}

mount('rotating-shift-assignments', WSA.rotatingShift, svc.rotatingShiftAssignments);
mount('rotating-work-type-assignments', WSA.rotatingWorkType, svc.rotatingWorkTypeAssignments);

// ---- Employee picker (either manage permission; the kind decides which) ----------
const anyManage = requirePermission(WSA.rotatingShift.manage, WSA.rotatingWorkType.manage);
const manageFor = (slug: svc.AssignmentKind['slug']) =>
  slug === 'rotating-shift' ? WSA.rotatingShift.manage : WSA.rotatingWorkType.manage;

assignmentRouter.get('/work-schedule/employee-picker/options', anyManage, tenantHandler((tx) => pickerOptions(tx)));
assignmentRouter.get('/work-schedule/employee-picker', anyManage, tenantHandler((tx, auth, req) => {
  const q = PickerQuery.parse(req.query);
  if (!auth.permissions.has(manageFor(q.kind))) throw forbidden('MISSING_PERMISSION', 'Permission denied');
  return pickEmployees(tx, q.kind === 'rotating-shift' ? svc.rotatingShiftAssignments : svc.rotatingWorkTypeAssignments, q);
}));

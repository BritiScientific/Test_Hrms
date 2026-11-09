import { Router, type Request } from 'express';
import type { Tx } from '../../config/db';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import type { AuthContext } from '../../shared/types';
import * as employeeTypes from './employee-type.service';
import * as rotations from './rotation.service';
import * as schedules from './shift-schedule.service';
import * as shifts from './shift.service';
import * as workTypes from './work-type.service';
import {
  EmployeeTypeCreate, EmployeeTypePatch, ListQuery, RotationCreate, RotationPatch, ScheduleCreate, SchedulePatch,
  ShiftCreate, ShiftPatch, StatusBody, WorkTypeCreate, WorkTypePatch,
} from './work-schedule.schemas';

/** Permission codes, one view/manage pair per resource (module.resource.action). */
export const WS = {
  employeeType: { view: 'workschedule.employee_type.view', manage: 'workschedule.employee_type.manage' },
  shift: { view: 'workschedule.shift.view', manage: 'workschedule.shift.manage' },
  workType: { view: 'workschedule.work_type.view', manage: 'workschedule.work_type.manage' },
  rotatingShift: { view: 'workschedule.rotating_shift.view', manage: 'workschedule.rotating_shift.manage' },
  rotatingWorkType: { view: 'workschedule.rotating_work_type.view', manage: 'workschedule.rotating_work_type.manage' },
  shiftSchedule: { view: 'workschedule.shift_schedule.view', manage: 'workschedule.shift_schedule.manage' },
} as const;

type Handler<T> = (tx: Tx, auth: AuthContext, req: Request) => Promise<T>;

interface ResourceRoutes {
  list: Handler<unknown>;
  get: Handler<unknown>;
  create: Handler<unknown>;
  update: Handler<unknown>;
  status: Handler<unknown>;
}

export const workScheduleRouter = Router();
// Scoped to the paths this router owns, so an unknown URL still gets a 404.
workScheduleRouter.use('/work-schedule', authenticate);

/**
 * The same five routes for every resource. There is deliberately no DELETE
 * route: records are activated and deactivated, never removed.
 */
function mount(path: string, perms: { view: string; manage: string }, h: ResourceRoutes) {
  const base = `/work-schedule/${path}`;
  const canView = requirePermission(perms.view, perms.manage);
  const canManage = requirePermission(perms.manage);
  workScheduleRouter.get(base, canView, tenantHandler(h.list));
  workScheduleRouter.get(`${base}/:id`, canView, tenantHandler(h.get));
  workScheduleRouter.post(base, canManage, tenantHandler(h.create, 201));
  workScheduleRouter.patch(`${base}/:id`, canManage, tenantHandler(h.update));
  workScheduleRouter.patch(`${base}/:id/status`, canManage, tenantHandler(h.status));
}

const list = (req: Request) => ListQuery.parse(req.query);
const status = (req: Request) => StatusBody.parse(req.body);

// ---- Lookups for pickers (active records only) ------------------------------
// Anyone who may build a schedule or rotation needs the active list of what it references.
workScheduleRouter.get('/work-schedule/lookups/shifts',
  requirePermission(WS.shift.view, WS.shift.manage, WS.shiftSchedule.manage, WS.rotatingShift.manage),
  tenantHandler((tx) => shifts.shiftOptions(tx)));
workScheduleRouter.get('/work-schedule/lookups/work-types',
  requirePermission(WS.workType.view, WS.workType.manage, WS.rotatingWorkType.manage),
  tenantHandler((tx) => workTypes.workTypeOptions(tx)));

// ---- Employee types ---------------------------------------------------------
mount('employee-types', WS.employeeType, {
  list: (tx, _a, r) => employeeTypes.listEmployeeTypes(tx, list(r)),
  get: (tx, _a, r) => employeeTypes.getEmployeeType(tx, idParam(r)),
  create: (tx, a, r) => employeeTypes.createEmployeeType(tx, a, EmployeeTypeCreate.parse(r.body)),
  update: (tx, a, r) => employeeTypes.updateEmployeeType(tx, a, idParam(r), EmployeeTypePatch.parse(r.body)),
  status: (tx, a, r) => employeeTypes.setEmployeeTypeStatus(tx, a, idParam(r), status(r)),
});

// ---- Shifts -----------------------------------------------------------------
mount('shifts', WS.shift, {
  list: (tx, _a, r) => shifts.listShifts(tx, list(r)),
  get: (tx, _a, r) => shifts.getShift(tx, idParam(r)),
  create: (tx, a, r) => shifts.createShift(tx, a, ShiftCreate.parse(r.body)),
  update: (tx, a, r) => shifts.updateShift(tx, a, idParam(r), ShiftPatch.parse(r.body)),
  status: (tx, a, r) => shifts.setShiftStatus(tx, a, idParam(r), status(r)),
});

// ---- Work types -------------------------------------------------------------
mount('work-types', WS.workType, {
  list: (tx, _a, r) => workTypes.listWorkTypes(tx, list(r)),
  get: (tx, _a, r) => workTypes.getWorkType(tx, idParam(r)),
  create: (tx, a, r) => workTypes.createWorkType(tx, a, WorkTypeCreate.parse(r.body)),
  update: (tx, a, r) => workTypes.updateWorkType(tx, a, idParam(r), WorkTypePatch.parse(r.body)),
  status: (tx, a, r) => workTypes.setWorkTypeStatus(tx, a, idParam(r), status(r)),
});

// ---- Rotating shifts and rotating work types --------------------------------
for (const [path, perms, kind] of [
  ['rotating-shifts', WS.rotatingShift, rotations.rotatingShiftKind],
  ['rotating-work-types', WS.rotatingWorkType, rotations.rotatingWorkTypeKind],
] as const) {
  mount(path, perms, {
    list: (tx, _a, r) => rotations.listRotations(tx, kind, list(r)),
    get: (tx, _a, r) => rotations.getRotation(tx, kind, idParam(r)),
    create: (tx, a, r) => rotations.createRotation(tx, a, kind, RotationCreate.parse(r.body)),
    update: (tx, a, r) => rotations.updateRotation(tx, a, kind, idParam(r), RotationPatch.parse(r.body)),
    status: (tx, a, r) => rotations.setRotationStatus(tx, a, kind, idParam(r), status(r)),
  });
}

// ---- Shift schedules --------------------------------------------------------
mount('shift-schedules', WS.shiftSchedule, {
  list: (tx, _a, r) => schedules.listShiftSchedules(tx, list(r)),
  get: (tx, _a, r) => schedules.getShiftSchedule(tx, idParam(r)),
  create: (tx, a, r) => schedules.createShiftSchedule(tx, a, ScheduleCreate.parse(r.body)),
  update: (tx, a, r) => schedules.updateShiftSchedule(tx, a, idParam(r), SchedulePatch.parse(r.body)),
  status: (tx, a, r) => schedules.setShiftScheduleStatus(tx, a, idParam(r), status(r)),
});

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { P } from './leave-common';
import * as cfg from './leave-config.service';
import { isoDate, leaveHandler } from './leave.routes';

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
const id = z.coerce.number().int().positive();
const code = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]*$/, 'Start with a letter; letters, digits and _ only').max(30);
const days = z.coerce.number().min(0).max(999.99);
const optDays = z.preprocess(blankToNull, z.coerce.number().positive().max(999.99).nullable()).optional();
const optInt = z.preprocess(blankToNull, z.coerce.number().int().min(0).max(36500).nullable()).optional();
const optDate = z.preprocess(blankToNull, isoDate.nullable()).optional();

const TypeFields = {
  name: z.string().trim().min(2).max(100),
  description: optText(2000),
  category: z.enum(['casual', 'sick', 'earned', 'maternity', 'paternity', 'bereavement', 'comp_off', 'loss_of_pay', 'other']).optional(),
  isPaid: z.boolean().optional(),
  allowHalfDay: z.boolean().optional(),
  requiresAttachment: z.boolean().optional(),
  requiresContactDetails: z.boolean().optional(),
  allowBackdated: z.boolean().optional(),
  maxBackdatedDays: optInt,
  maxConsecutiveDays: optDays,
  minNoticeDays: z.coerce.number().int().min(0).max(365).optional(),
  includeNonWorkingDays: z.boolean().optional(),
};
const TypeCreate = z.object({ code, ...TypeFields }).strict();
const TypePatch = z.object({ ...TypeFields, name: TypeFields.name.optional(), isActive: z.boolean().optional() }).strict();

const PolicyFields = {
  name: z.string().trim().min(2).max(150),
  description: optText(2000),
  effectiveFrom: isoDate,
  effectiveTo: optDate,
};
const PolicyCreate = z.object({ code, ...PolicyFields }).strict();
const PolicyPatch = z.object({
  ...PolicyFields,
  name: PolicyFields.name.optional(),
  effectiveFrom: isoDate.optional(),
  isDefault: z.boolean().optional(),
}).strict();

const EntitlementFields = {
  annualEntitlement: days.optional(),
  allowNegativeBalance: z.boolean().optional(),
  allowCarryForward: z.boolean().optional(),
  allowEncashment: z.boolean().optional(),
  allowHalfDay: z.boolean().nullish(),
  maxConsecutiveDays: optDays,
};
const EntitlementCreate = z.object({ policyId: id, leaveTypeId: id, ...EntitlementFields }).strict();
const EntitlementPatch = z.object(EntitlementFields).strict();

const CalendarFields = {
  name: z.string().trim().min(2).max(150),
  description: optText(2000),
  location: optText(150),
  effectiveFrom: isoDate.optional(),
  effectiveTo: optDate,
};
const CalendarCreate = z.object({ code, calendarYear: z.coerce.number().int().min(2000).max(2100), ...CalendarFields }).strict();
const CalendarPatch = z.object({
  ...CalendarFields,
  name: CalendarFields.name.optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  isDefault: z.boolean().optional(),
}).strict();

const HolidayFields = {
  name: z.string().trim().min(2).max(150),
  holidayDate: isoDate,
  holidayType: z.enum(['national', 'state', 'festival', 'optional', 'organization']).optional(),
  isOptional: z.boolean().optional(),
  description: optText(500),
};
const HolidayCreate = z.object({ calendarId: id, ...HolidayFields }).strict();
const HolidayPatch = z.object({ ...HolidayFields, name: HolidayFields.name.optional(), holidayDate: isoDate.optional() }).strict();

const employeeIds = z.array(id).min(1).max(500);
const PolicyAssign = z.object({
  employeeIds, policyId: id, effectiveFrom: isoDate, effectiveTo: optDate, assignmentReason: optText(500),
}).strict();
const CalendarAssign = z.object({ employeeIds, calendarId: id, effectiveFrom: isoDate, effectiveTo: optDate }).strict();
const EndAssignment = z.object({ effectiveTo: z.preprocess(blankToNull, isoDate.nullable()) }).strict();

const AccrualFields = {
  accrualFrequency: z.enum(['annual', 'monthly', 'quarterly', 'joining_date', 'one_time', 'manual']),
  accrualAmount: days.optional(),
  accrualStartRule: z.enum(['joining_date', 'next_period']).optional(),
  creditTiming: z.enum(['period_start', 'period_end']).optional(),
  prorationEnabled: z.boolean().optional(),
  maximumBalance: optDays,
  effectiveFrom: isoDate,
  effectiveTo: optDate,
};
const AccrualCreate = z.object({ policyEntitlementId: id, ...AccrualFields }).strict();
const AccrualPatch = z.object({
  ...AccrualFields, accrualFrequency: AccrualFields.accrualFrequency.optional(), effectiveFrom: isoDate.optional(),
}).strict();

const CarryFields = {
  isEnabled: z.boolean().optional(),
  maximumCarryForward: z.preprocess(blankToNull, z.coerce.number().min(0).max(999.99).nullable()).optional(),
  maximumBalance: optDays,
  expiryEnabled: z.boolean().optional(),
  expiryAfterMonths: z.preprocess(blankToNull, z.coerce.number().int().positive().max(60).nullable()).optional(),
  expiryDateRule: z.enum(['months_after_carry', 'end_of_next_year']).optional(),
  encashmentAllowed: z.boolean().optional(),
  effectiveFrom: isoDate,
  effectiveTo: optDate,
};
const CarryCreate = z.object({ policyEntitlementId: id, ...CarryFields }).strict();
const CarryPatch = z.object({ ...CarryFields, effectiveFrom: isoDate.optional() }).strict();

const CompOffFields = {
  minimumWorkHours: z.coerce.number().positive().max(24),
  earnedDays: z.coerce.number().positive().max(10),
  eligibleWorkDayType: z.enum(['weekly_off', 'holiday', 'non_working', 'any']).optional(),
  approvalRequired: z.boolean().optional(),
  expiryEnabled: z.boolean().optional(),
  expiryAfterDays: z.preprocess(blankToNull, z.coerce.number().int().positive().max(3650).nullable()).optional(),
  maximumBalance: optDays,
  effectiveFrom: isoDate,
  effectiveTo: optDate,
};
const CompOffCreate = z.object({ leaveTypeId: id, ...CompOffFields }).strict();
const CompOffPatch = z.object({
  ...CompOffFields,
  minimumWorkHours: CompOffFields.minimumWorkHours.optional(),
  earnedDays: CompOffFields.earnedDays.optional(),
  effectiveFrom: isoDate.optional(),
  isActive: z.boolean().optional(),
}).strict();

const canRead = requirePermission(P.configView, P.configManage);
const canWrite = requirePermission(P.configManage);
const canReadAssignments = requirePermission(P.configView, P.configManage, P.policyAssign);
const canAssign = requirePermission(P.policyAssign);

const optionalId = (v: unknown) => (v === undefined ? undefined : id.parse(v));

export const leaveConfigRouter = Router();
leaveConfigRouter.use('/leave/config', authenticate);

// ---- Leave types (deactivate instead of delete) ----------------------------
leaveConfigRouter.get('/leave/config/types', canRead, leaveHandler((tx) => cfg.listTypes(tx)));
leaveConfigRouter.post('/leave/config/types', canWrite, leaveHandler((tx, a, r) => cfg.createType(tx, a, TypeCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/types/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateType(tx, a, idParam(r), TypePatch.parse(r.body))));

// ---- Policies --------------------------------------------------------------
leaveConfigRouter.get('/leave/config/policies', canRead, leaveHandler((tx) => cfg.listPolicies(tx)));
leaveConfigRouter.get('/leave/config/policies/:id', canRead, leaveHandler((tx, _a, r) => cfg.getPolicy(tx, idParam(r))));
leaveConfigRouter.post('/leave/config/policies', canWrite, leaveHandler((tx, a, r) => cfg.createPolicy(tx, a, PolicyCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/policies/:id', canWrite, leaveHandler((tx, a, r) => cfg.updatePolicy(tx, a, idParam(r), PolicyPatch.parse(r.body))));
leaveConfigRouter.get('/leave/config/policies/:id/activation-check', canRead, leaveHandler((tx, _a, r) => cfg.validatePolicyForActivation(tx, idParam(r))));
leaveConfigRouter.post('/leave/config/policies/:id/activate', canWrite, leaveHandler((tx, a, r) => cfg.activatePolicy(tx, a, idParam(r))));
leaveConfigRouter.post('/leave/config/policies/:id/archive', canWrite, leaveHandler((tx, a, r) => cfg.archivePolicy(tx, a, idParam(r))));

// ---- Entitlements ----------------------------------------------------------
leaveConfigRouter.get('/leave/config/entitlements', canRead, leaveHandler((tx, _a, r) => cfg.listEntitlements(tx, optionalId(r.query.policyId))));
leaveConfigRouter.post('/leave/config/entitlements', canWrite, leaveHandler((tx, a, r) => cfg.createEntitlement(tx, a, EntitlementCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/entitlements/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateEntitlement(tx, a, idParam(r), EntitlementPatch.parse(r.body))));
leaveConfigRouter.delete('/leave/config/entitlements/:id', canWrite, tenantHandler(async (tx, a, r) => { await cfg.deleteEntitlement(tx, a, idParam(r)); }));

// ---- Holiday calendars -----------------------------------------------------
leaveConfigRouter.get('/leave/config/holiday-calendars', canRead,
  leaveHandler((tx, _a, r) => cfg.listCalendars(tx, { year: r.query.year ? z.coerce.number().int().parse(r.query.year) : undefined })));
leaveConfigRouter.post('/leave/config/holiday-calendars', canWrite, leaveHandler((tx, a, r) => cfg.createCalendar(tx, a, CalendarCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/holiday-calendars/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateCalendar(tx, a, idParam(r), CalendarPatch.parse(r.body))));

leaveConfigRouter.get('/leave/config/holidays', canRead,
  leaveHandler((tx, _a, r) => cfg.listHolidays(tx, {
    calendarId: optionalId(r.query.calendarId),
    year: r.query.year ? z.coerce.number().int().parse(r.query.year) : undefined,
  })));
leaveConfigRouter.post('/leave/config/holidays', canWrite, leaveHandler((tx, a, r) => cfg.createHoliday(tx, a, HolidayCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/holidays/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateHoliday(tx, a, idParam(r), HolidayPatch.parse(r.body))));
leaveConfigRouter.delete('/leave/config/holidays/:id', canWrite, tenantHandler(async (tx, a, r) => { await cfg.deleteHoliday(tx, a, idParam(r)); }));

// ---- Employee assignments --------------------------------------------------
leaveConfigRouter.get('/leave/config/employee-assignments', canReadAssignments,
  leaveHandler((tx, _a, r) => cfg.listEmployeeAssignments(tx, z.object({
    search: z.string().trim().max(100).optional(),
    departmentId: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }).parse(r.query))));

leaveConfigRouter.get('/leave/config/policy-assignments', canReadAssignments,
  leaveHandler((tx, _a, r) => cfg.listPolicyAssignments(tx, { employeeId: optionalId(r.query.employeeId), policyId: optionalId(r.query.policyId) })));
leaveConfigRouter.post('/leave/config/policy-assignments', canAssign, leaveHandler((tx, a, r) => cfg.assignPolicy(tx, a, PolicyAssign.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/policy-assignments/:id', canAssign,
  leaveHandler((tx, a, r) => cfg.endPolicyAssignment(tx, a, idParam(r), EndAssignment.parse(r.body).effectiveTo)));
leaveConfigRouter.delete('/leave/config/policy-assignments/:id', canAssign,
  tenantHandler(async (tx, a, r) => { await cfg.deletePolicyAssignment(tx, a, idParam(r)); }));

leaveConfigRouter.get('/leave/config/calendar-assignments', canReadAssignments,
  leaveHandler((tx, _a, r) => cfg.listCalendarAssignments(tx, { employeeId: optionalId(r.query.employeeId), calendarId: optionalId(r.query.calendarId) })));
leaveConfigRouter.post('/leave/config/calendar-assignments', canAssign, leaveHandler((tx, a, r) => cfg.assignCalendar(tx, a, CalendarAssign.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/calendar-assignments/:id', canAssign,
  leaveHandler((tx, a, r) => cfg.endCalendarAssignment(tx, a, idParam(r), EndAssignment.parse(r.body).effectiveTo)));
leaveConfigRouter.delete('/leave/config/calendar-assignments/:id', canAssign,
  tenantHandler(async (tx, a, r) => { await cfg.deleteCalendarAssignment(tx, a, idParam(r)); }));

// ---- Accrual, carry-forward and comp off rules -----------------------------
leaveConfigRouter.get('/leave/config/accrual-rules', canRead, leaveHandler((tx, _a, r) => cfg.listAccrualRules(tx, { policyId: optionalId(r.query.policyId) })));
leaveConfigRouter.post('/leave/config/accrual-rules', canWrite, leaveHandler((tx, a, r) => cfg.createAccrualRule(tx, a, AccrualCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/accrual-rules/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateAccrualRule(tx, a, idParam(r), AccrualPatch.parse(r.body))));
leaveConfigRouter.get('/leave/config/accrual-rules/:id/impact', canRead, leaveHandler((tx, a, r) => cfg.getAccrualImpact(tx, a, idParam(r))));
leaveConfigRouter.post('/leave/config/accrual-rules/:id/activate', canWrite, leaveHandler((tx, a, r) => cfg.activateAccrualRule(tx, a, idParam(r))));
leaveConfigRouter.post('/leave/config/accrual-rules/:id/archive', canWrite, leaveHandler((tx, a, r) => cfg.archiveAccrualRule(tx, a, idParam(r))));

leaveConfigRouter.get('/leave/config/carry-forward-rules', canRead, leaveHandler((tx, _a, r) => cfg.listCarryForwardRules(tx, { policyId: optionalId(r.query.policyId) })));
leaveConfigRouter.post('/leave/config/carry-forward-rules', canWrite, leaveHandler((tx, a, r) => cfg.createCarryForwardRule(tx, a, CarryCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/carry-forward-rules/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateCarryForwardRule(tx, a, idParam(r), CarryPatch.parse(r.body))));
leaveConfigRouter.post('/leave/config/carry-forward-rules/:id/activate', canWrite, leaveHandler((tx, a, r) => cfg.activateCarryForwardRule(tx, a, idParam(r))));
leaveConfigRouter.post('/leave/config/carry-forward-rules/:id/archive', canWrite, leaveHandler((tx, a, r) => cfg.archiveCarryForwardRule(tx, a, idParam(r))));

leaveConfigRouter.get('/leave/config/comp-off-rules', canRead, leaveHandler((tx) => cfg.listCompOffRules(tx)));
leaveConfigRouter.post('/leave/config/comp-off-rules', canWrite, leaveHandler((tx, a, r) => cfg.createCompOffRule(tx, a, CompOffCreate.parse(r.body)), 201));
leaveConfigRouter.patch('/leave/config/comp-off-rules/:id', canWrite, leaveHandler((tx, a, r) => cfg.updateCompOffRule(tx, a, idParam(r), CompOffPatch.parse(r.body))));

// ---- Workflow builder options ----------------------------------------------
leaveConfigRouter.get('/leave/config/workflow-options', requirePermission(P.configView, P.configManage, 'workflow.view', 'workflow.configure'),
  leaveHandler((tx, _a, r) => cfg.getWorkflowOptions(tx, z.enum(['leave', 'comp_off']).catch('leave').parse(r.query.module))));

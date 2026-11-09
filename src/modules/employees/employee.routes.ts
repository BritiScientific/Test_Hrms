import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { forbidden } from '../../shared/errors';
import { employeeTypeOptions } from '../work-schedule/employee-type.service';
import * as emp from './employee.service';

// ------------------------------------------------------------- schemas ----
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const optText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()), 'Invalid date');
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{5,40}$/, 'Digits, spaces, +, ( ) and - only');
const optId = z.preprocess(blankToNull, z.coerce.number().int().positive().nullable()).optional();

/** Fields an employee may fill for themselves (HR may fill them too). */
const SelfFields = {
  preferredName: optText(100),
  dateOfBirth: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  gender: z.preprocess(blankToNull, z.enum(['female', 'male', 'non_binary', 'other', 'prefer_not_to_say']).nullable()).optional(),
  personalEmail: z.preprocess(blankToNull, z.string().trim().email().max(254).nullable()).optional(),
  mobilePhone: z.preprocess(blankToNull, phone.nullable()).optional(),
  address: z.object({
    line1: optText(200),
    line2: optText(200),
    city: optText(100),
    stateProvince: optText(100),
    postalCode: optText(20),
    countryCode: z.preprocess(
      (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
      z.string().regex(/^[A-Z]{2}$/).nullable(),
    ).optional(),
  }).strict().optional(),
  emergencyContact: z.object({
    name: optText(200),
    relation: optText(60),
    phone: z.preprocess(blankToNull, phone.nullable()).optional(),
  }).strict().optional(),
  version: z.coerce.number().int().positive().optional(),
};

const SelfPatch = z.object(SelfFields).strict();

const HrPatch = z.object({
  ...SelfFields,
  fullName: z.string().trim().min(2).max(200).optional(),
  employeeCode: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only').optional(),
  departmentId: optId,
  managerId: optId,
  jobTitle: optText(150),
  /** Legacy field, still accepted from older clients; mapped to the matching default employee type. */
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  /** Preferred: the tenant's employee type. employment_type is then set from its base category. */
  employeeTypeId: z.coerce.number().int().positive().optional(),
  workLocation: optText(150),
  dateOfJoining: isoDate.optional(),
  status: z.enum(['active', 'on_notice', 'exited']).optional(),
}).strict();

/** Quick add: only name, work email and joining date are mandatory. */
const QuickAdd = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(200),
  workEmail: z.string().trim().email('Enter a valid email address').max(254),
  dateOfJoining: isoDate,
  employeeCode: z.preprocess(blankToNull,
    z.string().trim().max(50).regex(/^[A-Za-z0-9_-]+$/, 'Letters, digits, - and _ only').nullable()).optional(),
  departmentId: optId,
  managerId: optId,
  jobTitle: optText(150),
  employmentType: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  employeeTypeId: z.coerce.number().int().positive().optional(),
  roleIds: z.array(z.coerce.number().int().positive()).max(10).optional(),
  sendInvite: z.boolean().optional(),
}).strict();

const ListQuery = z.object({
  search: z.string().max(100).optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  access: z.enum(['active', 'invited', 'invite_expired', 'no_login', 'suspended', 'left']).optional(),
  status: z.enum(['current', 'exited', 'all']).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const DepartmentBody = z.object({ name: z.string().trim().min(2).max(150) }).strict();

// -------------------------------------------------------------- routes ----
export const employeeRouter = Router();
employeeRouter.use('/employees', authenticate);
employeeRouter.use('/departments', authenticate);
employeeRouter.use('/me/employee', authenticate);

const canView = requirePermission('employee.view', 'employee.create', 'employee.update');

employeeRouter.get('/employees', requirePermission('employee.view'),
  tenantHandler((tx, _a, req) => emp.listEmployees(tx, ListQuery.parse(req.query))));

employeeRouter.get('/employees/next-code', requirePermission('employee.create'),
  tenantHandler(async (tx) => ({ employeeCode: await emp.nextEmployeeCode(tx) })));

/** Active employee types for the create/edit form. Needs no workschedule.* permission. */
employeeRouter.get('/employees/lookups/employee-types', requirePermission('employee.create', 'employee.update'),
  tenantHandler((tx) => employeeTypeOptions(tx)));

/** A — Quick add: one transaction for login, membership, record, manager, roles and activation link. */
employeeRouter.post('/employees', requirePermission('employee.create'),
  tenantHandler((tx, auth, req) => emp.quickAddEmployee(tx, auth, QuickAdd.parse(req.body)), 201));

employeeRouter.get('/employees/:id', tenantHandler((tx, auth, req) => {
  const id = idParam(req);
  const allowed = id === auth.employeeId || auth.permissions.has('employee.view');
  if (!allowed) throw forbidden('MISSING_PERMISSION', 'Permission denied');
  return emp.getEmployee(tx, id);
}));

/** HR can fill or correct ANY field, including the self-service ones. */
employeeRouter.patch('/employees/:id', requirePermission('employee.update'),
  tenantHandler((tx, auth, req) => emp.updateEmployee(tx, auth, idParam(req), HrPatch.parse(req.body), 'hr')));

/** New one-time activation link (previous unused links stop working). */
employeeRouter.post('/employees/:id/invitation', requirePermission('employee.create'),
  tenantHandler((tx, auth, req) => emp.reissueInvitation(tx, auth, idParam(req)), 201));

/** D — Self-service: the signed-in employee's own record; only self-service fields are writable. */
employeeRouter.get('/me/employee', tenantHandler((tx, auth) => emp.getOwnEmployee(tx, auth)));
employeeRouter.patch('/me/employee', tenantHandler(async (tx, auth, req) => {
  const own = await emp.getOwnEmployee(tx, auth);
  return emp.updateEmployee(tx, auth, own.id, SelfPatch.parse(req.body), 'self');
}));

employeeRouter.get('/departments', canView, tenantHandler((tx) => emp.listDepartments(tx)));
employeeRouter.post('/departments', requirePermission('employee.create', 'employee.update'),
  tenantHandler((tx, auth, req) => emp.createDepartment(tx, auth, DepartmentBody.parse(req.body).name), 201));

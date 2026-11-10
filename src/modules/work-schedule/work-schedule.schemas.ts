import { z } from 'zod';

/**
 * Request schemas. Every body is .strict(): tenant_id, created_by and
 * is_active can never arrive through create/edit (status changes go through
 * the status endpoint only).
 */

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
const description = z.preprocess(blankToNull, z.string().trim().max(2000).nullable()).optional();
const name = z.string().trim().min(2, 'Enter at least 2 characters').max(150);
export const id = z.coerce.number().int().positive();

/** Optimistic-lock token: the updatedAt the client last read. */
const updatedAt = z.string().datetime({ offset: true, message: 'updatedAt must be an ISO timestamp' });

// ------------------------------------------------------------- list query ---
export const SORTABLE = ['name', 'createdAt', 'updatedAt'] as const;
export const ListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  // "name" ascending, "-updatedAt" descending. Whitelisted: never interpolated from input.
  sort: z.string().regex(/^-?(name|createdAt|updatedAt)$/, 'Sort by name, createdAt or updatedAt').default('name'),
}).strict();
export type ListQuery = z.infer<typeof ListQuery>;

export const StatusBody = z.object({ isActive: z.boolean(), updatedAt }).strict();
export type StatusBody = z.infer<typeof StatusBody>;

// ---------------------------------------------------------- employee types ---
export const BASE_CATEGORIES = ['full_time', 'part_time', 'contract', 'intern'] as const;
const baseCategory = z.enum(BASE_CATEGORIES, { message: 'Choose Full-time, Part-time, Contract or Intern' });

export const EmployeeTypeCreate = z.object({ name, description, baseCategory }).strict();
export const EmployeeTypePatch = z.object({
  name: name.optional(), description, baseCategory: baseCategory.optional(), updatedAt,
}).strict();

// ------------------------------------------------------------------ shifts ---
const graceTimeMinutes = z.coerce.number().int('Whole minutes only')
  .min(0, 'Grace time cannot be negative').max(240, 'Grace time is at most 240 minutes');

export const ShiftCreate = z.object({ name, description, graceTimeMinutes: graceTimeMinutes.default(0) }).strict();
export const ShiftPatch = z.object({ name: name.optional(), description, graceTimeMinutes: graceTimeMinutes.optional(), updatedAt }).strict();

// -------------------------------------------------------------- work types ---
export const WorkTypeCreate = z.object({ name, description }).strict();
export const WorkTypePatch = z.object({ name: name.optional(), description, updatedAt }).strict();

// --------------------------------------------------------------- rotations ---
const rotationInterval = z.coerce.number().int().min(1, 'Interval is at least 1').max(365, 'Interval is at most 365');
const rotationUnit = z.enum(['days', 'weeks'], { message: 'Unit must be days or weeks' });
/** Ids in rotation order. sequence_order is renumbered 1..n from this order. */
const items = z.array(id).min(2, 'Add at least 2 entries').max(20, 'At most 20 entries')
  .refine((a) => new Set(a).size === a.length, 'Each entry can appear only once');

export const RotationCreate = z.object({
  name, description, rotationInterval: rotationInterval.default(1), rotationUnit: rotationUnit.default('days'), items,
}).strict();
export const RotationPatch = z.object({
  name: name.optional(), description, rotationInterval: rotationInterval.optional(),
  rotationUnit: rotationUnit.optional(), items: items.optional(), updatedAt,
}).strict();
export type RotationCreate = z.infer<typeof RotationCreate>;
export type RotationPatch = z.infer<typeof RotationPatch>;

// --------------------------------------------------------- shift schedules ---
const time = z.preprocess(blankToNull,
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24-hour)').nullable()).optional();
const minutes = z.coerce.number().int('Whole minutes only').min(0).max(1440, 'At most 24 hours');

const ScheduleDay = z.object({
  dayOfWeek: z.coerce.number().int().min(1).max(7),
  isWorkingDay: z.boolean(),
  startTime: time,
  endTime: time,
  minimumWorkingMinutes: minutes.nullish(),
}).strict();
export type ScheduleDay = z.infer<typeof ScheduleDay>;

const days = z.array(ScheduleDay).length(7, 'A schedule needs exactly 7 days, Monday to Sunday');

export const ScheduleCreate = z.object({
  name, description, shiftId: id,
  defaultMinimumWorkingMinutes: minutes.default(0),
  automaticCheckoutEnabled: z.boolean().default(false),
  days,
}).strict();
export const SchedulePatch = z.object({
  name: name.optional(), description, shiftId: id.optional(),
  defaultMinimumWorkingMinutes: minutes.optional(),
  automaticCheckoutEnabled: z.boolean().optional(),
  days: days.optional(),
  updatedAt,
}).strict();
export type ScheduleCreate = z.infer<typeof ScheduleCreate>;
export type SchedulePatch = z.infer<typeof SchedulePatch>;

// ------------------------------------------------------ rotation assignments ---
/** A real calendar date: Date quietly turns 02-31 into 03-03, so round-trip it. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, 'Invalid date');
const optDate = z.preprocess(blankToNull, isoDate.nullable()).optional();
const reason = z.preprocess(blankToNull, z.string().trim().max(500, 'At most 500 characters').nullable()).optional();

export const MAX_BULK = 200;

const whole = (what: string, min: number, max: number) =>
  z.coerce.number({ message: `${what} must be a number` }).int(`${what} must be a whole number`)
    .min(min, `${what} must be at least ${min}`).max(max, `${what} must be at most ${max}`);

/** How the rotation switches: every N days, on a weekday (1 = Monday), or on a day of the month. */
export const RotationRuleInput = z.discriminatedUnion('basedOn', [
  z.object({ basedOn: z.literal('after'), afterDays: whole('Days', 1, 365) }).strict(),
  z.object({ basedOn: z.literal('weekly'), weekday: whole('Weekday', 1, 7) }).strict(),
  z.object({ basedOn: z.literal('monthly'), monthDay: z.union([z.literal('last'), whole('Day of month', 1, 31)]) }).strict(),
], { message: 'Choose how the rotation repeats' });

export const AssignmentCreate = z.object({
  employeeIds: z.array(id).min(1, 'Choose at least one employee').max(MAX_BULK, `At most ${MAX_BULK} employees at a time`)
    .refine((a) => new Set(a).size === a.length, 'An employee was chosen twice'),
  patternId: id,
  startDate: isoDate,
  rotation: RotationRuleInput,
  reason,
}).strict();
export type AssignmentCreate = z.infer<typeof AssignmentCreate>;

export const AssignmentPatch = z.object({
  patternId: id.optional(),
  startDate: isoDate.optional(),
  rotation: RotationRuleInput.optional(),
  endDate: optDate,
  reason,
  updatedAt,
}).strict();
export type AssignmentPatch = z.infer<typeof AssignmentPatch>;

export const AssignmentEnd = z.object({ endDate: optDate, updatedAt }).strict();
export const AssignmentCancel = z.object({ reason, updatedAt }).strict();
export const AssignmentBulkEnd = z.object({
  ids: z.array(id).min(1).max(MAX_BULK).refine((a) => new Set(a).size === a.length, 'An assignment was chosen twice'),
  endDate: optDate,
}).strict();

export const AssignmentListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', 'ended', 'cancelled']).default('all'),
  patternId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['-startDate', 'startDate', 'employee', '-employee']).default('-startDate'),
}).strict();
export type AssignmentListQuery = z.infer<typeof AssignmentListQuery>;

export const PickerQuery = z.object({
  kind: z.enum(['rotating-shift', 'rotating-work-type']),
  search: z.string().trim().max(100).optional(),
  departmentId: id.optional(),
  jobTitle: z.string().trim().max(150).optional(),
  employeeTypeId: id.optional(),
  roleId: id.optional(),
  managerId: id.optional(),
  joinedFrom: isoDate.optional(),
  joinedTo: isoDate.optional(),
  assignment: z.enum(['assigned', 'unassigned']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  idsOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
}).strict();
export type PickerQuery = z.infer<typeof PickerQuery>;

export type AssignmentBulkEnd = z.infer<typeof AssignmentBulkEnd>;

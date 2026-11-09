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

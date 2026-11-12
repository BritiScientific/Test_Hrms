import { z } from 'zod';

/**
 * Request schemas. Every body is .strict(): tenant_id, created_by, status
 * columns and counters can never arrive through a create or edit.
 */

const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const id = z.coerce.number().int().positive();
const optText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable()).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()), 'Invalid date');
const isoDateTime = z.string().datetime({ offset: true, message: 'Use an ISO date and time' });
const updatedAt = z.string().datetime({ offset: true, message: 'updatedAt must be an ISO timestamp' });
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{5,40}$/, 'Digits, spaces, +, ( ) and - only');
const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const httpUrl = z.string().trim().max(500).url('Enter a full link starting with https://')
  .refine((u) => /^https?:\/\//i.test(u), 'Link must start with http:// or https://');
const pageParams = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const STAGE_TYPES = ['applied', 'initial', 'test', 'interview', 'shortlisted', 'hired', 'rejected'] as const;
export type StageType = (typeof STAGE_TYPES)[number];
export const SOURCES = ['careers', 'manual', 'referral', 'agency', 'other'] as const;

/** The pipeline a new recruitment starts with; HR reshapes it in the wizard. */
export const DEFAULT_STAGES: { name: string; stageType: StageType }[] = [
  { name: 'Applied', stageType: 'applied' },
  { name: 'Initial', stageType: 'initial' },
  { name: 'Technical Test', stageType: 'test' },
  { name: 'Interview', stageType: 'interview' },
  { name: 'Shortlisted', stageType: 'shortlisted' },
  { name: 'Hired', stageType: 'hired' },
  { name: 'Rejected', stageType: 'rejected' },
];

// -------------------------------------------------------------- recruitment --
const skill = z.string().trim().min(1).max(50);
const vacancyLine = z.object({
  jobPositionId: id,
  vacancies: z.coerce.number().int('Whole numbers only').min(1, 'At least 1').max(1000, 'At most 1000'),
}).strict();
const stageLine = z.object({
  id: id.optional(),
  name: z.string().trim().min(1, 'Name the stage').max(100),
  stageType: z.enum(STAGE_TYPES, { message: 'Choose a stage type' }),
}).strict();

const recruitmentFields = {
  title: z.string().trim().min(3, 'Enter at least 3 characters').max(200),
  description: z.string().trim().min(1, 'Add a description').max(20_000),
  managerIds: z.array(id).min(1, 'Choose at least one manager').max(20)
    .refine((a) => new Set(a).size === a.length, 'Each manager can appear only once'),
  startDate: isoDate,
  endDate: z.preprocess(blankToNull, isoDate.nullable()).optional(),
  surveyTemplateId: z.preprocess(blankToNull, id.nullable()).optional(),
  skills: z.array(skill).max(30).default([]),
  isPublished: z.boolean().default(false),
  optionalResume: z.boolean().default(false),
  optionalPhoto: z.boolean().default(true),
  vacancies: z.array(vacancyLine).min(1, 'Add at least one vacancy line').max(20)
    .refine((a) => new Set(a.map((v) => v.jobPositionId)).size === a.length, 'Each job position can appear only once'),
  stages: z.array(stageLine).min(3, 'A pipeline needs at least 3 stages').max(20),
};

export const RecruitmentCreate = z.object({
  ...recruitmentFields,
  stages: recruitmentFields.stages.default(DEFAULT_STAGES),
}).strict().refine((b) => !b.endDate || b.endDate >= b.startDate, { path: ['endDate'], message: 'End date is before the start date' });

export const RecruitmentPatch = z.object({
  title: recruitmentFields.title.optional(),
  description: recruitmentFields.description.optional(),
  managerIds: recruitmentFields.managerIds.optional(),
  startDate: isoDate.optional(),
  endDate: recruitmentFields.endDate,
  surveyTemplateId: recruitmentFields.surveyTemplateId,
  skills: z.array(skill).max(30).optional(),
  isPublished: z.boolean().optional(),
  optionalResume: z.boolean().optional(),
  optionalPhoto: z.boolean().optional(),
  vacancies: recruitmentFields.vacancies.optional(),
  stages: recruitmentFields.stages.optional(),
  updatedAt,
}).strict();

export const RecruitmentStatusBody = z.object({ status: z.enum(['open', 'closed']), updatedAt }).strict();

export const RecruitmentListQuery = z.object({
  status: z.enum(['all', 'open', 'closed']).default('open'),
  search: z.string().trim().max(100).optional(),
  ...pageParams,
  limit: z.coerce.number().int().min(1).max(200).default(100),
}).strict();

// ------------------------------------------------------------- applications --
export const ApplicationListQuery = z.object({
  recruitmentId: id.optional(),
  stageId: id.optional(),
  candidateId: id.optional(),
  status: z.enum(['all', 'active', 'hired', 'rejected']).default('all'),
  search: z.string().trim().max(100).optional(),
  jobPositionId: id.optional(),
  sort: z.enum(['recent', 'oldest', 'name', 'rating']).default('recent'),
  ...pageParams,
}).strict();

export const ApplicationCreate = z.object({
  fullName: z.string().trim().min(2, 'Enter at least 2 characters').max(200),
  email,
  phone: z.preprocess(blankToNull, phone.nullable()).optional(),
  currentCompany: optText(200),
  currentTitle: optText(200),
  experienceYears: z.preprocess(blankToNull, z.coerce.number().min(0).max(80).nullable()).optional(),
  location: optText(200),
  linkedinUrl: z.preprocess(blankToNull, httpUrl.nullable()).optional(),
  jobPositionId: z.preprocess(blankToNull, id.nullable()).optional(),
  source: z.enum(['manual', 'referral', 'agency', 'other']).default('manual'),
  coverLetter: optText(5000),
  resume: z.object({ id, claimToken: z.string().uuid() }).strict().optional(),
  photo: z.object({ id, claimToken: z.string().uuid() }).strict().optional(),
}).strict();

export const ApplicationMove = z.object({
  stageId: id,
  updatedAt,
  note: optText(1000),
  /** Used when the target stage is the rejected stage. */
  rejectionReasonId: z.preprocess(blankToNull, id.nullable()).optional(),
  rejectionNote: optText(2000),
}).strict();

export const ApplicationBulkMove = z.object({
  ids: z.array(id).min(1).max(100).refine((a) => new Set(a).size === a.length, 'Duplicate candidates'),
  stageId: id,
  rejectionReasonId: z.preprocess(blankToNull, id.nullable()).optional(),
  rejectionNote: optText(2000),
}).strict();

export const ApplicationPatch = z.object({
  rating: z.preprocess(blankToNull, z.coerce.number().int().min(1).max(5).nullable()).optional(),
  jobPositionId: z.preprocess(blankToNull, id.nullable()).optional(),
  updatedAt,
}).strict();

export const NoteBody = z.object({ body: z.string().trim().min(1, 'Write a note').max(4000) }).strict();

export const CandidateListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  source: z.enum(SOURCES).optional(),
  recruitmentId: id.optional(),
  sort: z.enum(['recent', 'name']).default('recent'),
  ...pageParams,
}).strict();

export const CandidatePatch = z.object({
  fullName: z.string().trim().min(2).max(200).optional(),
  phone: z.preprocess(blankToNull, phone.nullable()).optional(),
  currentCompany: optText(200),
  currentTitle: optText(200),
  experienceYears: z.preprocess(blankToNull, z.coerce.number().min(0).max(80).nullable()).optional(),
  location: optText(200),
  linkedinUrl: z.preprocess(blankToNull, httpUrl.nullable()).optional(),
  updatedAt,
}).strict();

// -------------------------------------------------------------- interviews ---
export const INTERVIEW_MODES = ['video', 'in_person', 'phone'] as const;
const interviewFields = {
  title: z.string().trim().min(2, 'Enter at least 2 characters').max(150),
  startsAt: isoDateTime,
  endsAt: isoDateTime,
  mode: z.enum(INTERVIEW_MODES, { message: 'Choose video, in person or phone' }),
  location: optText(300),
  meetingLink: z.preprocess(blankToNull, httpUrl.nullable()).optional(),
  notes: optText(2000),
  interviewerIds: z.array(id).min(1, 'Choose at least one interviewer').max(10)
    .refine((a) => new Set(a).size === a.length, 'Each interviewer can appear only once'),
};

export const InterviewCreate = z.object({
  applicationId: id,
  ...interviewFields,
  /** Schedule even if an interviewer is already booked. */
  allowConflicts: z.boolean().default(false),
}).strict();

export const InterviewPatch = z.object({
  title: interviewFields.title.optional(),
  startsAt: isoDateTime.optional(),
  endsAt: isoDateTime.optional(),
  mode: interviewFields.mode.optional(),
  location: interviewFields.location,
  meetingLink: interviewFields.meetingLink,
  notes: interviewFields.notes,
  interviewerIds: interviewFields.interviewerIds.optional(),
  allowConflicts: z.boolean().default(false),
  updatedAt,
}).strict();

export const InterviewStatusBody = z.object({
  status: z.enum(['completed', 'cancelled', 'no_show']),
  reason: optText(1000),
  updatedAt,
}).strict();

export const InterviewListQuery = z.object({
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  status: z.enum(['all', 'scheduled', 'completed', 'cancelled', 'no_show']).default('all'),
  recruitmentId: id.optional(),
  applicationId: id.optional(),
  mine: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  ...pageParams,
}).strict();

export const FeedbackBody = z.object({
  rating: z.coerce.number().int().min(1, 'Rate 1 to 5').max(5, 'Rate 1 to 5'),
  recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no'], { message: 'Choose a recommendation' }),
  strengths: optText(3000),
  concerns: optText(3000),
  comments: optText(3000),
}).strict();

// ----------------------------------------------------------- configuration ---
const name = z.string().trim().min(2, 'Enter at least 2 characters').max(150);
const description = optText(2000);
const status = z.object({ isActive: z.boolean(), updatedAt }).strict();

export const ConfigListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
  ...pageParams,
}).strict();
export const ConfigStatusBody = status;

export const JobPositionCreate = z.object({
  title: z.string().trim().min(2, 'Enter at least 2 characters').max(150),
  departmentId: z.preprocess(blankToNull, id.nullable()).optional(),
  description,
}).strict();
export const JobPositionPatch = z.object({
  title: JobPositionCreate.shape.title.optional(), departmentId: JobPositionCreate.shape.departmentId,
  description, updatedAt,
}).strict();

export const RejectionReasonCreate = z.object({ name, description }).strict();
export const RejectionReasonPatch = z.object({ name: name.optional(), description, updatedAt }).strict();

const question = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/, 'Question ids are lowercase letters, digits and _').optional(),
  label: z.string().trim().min(2, 'Write the question').max(300),
  type: z.enum(['text', 'textarea', 'yes_no', 'select', 'number']),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
}).strict().superRefine((q, ctx) => {
  if (q.type === 'select' && q.options.length < 2) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Add at least 2 choices' });
  }
});
export const SurveyTemplateCreate = z.object({
  name, description, questions: z.array(question).min(1, 'Add at least one question').max(25),
}).strict();
export const SurveyTemplatePatch = z.object({
  name: name.optional(), description, questions: SurveyTemplateCreate.shape.questions.optional(), updatedAt,
}).strict();

export const SettingsBody = z.object({
  careersEnabled: z.boolean(),
  careersHeadline: optText(200),
  careersIntro: optText(2000),
  confirmationMessage: optText(1000),
  privacyNoticeUrl: z.preprocess(blankToNull, httpUrl.nullable()).optional(),
}).strict();

export const EmployeeLookupQuery = z.object({
  search: z.string().trim().max(100).optional(),
  ids: z.string().regex(/^\d+(,\d+){0,49}$/).optional(),
}).strict();

// ------------------------------------------------------------------ public ---
export const PublicJobsQuery = z.object({
  org: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(50).optional(),
  search: z.string().trim().max(100).optional(),
  department: z.string().trim().max(150).optional(),
}).strict();

const fileRef = z.object({ id, claimToken: z.string().uuid() }).strict();
export const PublicApplyBody = z.object({
  fullName: z.string().trim().min(2, 'Enter your full name').max(200),
  email,
  phone: phone,
  currentCompany: optText(200),
  currentTitle: optText(200),
  experienceYears: z.preprocess(blankToNull, z.coerce.number().min(0, 'Cannot be negative').max(80, 'Enter a realistic number').nullable()).optional(),
  location: optText(200),
  linkedinUrl: z.preprocess(blankToNull, httpUrl.nullable()).optional(),
  jobPositionId: z.preprocess(blankToNull, id.nullable()).optional(),
  coverLetter: optText(5000),
  resume: fileRef.optional(),
  photo: fileRef.optional(),
  answers: z.array(z.object({ questionId: z.string().max(30), value: z.union([z.string().max(2000), z.number(), z.boolean()]) }).strict()).max(25).default([]),
  consent: z.literal(true, { message: 'Please accept the privacy notice to apply' }),
  /** Honeypot: real people never see or fill this field. A filled one is answered with a fake success. */
  website: z.string().max(500).optional(),
}).strict();

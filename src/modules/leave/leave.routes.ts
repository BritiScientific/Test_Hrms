import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { withTenantTx, type Tx } from '../../config/db';
import { AppError, forbidden } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { runAccrual } from './leave-accrual.service';
import * as attachments from './leave-attachment.service';
import { adjustBalance, encashBalance, listBalances, listTransactions, reconciliation } from './leave-balance.service';
import { P, toCamel, today, yearOf } from './leave-common';
import * as compOff from './leave-comp-off.service';
import { getLookups, searchEmployees } from './leave-config.service';
import { runCarryForward, runExpiry } from './leave-carry-forward.service';
import * as dashboards from './leave-dashboard.service';
import { listApplicableTypes } from './leave-policy.service';
import { REPORT_TYPES, runReport } from './leave-report.service';
import * as requests from './leave-request.service';

// Round trip: Date quietly turns 02-31 into 03-03, which would reach the database as a bad date.
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((d) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
}, 'Invalid date');
const year = z.coerce.number().int().min(2000).max(2100);
const id = z.coerce.number().int().positive();
const halfDays = z.coerce.number().positive().max(366).refine((d) => Number.isInteger(d * 100), 'At most two decimals');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['pending', 'returned', 'approved', 'rejected', 'withdrawn', 'cancelled'] as const;

const idempotencyKey = (req: Request): string | null => {
  const key = req.header('idempotency-key');
  if (key && !uuid.test(key)) throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
  return key ?? null;
};

/** Same shape for the preview and the submission. No totalDays, employeeId or tenantId: all server-derived. */
const ApplyBody = z.object({
  leaveTypeCode: z.string().trim().min(1).max(30),
  startDate: isoDate,
  endDate: isoDate,
  durationType: z.enum(['full_day', 'half_day']).default('full_day'),
  halfDaySession: z.enum(['first_half', 'second_half']).nullish(),
  reason: z.string().trim().min(3, 'Please give a reason').max(2000),
  contactDetails: z.string().trim().max(300).nullish(),
  attachmentIds: z.array(id).max(5).optional(),
}).strict();
const PreviewBody = ApplyBody.extend({ reason: z.string().trim().max(2000).default('') });

const ResubmitBody = z.object({
  reason: z.string().trim().min(3).max(2000).nullish(),
  contactDetails: z.string().trim().max(300).nullish(),
}).strict();
const ReasonBody = z.object({ reason: z.string().trim().min(3, 'Please give a reason').max(1000) }).strict();
const OptionalReasonBody = z.object({ reason: z.string().trim().max(1000).nullish() }).strict();

const Paging = {
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
};
const RequestFilters = z.object({
  status: z.enum(STATUSES).optional(),
  leaveTypeId: id.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
  ...Paging,
});
const TeamFilters = RequestFilters.extend({ employeeId: id.optional() });
const AdminFilters = TeamFilters.extend({ departmentId: id.optional(), location: z.string().trim().max(150).optional() });
const HistoryQuery = z.object({
  action: z.enum(['approve', 'reject', 'return']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  search: z.string().trim().max(100).optional(),
  ...Paging,
});
const RangeQuery = z.object({ from: isoDate, to: isoDate }).refine((q) => q.to >= q.from && yearSpan(q.from, q.to) <= 370, 'Choose a range of up to one year');
const AdminCalendarQuery = z.object({
  from: isoDate,
  to: isoDate,
  departmentId: id.optional(),
  location: z.string().trim().max(150).optional(),
  employeeId: id.optional(),
  search: z.string().trim().max(100).optional(),
}).refine((q) => q.to >= q.from && yearSpan(q.from, q.to) <= 370, 'Choose a range of up to one year');
const yearSpan = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

const AdjustBody = z.object({
  employeeId: id,
  leaveTypeId: id,
  year,
  days: halfDays,
  direction: z.enum(['credit', 'debit']),
  note: z.string().trim().min(3, 'Please give a reason').max(500),
}).strict();
const EncashBody = z.object({
  employeeId: id,
  leaveTypeId: id,
  year,
  days: halfDays,
  note: z.string().trim().min(3, 'Please give a reason').max(500),
}).strict();
const ClaimBody = z.object({
  leaveTypeId: id,
  workDate: isoDate,
  hoursWorked: z.coerce.number().positive().max(24),
  reason: z.string().trim().min(3, 'Please describe the work').max(1000),
}).strict();
const ClaimQuery = z.object({
  status: z.enum(['pending', 'returned', 'approved', 'rejected', 'withdrawn']).optional(),
  employeeId: id.optional(),
  ...Paging,
});
const AccrualBody = z.object({ dryRun: z.boolean().default(true), ruleId: id.optional(), employeeId: id.optional() }).strict();
const CarryBody = z.object({ fromYear: year, dryRun: z.boolean().default(true) }).strict();
const ExpiryBody = z.object({ dryRun: z.boolean().default(true) }).strict();
const ReportQuery = z.object({
  year,
  departmentId: id.optional(),
  leaveTypeId: id.optional(),
});

/** Same as tenantHandler, with one naming style for every leave response. */
export const leaveHandler = <T>(fn: (tx: Tx, auth: AuthContext, req: Request) => Promise<T>, status = 200) =>
  tenantHandler(async (tx, auth, req) => toCamel(await fn(tx, auth, req)), status);

const ownEmployee = (auth: AuthContext) => {
  if (!auth.employeeId) throw forbidden('NO_EMPLOYEE_RECORD', 'Your login is not linked to an employee record');
  return auth.employeeId;
};

export const leaveRouter = Router();
leaveRouter.use('/leave', authenticate);

// ---- Employee self-service -------------------------------------------------
leaveRouter.get('/leave/dashboard', requirePermission(P.dashboardSelf),
  leaveHandler((tx, auth) => dashboards.employeeDashboard(tx, auth)));

leaveRouter.get('/leave/types', requirePermission(P.requestCreateSelf),
  leaveHandler(async (tx, auth, req) => listApplicableTypes(tx, ownEmployee(auth), isoDate.catch(await today(tx)).parse(req.query.date))));

leaveRouter.post('/leave/requests/preview', requirePermission(P.requestCreateSelf),
  leaveHandler((tx, auth, req) => requests.previewApplication(tx, auth, PreviewBody.parse(req.body))));

leaveRouter.post('/leave/requests', requirePermission(P.requestCreateSelf), leaveHandler(async (tx, auth, req) => {
  const { request } = await requests.applyLeave(tx, auth, { ...ApplyBody.parse(req.body), idempotencyKey: idempotencyKey(req) });
  return request;
}, 201));

leaveRouter.get('/leave/requests', requirePermission(P.requestViewSelf),
  leaveHandler((tx, auth, req) => requests.listLeaveRequests(tx, auth, { scope: 'own', ...RequestFilters.parse(req.query) })));

// Scope (own, team, approver, HR) is checked inside: a request you cannot see is a 404.
leaveRouter.get('/leave/requests/:id', leaveHandler((tx, auth, req) => requests.getLeaveRequest(tx, auth, idParam(req))));

leaveRouter.post('/leave/requests/:id/resubmit', requirePermission(P.requestCreateSelf),
  leaveHandler((tx, auth, req) => requests.resubmitLeave(tx, auth, idParam(req), ResubmitBody.parse(req.body ?? {}))));

leaveRouter.post('/leave/requests/:id/withdraw', requirePermission(P.requestCancelSelf),
  leaveHandler((tx, auth, req) => requests.withdrawLeave(tx, auth, idParam(req), OptionalReasonBody.parse(req.body ?? {}).reason)));

leaveRouter.post('/leave/requests/:id/cancel', requirePermission(P.requestCancelSelf),
  leaveHandler((tx, auth, req) => requests.cancelOwnLeave(tx, auth, idParam(req), ReasonBody.parse(req.body).reason)));

leaveRouter.get('/leave/balances', requirePermission(P.balanceViewSelf), leaveHandler(async (tx, auth, req) => {
  const y = year.catch(yearOf(await today(tx))).parse(req.query.year);
  return { year: y, items: auth.employeeId ? await listBalances(tx, auth.employeeId, y) : [] };
}));

leaveRouter.get('/leave/balances/transactions', requirePermission(P.balanceViewSelf), leaveHandler(async (tx, auth, req) => {
  const q = z.object({ year: year.optional(), leaveTypeId: id.optional(), ...Paging }).parse(req.query);
  const y = q.year ?? yearOf(await today(tx));
  if (!auth.employeeId) return { items: [], total: 0, limit: q.limit ?? 25, offset: q.offset ?? 0 };
  return listTransactions(tx, auth.employeeId, { ...q, year: y });
}));

leaveRouter.get('/leave/calendar', requirePermission(P.calendarViewSelf),
  leaveHandler((tx, auth, req) => dashboards.myCalendar(tx, auth, RangeQuery.parse(req.query))));

// ---- Attachments -----------------------------------------------------------
/** POST /leave/attachments?fileName=x.pdf — raw bytes as the body. The type is sniffed, never trusted. */
leaveRouter.post('/leave/attachments', requirePermission(P.requestCreateSelf),
  express.raw({ type: () => true, limit: attachments.MAX_ATTACHMENT_BYTES + 1 }),
  leaveHandler((tx, auth, req) => attachments.uploadAttachment(tx, auth, typeof req.query.fileName === 'string' ? req.query.fileName : undefined, req.body), 201));

leaveRouter.get('/leave/attachments/:id', (req, res, next) => {
  withTenantTx(req.auth!.tenantId, (tx) => attachments.getAttachment(tx, req.auth!, idParam(req)))
    .then((a) => {
      // Always a download, served with a sniff-proof type: an upload can never run as a page here.
      res.setHeader('content-type', a.content_type);
      res.setHeader('content-length', String(a.byte_size));
      res.setHeader('content-disposition', `attachment; filename="${a.file_name}"`);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'");
      res.setHeader('cache-control', 'private, no-store');
      res.end(a.data);
    })
    .catch(next);
});

leaveRouter.delete('/leave/attachments/:id', requirePermission(P.requestCreateSelf),
  tenantHandler(async (tx, auth, req) => { await attachments.removeUnlinkedAttachment(tx, auth, idParam(req)); }));

// ---- Comp off --------------------------------------------------------------
leaveRouter.get('/leave/comp-off/types', requirePermission(P.requestCreateSelf), leaveHandler((tx) => compOff.listClaimableTypes(tx)));

leaveRouter.get('/leave/comp-off/claims', requirePermission(P.requestViewSelf), leaveHandler(async (tx, auth, req) => {
  const q = ClaimQuery.omit({ employeeId: true }).parse(req.query);
  if (!auth.employeeId) return { items: [], total: 0, limit: q.limit ?? 25, offset: q.offset ?? 0 };
  return compOff.listClaims(tx, { ...q, employeeId: auth.employeeId });
}));

leaveRouter.post('/leave/comp-off/claims', requirePermission(P.requestCreateSelf),
  leaveHandler((tx, auth, req) => compOff.createClaim(tx, auth, ClaimBody.parse(req.body)), 201));

leaveRouter.post('/leave/comp-off/claims/:id/resubmit', requirePermission(P.requestCreateSelf),
  leaveHandler((tx, auth, req) => compOff.resubmitClaim(tx, auth, idParam(req), ReasonBody.parse(req.body))));

leaveRouter.post('/leave/comp-off/claims/:id/withdraw', requirePermission(P.requestCancelSelf),
  leaveHandler((tx, auth, req) => compOff.withdrawClaim(tx, auth, idParam(req))));

// ---- Manager ---------------------------------------------------------------
leaveRouter.get('/leave/team/dashboard', requirePermission(P.dashboardTeam),
  leaveHandler((tx, auth) => dashboards.teamDashboard(tx, auth)));

leaveRouter.get('/leave/team/members', requirePermission(P.requestViewTeam),
  leaveHandler((tx, auth) => dashboards.listTeamMembers(tx, auth)));

leaveRouter.get('/leave/team/requests', requirePermission(P.requestViewTeam),
  leaveHandler((tx, auth, req) => requests.listLeaveRequests(tx, auth, { scope: 'team', ...TeamFilters.parse(req.query) })));

// Approve, reject and return use the engine's /workflows/tasks/:id/... endpoints: it validates the current task.
leaveRouter.get('/leave/team/approvals/pending', requirePermission(P.requestApprove, P.requestReject, P.requestReturn),
  leaveHandler((tx, auth) => requests.listPendingApprovals(tx, auth)));

leaveRouter.get('/leave/team/approvals/history', requirePermission(P.historyTeam),
  leaveHandler((tx, auth, req) => requests.listApprovalHistory(tx, auth, HistoryQuery.parse(req.query))));

// ---- HR / admin ------------------------------------------------------------
leaveRouter.get('/leave/admin/dashboard', requirePermission(P.dashboardAll), leaveHandler((tx) => dashboards.adminDashboard(tx)));

leaveRouter.get('/leave/admin/requests', requirePermission(P.requestViewAll),
  leaveHandler((tx, auth, req) => requests.listLeaveRequests(tx, auth, { scope: 'all', ...AdminFilters.parse(req.query) })));

leaveRouter.post('/leave/admin/requests/:id/cancel', requirePermission(P.requestManage),
  leaveHandler((tx, auth, req) => requests.cancelByHr(tx, auth, idParam(req), ReasonBody.parse(req.body).reason)));

leaveRouter.get('/leave/admin/calendar', requirePermission(P.calendarAll),
  leaveHandler((tx, _a, req) => dashboards.organizationCalendar(tx, AdminCalendarQuery.parse(req.query))));

leaveRouter.get('/leave/admin/reports/:type', requirePermission(P.reports), leaveHandler(async (tx, _a, req) => {
  const type = z.enum(REPORT_TYPES).parse(req.params.type);
  return runReport(tx, { type, ...ReportQuery.parse(req.query) });
}));

leaveRouter.get('/leave/admin/reconciliation', requirePermission(P.reports, P.balanceAdjust), leaveHandler((tx) => reconciliation(tx)));

leaveRouter.post('/leave/admin/balances/adjust', requirePermission(P.balanceAdjust), leaveHandler((tx, auth, req) =>
  adjustBalance(tx, auth, { ...AdjustBody.parse(req.body), idempotencyKey: idempotencyKey(req) }), 201));

leaveRouter.post('/leave/admin/balances/encash', requirePermission(P.balanceAdjust), leaveHandler((tx, auth, req) =>
  encashBalance(tx, auth, { ...EncashBody.parse(req.body), idempotencyKey: idempotencyKey(req) }), 201));

leaveRouter.get('/leave/admin/balances', requirePermission(P.requestViewAll, P.balanceAdjust), leaveHandler(async (tx, _a, req) => {
  const q = z.object({ employeeId: id, year: year.optional() }).parse(req.query);
  const y = q.year ?? yearOf(await today(tx));
  return { year: y, items: await listBalances(tx, q.employeeId, y) };
}));

// Jobs default to a dry run: HR sees the effect first and confirms with dryRun=false.
leaveRouter.post('/leave/admin/jobs/accrual', requirePermission(P.balanceAdjust), leaveHandler((tx, auth, req) => {
  const b = AccrualBody.parse(req.body ?? {});
  return runAccrual(tx, auth.tenantId, { ...b, actorUserId: auth.userId });
}));

leaveRouter.post('/leave/admin/jobs/carry-forward', requirePermission(P.balanceAdjust), leaveHandler(async (tx, auth, req) => {
  const b = CarryBody.parse(req.body);
  if (b.fromYear >= yearOf(await today(tx))) {
    throw new AppError(422, 'YEAR_NOT_ENDED', `Leave year ${b.fromYear} has not ended yet`);
  }
  return runCarryForward(tx, auth.tenantId, { ...b, actorUserId: auth.userId });
}));

leaveRouter.post('/leave/admin/jobs/expiry', requirePermission(P.balanceAdjust), leaveHandler((tx, auth, req) => {
  const b = ExpiryBody.parse(req.body ?? {});
  return runExpiry(tx, auth.tenantId, { ...b, actorUserId: auth.userId });
}));

// Claims are decided through the comp off workflow (the engine's task endpoints); HR sees them all here.
leaveRouter.get('/leave/admin/comp-off/claims', requirePermission(P.requestViewAll, P.requestManage),
  leaveHandler((tx, _a, req) => compOff.listClaims(tx, ClaimQuery.parse(req.query))));

// ---- Shared lookups for filters and forms ----------------------------------
leaveRouter.get('/leave/lookups',
  requirePermission(P.requestViewAll, P.requestViewTeam, P.reports, P.configView, P.configManage, P.policyAssign, P.calendarAll, P.balanceAdjust),
  leaveHandler((tx) => getLookups(tx)));

leaveRouter.get('/leave/employees',
  requirePermission(P.requestViewAll, P.policyAssign, P.balanceAdjust, P.configManage, P.calendarAll),
  leaveHandler((tx, _a, req) => searchEmployees(tx, z.object({
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }).parse(req.query))));

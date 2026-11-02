import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { AppError } from '../../shared/errors';
import { allocate, listBalances } from './leave-balance.service';
import * as leave from './leave.service';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

// NOTE: no totalDays, employeeId or tenantId in the body — all server-derived.
const ApplyBody = z.object({
  leaveType: z.string().max(30),
  startDate: isoDate,
  endDate: isoDate,
  startSession: z.enum(['full', 'second_half']).optional(),
  endSession: z.enum(['full', 'first_half']).optional(),
  reason: z.string().trim().max(2000).nullish(),
}).strict();

const ListQuery = z.object({
  scope: z.enum(['own', 'team', 'all']).default('own'),
  status: z.enum(['pending', 'returned', 'approved', 'rejected', 'withdrawn', 'cancelled']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const AllocateBody = z.object({
  employeeId: z.coerce.number().int().positive(),
  leaveType: z.string().max(30),
  year: z.coerce.number().int().min(2000).max(2100),
  days: z.coerce.number().min(-365).max(365).refine((d) => d !== 0 && Number.isInteger(d * 2), 'whole or half days'),
  note: z.string().max(500).optional(),
});

export const leaveRouter = Router();
leaveRouter.use('/leave-requests', authenticate);
leaveRouter.use('/leave-balances', authenticate);

leaveRouter.post('/leave-requests', requirePermission('leave.create'), tenantHandler(async (tx, auth, req) => {
  const b = ApplyBody.parse(req.body);
  const key = req.header('idempotency-key');
  if (key && !/^[0-9a-f-]{36}$/i.test(key)) throw new AppError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be a UUID');
  const { request } = await leave.applyLeave(tx, auth, {
    leaveTypeCode: b.leaveType, startDate: b.startDate, endDate: b.endDate,
    startSession: b.startSession, endSession: b.endSession, reason: b.reason, idempotencyKey: key ?? null,
  });
  return request;
}, 201));

leaveRouter.get('/leave-requests', tenantHandler((tx, auth, req) => leave.listLeaveRequests(tx, auth, ListQuery.parse(req.query))));

leaveRouter.get('/leave-requests/:id', tenantHandler((tx, auth, req) => leave.getLeaveRequest(tx, auth, idParam(req))));

leaveRouter.post('/leave-requests/:id/resubmit', requirePermission('leave.create'),
  tenantHandler((tx, auth, req) =>
    leave.resubmitLeave(tx, auth, idParam(req), z.object({ reason: z.string().max(2000).nullish() }).parse(req.body ?? {}))));

leaveRouter.post('/leave-requests/:id/withdraw', requirePermission('leave.withdraw'),
  tenantHandler((tx, auth, req) =>
    leave.withdrawLeave(tx, auth, idParam(req), z.object({ reason: z.string().max(500).nullish() }).parse(req.body ?? {}).reason)));

leaveRouter.get('/leave-balances/me', requirePermission('leave.view.own'), tenantHandler(async (tx, auth, req) => {
  if (!auth.employeeId) return [];
  const year = z.coerce.number().int().min(2000).max(2100).default(new Date().getFullYear()).parse(req.query.year);
  return listBalances(tx, auth.employeeId, year);
}));

leaveRouter.post('/leave-balances/allocations', requirePermission('leave.balance.manage'), tenantHandler((tx, auth, req) => {
  const b = AllocateBody.parse(req.body);
  return allocate(tx, auth, { employeeId: b.employeeId, leaveTypeCode: b.leaveType, year: b.year, days: b.days, note: b.note });
}, 201));

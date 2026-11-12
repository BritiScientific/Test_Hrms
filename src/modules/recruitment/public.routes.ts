import express, { Router } from 'express';
import { withTenantTx } from '../../config/db';
import { handle } from '../../middleware/http';
import { rateLimit } from '../../middleware/rate-limit';
import { AppError, unprocessable } from '../../shared/errors';
import { MAX_DOCUMENT_BYTES, storeDocument } from './application.service';
import * as pub from './public.service';
import { PublicApplyBody, PublicJobsQuery } from './recruitment.schemas';

/**
 * Careers site API (no session). Mounted under /public/careers. Each route
 * resolves the tenant from a public slug, then works under RLS. Writes are
 * rate-limited per IP; the limiters are in-process, so also limit at the gateway.
 */
export const publicCareersRouter = Router();

const ip = (req: express.Request) => req.ip ?? 'unknown';
const readLimit = rateLimit({ name: 'careers-read', windowMs: 15 * 60_000, max: 300, key: ip });
const uploadLimit = rateLimit({ name: 'careers-upload', windowMs: 60 * 60_000, max: 20, key: ip });
const applyLimit = rateLimit({ name: 'careers-apply', windowMs: 60 * 60_000, max: 10, key: ip });

const jobSlug = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(v) || v.length > 120) throw new AppError(404, 'NOT_FOUND', 'Job not found');
  return v;
};

publicCareersRouter.get('/public/careers', readLimit, handle(async (req, res) => {
  const q = PublicJobsQuery.parse(req.query);
  const tenantId = await pub.resolveOrgTenant(q.org);
  const body = await withTenantTx(tenantId, async (tx) => {
    const slug = (await tx.query(`SELECT slug FROM tenants`)).rows[0].slug as string;
    return pub.listJobs(tx, slug, q);
  });
  res.setHeader('cache-control', 'public, max-age=60');
  res.json(body);
}));

publicCareersRouter.get('/public/careers/logo', readLimit, handle(async (req, res) => {
  const q = PublicJobsQuery.pick({ org: true }).parse(req.query);
  const logo = await withTenantTx(await pub.resolveOrgTenant(q.org), (tx) => pub.getLogo(tx));
  if (!logo) throw new AppError(404, 'NOT_FOUND', 'No logo');
  res.setHeader('content-type', logo.contentType);
  res.setHeader('cache-control', 'public, max-age=3600');
  res.setHeader('etag', `"${logo.sha256}"`);
  if (req.header('if-none-match') === `"${logo.sha256}"`) res.status(304).end();
  else res.end(logo.data);
}));

publicCareersRouter.get('/public/careers/jobs/:slug', readLimit, handle(async (req, res) => {
  const slug = jobSlug(req.params.slug);
  const tenantId = await pub.resolveJobTenant(slug);
  const body = await withTenantTx(tenantId, (tx) => pub.getJob(tx, slug));
  res.setHeader('cache-control', 'public, max-age=60');
  res.json(body);
}));

/** POST /public/careers/jobs/:slug/uploads?kind=resume|photo&fileName=cv.pdf — raw bytes; returns an id + claim token. */
publicCareersRouter.post('/public/careers/jobs/:slug/uploads', uploadLimit,
  express.raw({ type: () => true, limit: MAX_DOCUMENT_BYTES + 1 }),
  handle(async (req, res) => {
    const slug = jobSlug(req.params.slug);
    const kind = req.query.kind === 'photo' ? 'photo' : req.query.kind === 'resume' ? 'resume' : null;
    if (!kind) throw unprocessable('VALIDATION_FAILED', 'kind must be resume or photo');
    const tenantId = await pub.resolveJobTenant(slug);
    const doc = await withTenantTx(tenantId, async (tx) => {
      await pub.getJob(tx, slug); // the job must be open to accept files
      return storeDocument(tx, tenantId, null, kind, typeof req.query.fileName === 'string' ? req.query.fileName : undefined, req.body);
    });
    res.status(201).json(doc);
  }));

publicCareersRouter.post('/public/careers/jobs/:slug/applications', applyLimit, handle(async (req, res) => {
  const slug = jobSlug(req.params.slug);
  const body = PublicApplyBody.parse(req.body);
  const tenantId = await pub.resolveJobTenant(slug);
  const result = await withTenantTx(tenantId, (tx) => pub.apply(tx, tenantId, slug, body, req.requestId));
  res.setHeader('cache-control', 'no-store');
  res.status(201).json(result);
}));

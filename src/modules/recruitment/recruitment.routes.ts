import express, { Router, type Request } from 'express';
import { withTenantTx, type Tx } from '../../config/db';
import { authenticate } from '../../middleware/authenticate';
import { handle, idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { AppError } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import * as apps from './application.service';
import * as config from './config.service';
import * as interviews from './interview.service';
import { P } from './recruitment.common';
import * as S from './recruitment.schemas';
import * as recruitments from './recruitment.service';

/**
 * Staff API for Recruitment, mounted under /recruitment. Coarse permission
 * gates live here; services enforce the rest (scope of interviews, locks,
 * vacancy capacity). There is deliberately no DELETE route for anything.
 */
export const recruitmentRouter = Router();
recruitmentRouter.use('/recruitment', authenticate);

type H<T> = (tx: Tx, auth: AuthContext, req: Request) => Promise<T>;
const get = (path: string, perms: string[], h: H<unknown>) => recruitmentRouter.get(`/recruitment${path}`, requirePermission(...perms), tenantHandler(h));
const post = (path: string, perms: string[], h: H<unknown>, status = 200) => recruitmentRouter.post(`/recruitment${path}`, requirePermission(...perms), tenantHandler(h, status));
const patch = (path: string, perms: string[], h: H<unknown>) => recruitmentRouter.patch(`/recruitment${path}`, requirePermission(...perms), tenantHandler(h));
const put = (path: string, perms: string[], h: H<unknown>) => recruitmentRouter.put(`/recruitment${path}`, requirePermission(...perms), tenantHandler(h));

// ------------------------------------------------------------ recruitments ---
get('/recruitments', [P.pipelineView], (tx, _a, r) => recruitments.listRecruitments(tx, S.RecruitmentListQuery.parse(r.query)));
get('/recruitments/:id', [P.pipelineView], (tx, _a, r) => recruitments.getRecruitment(tx, idParam(r)));
post('/recruitments', [P.manage], (tx, a, r) => recruitments.createRecruitment(tx, a, S.RecruitmentCreate.parse(r.body)), 201);
patch('/recruitments/:id', [P.manage], (tx, a, r) => recruitments.updateRecruitment(tx, a, idParam(r), S.RecruitmentPatch.parse(r.body)));
patch('/recruitments/:id/status', [P.manage], (tx, a, r) => {
  const b = S.RecruitmentStatusBody.parse(r.body);
  return recruitments.setRecruitmentStatus(tx, a, idParam(r), b.status, b.updatedAt);
});
post('/recruitments/:id/applications', [P.candidateManage],
  (tx, a, r) => apps.createManualApplication(tx, a, idParam(r), S.ApplicationCreate.parse(r.body)), 201);

// ------------------------------------------------------------ applications ---
get('/applications', [P.pipelineView, P.candidateView], (tx, _a, r) => apps.listApplications(tx, S.ApplicationListQuery.parse(r.query)));
post('/applications/bulk-move', [P.candidateManage], (tx, a, r) => apps.bulkMove(tx, a, S.ApplicationBulkMove.parse(r.body)));
get('/applications/:id', [P.candidateView], (tx, _a, r) => apps.getApplication(tx, idParam(r)));
post('/applications/:id/move', [P.candidateManage], (tx, a, r) => apps.moveApplication(tx, a, idParam(r), S.ApplicationMove.parse(r.body)));
patch('/applications/:id', [P.candidateManage], (tx, a, r) => apps.patchApplication(tx, a, idParam(r), S.ApplicationPatch.parse(r.body)));
post('/applications/:id/notes', [P.candidateManage], (tx, a, r) => apps.addNote(tx, a, idParam(r), S.NoteBody.parse(r.body).body), 201);

// -------------------------------------------------------------- candidates ---
get('/candidates', [P.candidateView], (tx, _a, r) => apps.listCandidates(tx, S.CandidateListQuery.parse(r.query)));
get('/candidates/:id', [P.candidateView], (tx, _a, r) => apps.getCandidate(tx, idParam(r)));
patch('/candidates/:id', [P.candidateManage], (tx, a, r) => apps.patchCandidate(tx, a, idParam(r), S.CandidatePatch.parse(r.body)));

// --------------------------------------------------------------- documents ---
/** POST /recruitment/documents?kind=resume|photo&fileName=x.pdf — raw bytes. The type is sniffed, never trusted. */
recruitmentRouter.post('/recruitment/documents', requirePermission(P.candidateManage),
  express.raw({ type: () => true, limit: apps.MAX_DOCUMENT_BYTES + 1 }),
  tenantHandler((tx, auth, req) => {
    const kind = req.query.kind === 'photo' ? 'photo' : req.query.kind === 'resume' ? 'resume' : null;
    if (!kind) throw new AppError(422, 'VALIDATION_FAILED', 'kind must be resume or photo');
    return apps.storeDocument(tx, auth.tenantId, auth.userId, kind, typeof req.query.fileName === 'string' ? req.query.fileName : undefined, req.body);
  }, 201));

recruitmentRouter.get('/recruitment/documents/:id', requirePermission(P.candidateView, P.pipelineView), handle(async (req, res) => {
  const id = idParam(req);
  const doc = await withTenantTx(req.auth!.tenantId, (tx) => apps.getDocument(tx, id));
  const inline = doc.kind === 'photo';
  res.setHeader('content-type', doc.content_type);
  res.setHeader('content-length', String(doc.byte_size));
  res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${doc.file_name}"`);
  res.setHeader('cache-control', 'private, max-age=300');
  res.setHeader('content-security-policy', "default-src 'none'; sandbox");
  res.setHeader('etag', `"${doc.sha256}"`);
  if (req.header('if-none-match') === `"${doc.sha256}"`) res.status(304).end();
  else res.end(doc.data);
}));

// -------------------------------------------------------------- interviews ---
const IV = [P.interviewView, P.interviewManage, P.interviewFeedback];
get('/interviews', IV, (tx, a, r) => interviews.listInterviews(tx, a, S.InterviewListQuery.parse(r.query)));
get('/interviews/:id', IV, (tx, a, r) => interviews.getInterview(tx, a, idParam(r)));
post('/interviews', [P.interviewManage], (tx, a, r) => interviews.createInterview(tx, a, S.InterviewCreate.parse(r.body)), 201);
patch('/interviews/:id', [P.interviewManage], (tx, a, r) => interviews.updateInterview(tx, a, idParam(r), S.InterviewPatch.parse(r.body)));
patch('/interviews/:id/status', [P.interviewManage], (tx, a, r) => interviews.setInterviewStatus(tx, a, idParam(r), S.InterviewStatusBody.parse(r.body)));
put('/interviews/:id/feedback', [P.interviewFeedback], (tx, a, r) => interviews.submitFeedback(tx, a, idParam(r), S.FeedbackBody.parse(r.body)));

// ----------------------------------------------------------------- lookups ---
get('/lookups/employees', [P.manage, P.interviewManage, P.candidateManage], (tx, _a, r) => recruitments.employeeLookup(tx, S.EmployeeLookupQuery.parse(r.query)));
get('/lookups/job-positions', [P.manage, P.candidateManage, P.configView, P.configManage], (tx) => config.configOptions(tx, config.jobPositionDef));
get('/lookups/survey-templates', [P.manage, P.configView, P.configManage], (tx) => config.configOptions(tx, config.surveyDef));
get('/lookups/rejection-reasons', [P.candidateManage, P.configView, P.configManage], (tx) => config.configOptions(tx, config.rejectionReasonDef));
get('/lookups/departments', [P.configView, P.configManage], async (tx) =>
  (await tx.query(`SELECT id, name FROM departments WHERE is_active ORDER BY lower(name)`)).rows.map((d) => ({ id: Number(d.id), name: d.name as string })));

// ----------------------------------------------------------- configuration ---
const CFG = [P.configView, P.configManage];
function mountConfig<C, U>(path: string, def: config.Def, create: (tx: Tx, a: AuthContext, b: C) => Promise<unknown>,
  update: (tx: Tx, a: AuthContext, id: number, b: U) => Promise<unknown>, createSchema: { parse(x: unknown): C }, patchSchema: { parse(x: unknown): U }) {
  get(`/config/${path}`, CFG, (tx, _a, r) => config.listConfig(tx, def, S.ConfigListQuery.parse(r.query)));
  get(`/config/${path}/:id`, CFG, (tx, _a, r) => config.getConfig(tx, def, idParam(r)));
  post(`/config/${path}`, [P.configManage], (tx, a, r) => create(tx, a, createSchema.parse(r.body)), 201);
  patch(`/config/${path}/:id`, [P.configManage], (tx, a, r) => update(tx, a, idParam(r), patchSchema.parse(r.body)));
  patch(`/config/${path}/:id/status`, [P.configManage], (tx, a, r) => config.setConfigStatus(tx, a, def, idParam(r), S.ConfigStatusBody.parse(r.body)));
}
mountConfig('job-positions', config.jobPositionDef, config.createJobPosition, config.updateJobPosition, S.JobPositionCreate, S.JobPositionPatch);
mountConfig('survey-templates', config.surveyDef, config.createSurveyTemplate, config.updateSurveyTemplate, S.SurveyTemplateCreate, S.SurveyTemplatePatch);
mountConfig('rejection-reasons', config.rejectionReasonDef, config.createRejectionReason, config.updateRejectionReason, S.RejectionReasonCreate, S.RejectionReasonPatch);
get('/config/settings', CFG, (tx) => config.getSettings(tx));
put('/config/settings', [P.configManage], (tx, a, r) => config.saveSettings(tx, a, S.SettingsBody.parse(r.body)));

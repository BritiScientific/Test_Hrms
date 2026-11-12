import type { z } from 'zod';
import type { Tx } from '../../config/db';
import { conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { enqueueEvent } from '../outbox/outbox';
import { P, assertFresh, buildSet, writeAudit } from './recruitment.common';
import type { FeedbackBody, InterviewCreate, InterviewListQuery, InterviewPatch, InterviewStatusBody } from './recruitment.schemas';

const fieldError = (field: string, message: string) =>
  unprocessable('VALIDATION_FAILED', message, { fieldErrors: { [field]: message } });

/**
 * Who sees which interviews: anyone with interview.view sees all of them;
 * an interviewer (interview.feedback) sees only the ones they are named on.
 */
function scope(auth: AuthContext): { all: boolean; employeeId: number | null } {
  if (auth.permissions.has(P.interviewView) || auth.permissions.has(P.interviewManage)) return { all: true, employeeId: auth.employeeId };
  if (auth.permissions.has(P.interviewFeedback) && auth.employeeId) return { all: false, employeeId: auth.employeeId };
  throw forbidden('MISSING_PERMISSION', 'Permission denied');
}

const SELECT = `
  SELECT i.*, a.reference, a.status AS application_status, a.recruitment_id, a.candidate_id,
         c.full_name AS candidate_name, c.email AS candidate_email, rc.title AS recruitment_title, s.name AS stage_name
    FROM interviews i
    JOIN applications a ON a.tenant_id = i.tenant_id AND a.id = i.application_id
    JOIN rec_candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN recruitments rc ON rc.tenant_id = a.tenant_id AND rc.id = a.recruitment_id
    JOIN recruitment_stages s ON s.tenant_id = a.tenant_id AND s.id = a.stage_id`;

async function interviewersFor(tx: Tx, ids: number[]) {
  const r = await tx.query(
    `SELECT ii.interview_id, e.id, e.full_name, e.job_title,
            EXISTS (SELECT 1 FROM interview_feedback f WHERE f.interview_id = ii.interview_id AND f.employee_id = e.id) AS has_feedback
       FROM interview_interviewers ii JOIN employees e ON e.tenant_id = ii.tenant_id AND e.id = ii.employee_id
      WHERE ii.interview_id = ANY($1::bigint[]) ORDER BY lower(e.full_name), e.id`, [ids]);
  const m = new Map<number, { id: number; name: string; jobTitle: string | null; hasFeedback: boolean }[]>();
  for (const x of r.rows) {
    const k = Number(x.interview_id);
    m.set(k, [...(m.get(k) ?? []), { id: Number(x.id), name: x.full_name, jobTitle: x.job_title ?? null, hasFeedback: x.has_feedback }]);
  }
  return m;
}

const toInterview = (r: any, interviewers: any[] = []) => ({
  id: Number(r.id),
  title: r.title as string,
  startsAt: r.starts_at as Date,
  endsAt: r.ends_at as Date,
  mode: r.mode as 'video' | 'in_person' | 'phone',
  location: (r.location ?? null) as string | null,
  meetingLink: (r.meeting_link ?? null) as string | null,
  notes: (r.notes ?? null) as string | null,
  status: r.status as 'scheduled' | 'completed' | 'cancelled' | 'no_show',
  cancelReason: (r.cancel_reason ?? null) as string | null,
  application: {
    id: Number(r.application_id), reference: r.reference as string, status: r.application_status as string, stageName: r.stage_name as string,
    candidate: { id: Number(r.candidate_id), name: r.candidate_name as string, email: r.candidate_email as string },
    recruitment: { id: Number(r.recruitment_id), title: r.recruitment_title as string },
  },
  interviewers,
  updatedAt: r.updated_at as Date,
});

export async function listInterviews(tx: Tx, auth: AuthContext, q: z.infer<typeof InterviewListQuery>) {
  const sc = scope(auth);
  const mine = q.mine || !sc.all;
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count FROM (${SELECT}) t
      WHERE ($1::timestamptz IS NULL OR t.ends_at >= $1)
        AND ($2::timestamptz IS NULL OR t.starts_at < $2)
        AND ($3::text = 'all' OR t.status = $3)
        AND ($4::bigint IS NULL OR t.recruitment_id = $4)
        AND ($5::bigint IS NULL OR t.application_id = $5)
        AND ($6::boolean = false OR EXISTS (SELECT 1 FROM interview_interviewers ii WHERE ii.interview_id = t.id AND ii.employee_id = $7))
      ORDER BY t.starts_at ${q.from && !q.to ? 'ASC' : 'DESC'}, t.id
      LIMIT $8 OFFSET $9`,
    [q.from ?? null, q.to ?? null, q.status, q.recruitmentId ?? null, q.applicationId ?? null, mine, sc.employeeId, q.limit, (q.page - 1) * q.limit],
  );
  const people = await interviewersFor(tx, r.rows.map((x) => Number(x.id)));
  return {
    items: r.rows.map((x) => toInterview(x, people.get(Number(x.id)) ?? [])),
    total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit,
  };
}

export async function getInterview(tx: Tx, auth: AuthContext, id: number) {
  const sc = scope(auth);
  const r = await tx.query(`SELECT t.* FROM (${SELECT}) t WHERE t.id = $1`, [id]);
  if (!r.rowCount) throw notFound('Interview');
  const people = await interviewersFor(tx, [id]);
  const interviewers = people.get(id) ?? [];
  const isInterviewer = sc.employeeId !== null && interviewers.some((i) => i.id === sc.employeeId);
  if (!sc.all && !isInterviewer) throw notFound('Interview');

  const fb = await tx.query(
    `SELECT f.*, e.full_name FROM interview_feedback f JOIN employees e ON e.tenant_id = f.tenant_id AND e.id = f.employee_id
      WHERE f.interview_id = $1 ORDER BY f.submitted_at`, [id]);
  const mapped = fb.rows.map((f) => ({
    id: Number(f.id), employeeId: Number(f.employee_id), by: f.full_name as string, rating: f.rating as number,
    recommendation: f.recommendation as string, strengths: (f.strengths ?? null) as string | null,
    concerns: (f.concerns ?? null) as string | null, comments: (f.comments ?? null) as string | null, submittedAt: f.submitted_at as Date,
  }));
  const mine = mapped.find((f) => f.employeeId === sc.employeeId) ?? null;
  // An interviewer sees colleagues' feedback only after submitting their own (keeps assessments independent).
  const visible = sc.all ? mapped : mine ? mapped : [];
  const row = r.rows[0];
  const started = new Date(row.starts_at).getTime() <= Date.now();
  return {
    ...toInterview(row, interviewers),
    feedback: visible,
    myFeedback: mine,
    canGiveFeedback: isInterviewer && started && ['scheduled', 'completed'].includes(row.status),
  };
}

// --------------------------------------------------------------- validation ---

async function assertInterviewers(tx: Tx, ids: number[]) {
  const r = await tx.query(`SELECT id FROM employees WHERE id = ANY($1::bigint[]) AND status <> 'exited'`, [ids]);
  if (r.rowCount !== ids.length) throw fieldError('interviewerIds', 'One of the interviewers is not a current employee');
}

/** Interviewers already booked in an overlapping slot (excluding this interview). */
async function findConflicts(tx: Tx, interviewerIds: number[], startsAt: string, endsAt: string, exceptId?: number) {
  const r = await tx.query(
    `SELECT e.id AS employee_id, e.full_name, i.id, i.title, i.starts_at, i.ends_at
       FROM interviews i
       JOIN interview_interviewers ii ON ii.tenant_id = i.tenant_id AND ii.interview_id = i.id
       JOIN employees e ON e.tenant_id = ii.tenant_id AND e.id = ii.employee_id
      WHERE i.status = 'scheduled' AND ii.employee_id = ANY($1::bigint[])
        AND i.starts_at < $3 AND i.ends_at > $2 AND ($4::bigint IS NULL OR i.id <> $4)
      ORDER BY i.starts_at LIMIT 20`,
    [interviewerIds, startsAt, endsAt, exceptId ?? null]);
  return r.rows.map((x) => ({
    employeeId: Number(x.employee_id), employee: x.full_name as string, interviewId: Number(x.id), title: x.title as string,
    startsAt: x.starts_at as Date, endsAt: x.ends_at as Date,
  }));
}

function assertWindow(startsAt: string, endsAt: string, isNew: boolean) {
  const s = new Date(startsAt).getTime();
  const e = new Date(endsAt).getTime();
  if (e <= s) throw fieldError('endsAt', 'End time must be after the start time');
  if (e - s > 12 * 3600_000) throw fieldError('endsAt', 'An interview can be at most 12 hours long');
  if (isNew && s < Date.now() - 5 * 60_000) throw fieldError('startsAt', 'Choose a start time in the future');
}

function assertModeFields(mode: string, location: string | null, link: string | null) {
  if (mode === 'video' && !link) throw fieldError('meetingLink', 'Add the meeting link for a video interview');
  if (mode === 'in_person' && !location) throw fieldError('location', 'Add the location for an in-person interview');
}

// ------------------------------------------------------------------- writes ---

export async function createInterview(tx: Tx, auth: AuthContext, b: z.infer<typeof InterviewCreate>) {
  assertWindow(b.startsAt, b.endsAt, true);
  assertModeFields(b.mode, b.location ?? null, b.meetingLink ?? null);
  const app = await tx.query(`SELECT id, status FROM applications WHERE id = $1 FOR SHARE`, [b.applicationId]);
  if (!app.rowCount) throw notFound('Application');
  if (app.rows[0].status !== 'active') throw conflict('APPLICATION_CLOSED', 'Interviews can only be scheduled for candidates still in the pipeline');
  await assertInterviewers(tx, b.interviewerIds);
  if (!b.allowConflicts) {
    const conflicts = await findConflicts(tx, b.interviewerIds, b.startsAt, b.endsAt);
    if (conflicts.length) throw conflict('INTERVIEWER_BUSY', 'An interviewer is already booked in that time', { conflicts });
  }
  const ins = await tx.query(
    `INSERT INTO interviews (tenant_id, application_id, title, starts_at, ends_at, mode, location, meeting_link, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
    [auth.tenantId, b.applicationId, b.title, b.startsAt, b.endsAt, b.mode, b.location ?? null, b.meetingLink ?? null, b.notes ?? null, auth.userId]);
  const id = Number(ins.rows[0].id);
  await tx.query(
    `INSERT INTO interview_interviewers (tenant_id, interview_id, employee_id) SELECT $1, $2, x FROM unnest($3::bigint[]) x`,
    [auth.tenantId, id, b.interviewerIds]);
  await writeAudit(tx, auth, {
    action: 'scheduled', entityType: 'interview', entityId: id,
    after: { applicationId: b.applicationId, title: b.title, startsAt: b.startsAt, endsAt: b.endsAt, mode: b.mode, interviewerIds: b.interviewerIds },
  });
  await notifyCandidate(tx, auth, id, 'scheduled');
  return getInterview(tx, auth, id);
}

export async function updateInterview(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof InterviewPatch>) {
  const lock = await tx.query(`SELECT * FROM interviews WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound('Interview');
  const row = lock.rows[0];
  assertFresh(row, b.updatedAt);
  if (row.status !== 'scheduled') throw conflict('INTERVIEW_NOT_EDITABLE', 'Only a scheduled interview can be changed');

  const startsAt = b.startsAt ?? (row.starts_at as Date).toISOString();
  const endsAt = b.endsAt ?? (row.ends_at as Date).toISOString();
  const timeChanged = b.startsAt !== undefined || b.endsAt !== undefined;
  if (timeChanged) assertWindow(startsAt, endsAt, b.startsAt !== undefined);
  const mode = b.mode ?? row.mode;
  assertModeFields(mode, b.location === undefined ? row.location : b.location, b.meetingLink === undefined ? row.meeting_link : b.meetingLink);

  let interviewerIds = b.interviewerIds;
  if (interviewerIds) await assertInterviewers(tx, interviewerIds);
  if (timeChanged || interviewerIds) {
    interviewerIds ??= (await tx.query(`SELECT employee_id FROM interview_interviewers WHERE interview_id = $1`, [id])).rows.map((x) => Number(x.employee_id));
    if (!b.allowConflicts) {
      const conflicts = await findConflicts(tx, interviewerIds, startsAt, endsAt, id);
      if (conflicts.length) throw conflict('INTERVIEWER_BUSY', 'An interviewer is already booked in that time', { conflicts });
    }
  }

  const before = await getInterview(tx, auth, id);
  const changes: Record<string, unknown> = { updated_by: auth.userId };
  if (b.title !== undefined) changes.title = b.title;
  if (b.startsAt !== undefined) changes.starts_at = b.startsAt;
  if (b.endsAt !== undefined) changes.ends_at = b.endsAt;
  if (b.mode !== undefined) changes.mode = b.mode;
  if (b.location !== undefined) changes.location = b.location;
  if (b.meetingLink !== undefined) changes.meeting_link = b.meetingLink;
  if (b.notes !== undefined) changes.notes = b.notes;
  const set = buildSet(changes, 2);
  await tx.query(`UPDATE interviews SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
  if (b.interviewerIds) {
    await tx.query(`DELETE FROM interview_interviewers WHERE interview_id = $1 AND NOT (employee_id = ANY($2::bigint[]))`, [id, b.interviewerIds]);
    await tx.query(
      `INSERT INTO interview_interviewers (tenant_id, interview_id, employee_id) SELECT $1, $2, x FROM unnest($3::bigint[]) x ON CONFLICT DO NOTHING`,
      [auth.tenantId, id, b.interviewerIds]);
  }
  const after = await getInterview(tx, auth, id);
  await writeAudit(tx, auth, {
    action: 'updated', entityType: 'interview', entityId: id,
    before: { title: before.title, startsAt: before.startsAt, endsAt: before.endsAt, mode: before.mode, location: before.location, interviewers: before.interviewers.map((i) => i.id) },
    after: { title: after.title, startsAt: after.startsAt, endsAt: after.endsAt, mode: after.mode, location: after.location, interviewers: after.interviewers.map((i) => i.id) },
  });
  if (timeChanged) await notifyCandidate(tx, auth, id, 'rescheduled');
  return after;
}

export async function setInterviewStatus(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof InterviewStatusBody>) {
  const lock = await tx.query(`SELECT * FROM interviews WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound('Interview');
  const row = lock.rows[0];
  if (row.status === b.status) return getInterview(tx, auth, id);
  assertFresh(row, b.updatedAt);
  if (row.status !== 'scheduled') throw conflict('INTERVIEW_NOT_EDITABLE', `This interview is already ${row.status.replace('_', ' ')}`);
  if (b.status !== 'cancelled' && new Date(row.starts_at).getTime() > Date.now()) {
    throw conflict('INTERVIEW_NOT_STARTED', 'The interview has not started yet');
  }
  await tx.query(`UPDATE interviews SET status = $2, cancel_reason = $3, updated_by = $4 WHERE id = $1`,
    [id, b.status, b.status === 'cancelled' ? b.reason ?? null : null, auth.userId]);
  await writeAudit(tx, auth, { action: b.status, entityType: 'interview', entityId: id, before: { status: row.status }, after: { status: b.status, reason: b.reason ?? null } });
  if (b.status === 'cancelled') await notifyCandidate(tx, auth, id, 'cancelled');
  return getInterview(tx, auth, id);
}

export async function submitFeedback(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof FeedbackBody>) {
  if (!auth.employeeId || !auth.permissions.has(P.interviewFeedback)) throw forbidden('MISSING_PERMISSION', 'Permission denied');
  const r = await tx.query(`SELECT i.*, EXISTS (SELECT 1 FROM interview_interviewers ii WHERE ii.interview_id = i.id AND ii.employee_id = $2) AS is_interviewer
                              FROM interviews i WHERE i.id = $1 FOR SHARE OF i`, [id, auth.employeeId]);
  // Hide interviews the user is not part of, exactly like the read path.
  if (!r.rowCount || !r.rows[0].is_interviewer) throw notFound('Interview');
  const row = r.rows[0];
  if (!['scheduled', 'completed'].includes(row.status)) throw conflict('INTERVIEW_NOT_EDITABLE', 'Feedback cannot be added to a cancelled interview');
  if (new Date(row.starts_at).getTime() > Date.now()) throw conflict('INTERVIEW_NOT_STARTED', 'Feedback opens when the interview starts');
  await tx.query(
    `INSERT INTO interview_feedback (tenant_id, interview_id, employee_id, rating, recommendation, strengths, concerns, comments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id, interview_id, employee_id) DO UPDATE
       SET rating = EXCLUDED.rating, recommendation = EXCLUDED.recommendation, strengths = EXCLUDED.strengths,
           concerns = EXCLUDED.concerns, comments = EXCLUDED.comments`,
    [auth.tenantId, id, auth.employeeId, b.rating, b.recommendation, b.strengths ?? null, b.concerns ?? null, b.comments ?? null]);
  await writeAudit(tx, auth, { action: 'feedback_submitted', entityType: 'interview', entityId: id, after: { employeeId: auth.employeeId, rating: b.rating, recommendation: b.recommendation } });
  return getInterview(tx, auth, id);
}

async function notifyCandidate(tx: Tx, auth: AuthContext, id: number, kind: 'scheduled' | 'rescheduled' | 'cancelled') {
  const r = await tx.query(`SELECT t.* FROM (${SELECT}) t WHERE t.id = $1`, [id]);
  const i = r.rows[0];
  await enqueueEvent(tx, auth.tenantId, `recruitment.interview.${kind}`, 'interview', id, {
    candidateEmail: i.candidate_email, candidateName: i.candidate_name, recruitmentTitle: i.recruitment_title,
    title: i.title, startsAt: i.starts_at, endsAt: i.ends_at, mode: i.mode, location: i.location, meetingLink: i.meeting_link,
  });
}

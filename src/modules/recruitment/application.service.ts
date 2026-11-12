import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { Tx } from '../../config/db';
import { AppError, conflict, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { enqueueEvent } from '../outbox/outbox';
import { sniffImageType } from '../organization/asset-storage';
import { assertFresh, buildSet, likeTerm, makeReference, writeAudit } from './recruitment.common';
import type {
  ApplicationBulkMove, ApplicationCreate, ApplicationListQuery, ApplicationMove, ApplicationPatch,
  CandidateListQuery, CandidatePatch,
} from './recruitment.schemas';
import type { StageType } from './recruitment.schemas';

const fieldError = (field: string, message: string) =>
  unprocessable('VALIDATION_FAILED', message, { fieldErrors: { [field]: message } });

// ---------------------------------------------------------------- documents ---

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Identify a file by its magic bytes. The declared Content-Type is never trusted. */
export function sniffResumeType(buf: Buffer): string | null {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';
  // .docx is a zip container; .doc is an OLE2 compound file.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) return 'application/msword';
  return null;
}

export const safeFileName = (name: string | undefined) => {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  return base.replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').slice(0, 200).trim() || 'file';
};

/** Stores an unlinked upload. The returned claim token is the only way to attach it to an application. */
export async function storeDocument(
  tx: Tx, tenantId: number, userId: number | null, kind: 'resume' | 'photo', fileName: string | undefined, data: Buffer,
) {
  if (!Buffer.isBuffer(data) || data.length === 0) throw unprocessable('EMPTY_FILE', 'The file is empty');
  if (data.length > MAX_DOCUMENT_BYTES) throw unprocessable('FILE_TOO_LARGE', 'Files can be at most 5 MB');
  const contentType = kind === 'resume' ? sniffResumeType(data) : sniffImageType(data);
  if (!contentType) {
    throw unprocessable('UNSUPPORTED_FILE', kind === 'resume' ? 'Upload a PDF, DOC or DOCX file' : 'Upload a PNG, JPEG or WebP image');
  }
  const r = await tx.query(
    `INSERT INTO candidate_documents (tenant_id, kind, file_name, content_type, byte_size, sha256, data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, claim_token, file_name, content_type, byte_size`,
    [tenantId, kind, safeFileName(fileName), contentType, data.length, createHash('sha256').update(data).digest('hex'), data, userId],
  );
  const d = r.rows[0];
  return { id: Number(d.id), claimToken: d.claim_token as string, fileName: d.file_name as string, contentType: d.content_type as string, byteSize: d.byte_size as number };
}

export async function getDocument(tx: Tx, id: number) {
  const r = await tx.query(
    `SELECT id, kind, file_name, content_type, byte_size, sha256, data FROM candidate_documents WHERE id = $1 AND candidate_id IS NOT NULL`, [id]);
  if (!r.rowCount) throw notFound('Document');
  return r.rows[0];
}

async function claimDocument(tx: Tx, ref: { id: number; claimToken: string } | undefined, kind: 'resume' | 'photo', candidateId: number) {
  if (!ref) return null;
  const r = await tx.query(
    `UPDATE candidate_documents SET candidate_id = $4
      WHERE id = $1 AND claim_token = $2 AND kind = $3 AND candidate_id IS NULL RETURNING id`,
    [ref.id, ref.claimToken, kind, candidateId]);
  if (!r.rowCount) throw fieldError(kind, 'The uploaded file is no longer available. Upload it again.');
  return Number(r.rows[0].id);
}

/** Unlinked uploads older than a day (abandoned forms). Run by the daily job. */
export async function purgeOrphanDocuments(tx: Tx) {
  const r = await tx.query(`DELETE FROM candidate_documents WHERE candidate_id IS NULL AND created_at < now() - interval '1 day'`);
  return r.rowCount ?? 0;
}

// ------------------------------------------------------------- list / read ---

const APPLICATION_SELECT = `
  SELECT a.*, c.full_name, c.email, c.phone, c.current_title, c.experience_years,
         s.name AS stage_name, s.stage_type, rc.title AS recruitment_title, jp.title AS position_title,
         (a.resume_document_id IS NOT NULL) AS has_resume, (a.photo_document_id IS NOT NULL) AS has_photo,
         (SELECT min(i.starts_at) FROM interviews i WHERE i.application_id = a.id AND i.status = 'scheduled' AND i.starts_at >= now()) AS next_interview_at
    FROM applications a
    JOIN rec_candidates c ON c.tenant_id = a.tenant_id AND c.id = a.candidate_id
    JOIN recruitment_stages s ON s.tenant_id = a.tenant_id AND s.id = a.stage_id
    JOIN recruitments rc ON rc.tenant_id = a.tenant_id AND rc.id = a.recruitment_id
    LEFT JOIN rec_job_positions jp ON jp.tenant_id = a.tenant_id AND jp.id = a.job_position_id`;

const toApplication = (r: any) => ({
  id: Number(r.id),
  reference: r.reference as string,
  candidate: {
    id: Number(r.candidate_id), name: r.full_name as string, email: r.email as string, phone: (r.phone ?? null) as string | null,
    currentTitle: (r.current_title ?? null) as string | null, experienceYears: (r.experience_years ?? null) as number | null,
  },
  recruitment: { id: Number(r.recruitment_id), title: r.recruitment_title as string },
  stage: { id: Number(r.stage_id), name: r.stage_name as string, type: r.stage_type as StageType },
  position: r.job_position_id ? { id: Number(r.job_position_id), title: r.position_title as string } : null,
  status: r.status as 'active' | 'hired' | 'rejected',
  rating: (r.rating ?? null) as number | null,
  source: r.source as string,
  appliedAt: r.applied_at as Date,
  stageChangedAt: r.stage_changed_at as Date,
  hasResume: r.has_resume as boolean,
  hasPhoto: r.has_photo as boolean,
  photoUrl: r.photo_document_id ? `/api/v1/recruitment/documents/${r.photo_document_id}` : null,
  nextInterviewAt: (r.next_interview_at ?? null) as Date | null,
  updatedAt: r.updated_at as Date,
});

const SORT: Record<string, string> = {
  recent: 't.applied_at DESC',
  oldest: 't.applied_at ASC',
  name: 'lower(t.full_name) ASC',
  rating: 't.rating DESC NULLS LAST, t.applied_at DESC',
};

export async function listApplications(tx: Tx, q: z.infer<typeof ApplicationListQuery>) {
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count
       FROM (${APPLICATION_SELECT}) t
      WHERE ($1::bigint IS NULL OR t.recruitment_id = $1)
        AND ($2::bigint IS NULL OR t.stage_id = $2)
        AND ($3::bigint IS NULL OR t.candidate_id = $3)
        AND ($4::text = 'all' OR t.status = $4)
        AND ($5::text IS NULL OR t.full_name ILIKE $5 OR t.email::text ILIKE $5 OR t.reference ILIKE $5)
        AND ($6::bigint IS NULL OR t.job_position_id = $6)
      ORDER BY ${SORT[q.sort]}, t.id
      LIMIT $7 OFFSET $8`,
    [q.recruitmentId ?? null, q.stageId ?? null, q.candidateId ?? null, q.status, q.search ? likeTerm(q.search) : null,
     q.jobPositionId ?? null, q.limit, (q.page - 1) * q.limit],
  );
  return { items: r.rows.map(toApplication), total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit };
}

export async function getApplication(tx: Tx, id: number, opts: { withInterviews?: boolean } = {}) {
  const r = await tx.query(`SELECT t.* FROM (${APPLICATION_SELECT}) t WHERE t.id = $1`, [id]);
  if (!r.rowCount) throw notFound('Application');
  const row = r.rows[0];
  const history = await tx.query(
    `SELECT l.id, l.note, l.created_at, fs.name AS from_name, ts.name AS to_name, u.full_name AS actor_name
       FROM application_stage_log l
       LEFT JOIN recruitment_stages fs ON fs.tenant_id = l.tenant_id AND fs.id = l.from_stage_id
       JOIN recruitment_stages ts ON ts.tenant_id = l.tenant_id AND ts.id = l.to_stage_id
       LEFT JOIN users u ON u.id = l.actor_user_id
      WHERE l.application_id = $1 ORDER BY l.created_at DESC, l.id DESC`, [id]);
  const notes = await tx.query(
    `SELECT n.id, n.body, n.created_at, u.full_name AS author_name
       FROM application_notes n LEFT JOIN users u ON u.id = n.author_user_id
      WHERE n.application_id = $1 ORDER BY n.created_at DESC, n.id DESC LIMIT 200`, [id]);
  const interviews = opts.withInterviews === false ? { rows: [] as any[] } : await tx.query(
    `SELECT id, title, starts_at, ends_at, mode, status FROM interviews WHERE application_id = $1 ORDER BY starts_at DESC`, [id]);
  const reason = row.rejection_reason_id
    ? (await tx.query(`SELECT name FROM rejection_reasons WHERE id = $1`, [row.rejection_reason_id])).rows[0]?.name ?? null
    : null;
  return {
    ...toApplication(row),
    coverLetter: (row.cover_letter ?? null) as string | null,
    answers: row.answers as { questionId: string; label: string; type: string; value: string | number | boolean }[],
    rejection: row.status === 'rejected' ? { reason: reason as string | null, note: (row.rejection_note ?? null) as string | null } : null,
    resumeUrl: row.resume_document_id ? `/api/v1/recruitment/documents/${row.resume_document_id}` : null,
    history: history.rows.map((h) => ({
      id: Number(h.id), from: (h.from_name ?? null) as string | null, to: h.to_name as string,
      note: (h.note ?? null) as string | null, by: (h.actor_name ?? null) as string | null, at: h.created_at as Date,
    })),
    notes: notes.rows.map((n) => ({ id: Number(n.id), body: n.body as string, by: (n.author_name ?? null) as string | null, at: n.created_at as Date })),
    interviews: interviews.rows.map((i) => ({
      id: Number(i.id), title: i.title as string, startsAt: i.starts_at as Date, endsAt: i.ends_at as Date,
      mode: i.mode as string, status: i.status as string,
    })),
  };
}

// ------------------------------------------------------------------ create ---

interface NewApplication {
  fullName: string;
  email: string;
  phone?: string | null;
  currentCompany?: string | null;
  currentTitle?: string | null;
  experienceYears?: number | null;
  location?: string | null;
  linkedinUrl?: string | null;
  jobPositionId?: number | null;
  coverLetter?: string | null;
  resume?: { id: number; claimToken: string };
  photo?: { id: number; claimToken: string };
  answers?: { questionId: string; label: string; type: string; value: string | number | boolean }[];
  source: 'careers' | 'manual' | 'referral' | 'agency' | 'other';
}

/**
 * The one place an application is created, for HR (manual add) and for the
 * public careers form. Finds or creates the candidate by email, never
 * overwrites what an existing candidate already has, links the uploaded
 * documents, and writes the stage history, audit row and outbox event.
 */
export async function createApplicationRecord(
  tx: Tx, actor: { tenantId: number; userId: number | null; requestId?: string }, recruitmentId: number, input: NewApplication,
) {
  const rec = await tx.query(`SELECT id, title, status FROM recruitments WHERE id = $1 FOR SHARE`, [recruitmentId]);
  if (!rec.rowCount) throw notFound('Recruitment');
  const stage = await tx.query(
    `SELECT id FROM recruitment_stages WHERE recruitment_id = $1 AND stage_type = 'applied'`, [recruitmentId]);
  if (!stage.rowCount) throw conflict('NO_ENTRY_STAGE', 'This recruitment has no Applied stage');

  const lines = await tx.query(`SELECT job_position_id FROM recruitment_vacancies WHERE recruitment_id = $1`, [recruitmentId]);
  const positions = lines.rows.map((l) => Number(l.job_position_id));
  let positionId: number | null = input.jobPositionId ?? null;
  if (positionId !== null && !positions.includes(positionId)) throw fieldError('jobPositionId', 'This role is not part of the recruitment');
  if (positionId === null) {
    if (positions.length === 1) positionId = positions[0];
    else if (positions.length > 1) throw fieldError('jobPositionId', 'Choose the role you are applying for');
  }

  // Candidate: find by email, otherwise create. ON CONFLICT covers two simultaneous first applications.
  const email = input.email.trim().toLowerCase();
  await tx.query(
    `INSERT INTO rec_candidates (tenant_id, full_name, email, phone, current_company, current_title, experience_years, location, linkedin_url, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id, email) DO NOTHING`,
    [actor.tenantId, input.fullName, email, input.phone ?? null, input.currentCompany ?? null, input.currentTitle ?? null,
     input.experienceYears ?? null, input.location ?? null, input.linkedinUrl ?? null,
     input.source === 'careers' ? 'careers' : input.source, actor.userId],
  );
  const cand = await tx.query(`SELECT id FROM rec_candidates WHERE email = $1 FOR UPDATE`, [email]);
  const candidateId = Number(cand.rows[0].id);
  // Only fill gaps on an existing profile: an applicant must not be able to rewrite a record HR has curated.
  await tx.query(
    `UPDATE rec_candidates SET phone = COALESCE(phone, $2), current_company = COALESCE(current_company, $3),
            current_title = COALESCE(current_title, $4), experience_years = COALESCE(experience_years, $5),
            location = COALESCE(location, $6), linkedin_url = COALESCE(linkedin_url, $7) WHERE id = $1`,
    [candidateId, input.phone ?? null, input.currentCompany ?? null, input.currentTitle ?? null,
     input.experienceYears ?? null, input.location ?? null, input.linkedinUrl ?? null]);

  const dup = await tx.query(`SELECT 1 FROM applications WHERE recruitment_id = $1 AND candidate_id = $2`, [recruitmentId, candidateId]);
  if (dup.rowCount) throw conflict('ALREADY_APPLIED', 'This candidate has already applied to this recruitment');

  const resumeId = await claimDocument(tx, input.resume, 'resume', candidateId);
  const photoId = await claimDocument(tx, input.photo, 'photo', candidateId);

  const ins = await tx.query(
    `INSERT INTO applications (tenant_id, reference, recruitment_id, candidate_id, job_position_id, stage_id, cover_letter, answers,
                               resume_document_id, photo_document_id, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id, reference`,
    [actor.tenantId, makeReference(), recruitmentId, candidateId, positionId, Number(stage.rows[0].id), input.coverLetter ?? null,
     JSON.stringify(input.answers ?? []), resumeId, photoId, input.source, actor.userId],
  );
  const id = Number(ins.rows[0].id);
  await tx.query(
    `INSERT INTO application_stage_log (tenant_id, application_id, from_stage_id, to_stage_id, actor_user_id, note)
     VALUES ($1,$2,NULL,$3,$4,$5)`,
    [actor.tenantId, id, Number(stage.rows[0].id), actor.userId, input.source === 'careers' ? 'Applied through the careers site' : 'Added by HR']);
  await writeAudit(tx, actor as any, {
    action: 'created', entityType: 'application', entityId: id,
    after: { recruitmentId, candidateId, jobPositionId: positionId, source: input.source },
  });
  await enqueueEvent(tx, actor.tenantId, 'recruitment.application.received', 'application', id, {
    reference: ins.rows[0].reference, recruitmentTitle: rec.rows[0].title, candidateEmail: email, candidateName: input.fullName,
  });
  return { id, reference: ins.rows[0].reference as string, candidateId, recruitmentTitle: rec.rows[0].title as string };
}

export async function createManualApplication(tx: Tx, auth: AuthContext, recruitmentId: number, b: z.infer<typeof ApplicationCreate>) {
  const r = await createApplicationRecord(tx, auth, recruitmentId, { ...b, answers: [] });
  return getApplication(tx, r.id);
}

// -------------------------------------------------------------------- move ---

/** Locks the application row. */
async function lockApplication(tx: Tx, id: number) {
  const r = await tx.query(`SELECT * FROM applications WHERE id = $1 FOR UPDATE`, [id]);
  if (!r.rowCount) throw notFound('Application');
  return r.rows[0];
}

interface MoveOpts { stageId: number; note?: string | null; rejectionReasonId?: number | null; rejectionNote?: string | null }

async function moveCore(tx: Tx, auth: AuthContext, row: any, o: MoveOpts) {
  const stage = await tx.query(`SELECT id, name, stage_type, recruitment_id FROM recruitment_stages WHERE id = $1`, [o.stageId]);
  if (!stage.rowCount || Number(stage.rows[0].recruitment_id) !== Number(row.recruitment_id)) {
    throw fieldError('stageId', 'That stage does not belong to this recruitment');
  }
  const target = stage.rows[0];
  if (Number(row.stage_id) === Number(target.id)) return false;

  let status: 'active' | 'hired' | 'rejected' = 'active';
  let positionId: number | null = row.job_position_id ? Number(row.job_position_id) : null;

  if (target.stage_type === 'hired') {
    status = 'hired';
    if (positionId === null) {
      const lines = await tx.query(`SELECT job_position_id FROM recruitment_vacancies WHERE recruitment_id = $1`, [row.recruitment_id]);
      if (lines.rowCount !== 1) throw conflict('POSITION_REQUIRED', 'Choose which job position this candidate is hired for first');
      positionId = Number(lines.rows[0].job_position_id);
    }
    // The vacancy line is the lock: two hires for the last place serialize here.
    const line = await tx.query(
      `SELECT v.id, v.vacancies, jp.title FROM recruitment_vacancies v JOIN rec_job_positions jp ON jp.tenant_id = v.tenant_id AND jp.id = v.job_position_id
        WHERE v.recruitment_id = $1 AND v.job_position_id = $2 FOR UPDATE OF v`, [row.recruitment_id, positionId]);
    if (!line.rowCount) throw conflict('POSITION_REQUIRED', 'This candidate\'s job position is not part of the recruitment');
    const filled = await tx.query(
      `SELECT count(*)::int AS n FROM applications WHERE recruitment_id = $1 AND job_position_id = $2 AND status = 'hired' AND id <> $3`,
      [row.recruitment_id, positionId, row.id]);
    if (filled.rows[0].n >= line.rows[0].vacancies) {
      throw conflict('VACANCY_FULL', `All ${line.rows[0].vacancies} place${line.rows[0].vacancies === 1 ? '' : 's'} for "${line.rows[0].title}" are already filled`);
    }
  } else if (target.stage_type === 'rejected') {
    status = 'rejected';
    if (o.rejectionReasonId) {
      const rr = await tx.query(`SELECT is_active FROM rejection_reasons WHERE id = $1`, [o.rejectionReasonId]);
      if (!rr.rowCount) throw fieldError('rejectionReasonId', 'Rejection reason not found');
    }
  }

  await tx.query(
    `UPDATE applications SET stage_id = $2, status = $3::text, job_position_id = $4, stage_changed_at = now(),
            hired_at = CASE WHEN $3::text = 'hired' THEN now() ELSE NULL END,
            rejection_reason_id = CASE WHEN $3::text = 'rejected' THEN $5::bigint ELSE NULL END,
            rejection_note = CASE WHEN $3::text = 'rejected' THEN $6::text ELSE NULL END
      WHERE id = $1`,
    [row.id, target.id, status, positionId, o.rejectionReasonId ?? null, o.rejectionNote ?? null]);
  await tx.query(
    `INSERT INTO application_stage_log (tenant_id, application_id, from_stage_id, to_stage_id, actor_user_id, note)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [auth.tenantId, row.id, row.stage_id, target.id, auth.userId, o.note ?? o.rejectionNote ?? null]);
  await writeAudit(tx, auth, {
    action: status === 'hired' ? 'hired' : status === 'rejected' ? 'rejected' : 'stage_changed', entityType: 'application', entityId: Number(row.id),
    before: { stageId: Number(row.stage_id), status: row.status }, after: { stageId: Number(target.id), status },
  });
  if (status !== 'active') {
    const info = await tx.query(
      `SELECT c.email, c.full_name, rc.title FROM rec_candidates c, recruitments rc WHERE c.id = $1 AND rc.id = $2`,
      [row.candidate_id, row.recruitment_id]);
    await enqueueEvent(tx, auth.tenantId, `recruitment.application.${status}`, 'application', Number(row.id), {
      reference: row.reference, recruitmentTitle: info.rows[0].title, candidateEmail: info.rows[0].email, candidateName: info.rows[0].full_name,
    });
  }
  return true;
}

export async function moveApplication(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof ApplicationMove>) {
  const row = await lockApplication(tx, id);
  assertFresh(row, b.updatedAt);
  await moveCore(tx, auth, row, b);
  return getApplication(tx, id);
}

/** Each candidate moves in its own savepoint: one failure (vacancy full, stale stage) does not undo the rest. */
export async function bulkMove(tx: Tx, auth: AuthContext, b: z.infer<typeof ApplicationBulkMove>) {
  const moved: number[] = [];
  const failed: { id: number; code: string; message: string }[] = [];
  for (const id of b.ids) {
    await tx.query('SAVEPOINT bulk_move');
    try {
      const row = await lockApplication(tx, id);
      await moveCore(tx, auth, row, b);
      await tx.query('RELEASE SAVEPOINT bulk_move');
      moved.push(id);
    } catch (err: any) {
      await tx.query('ROLLBACK TO SAVEPOINT bulk_move');
      if (err instanceof AppError) failed.push({ id, code: err.code, message: err.message });
      else throw err;
    }
  }
  return { moved, failed };
}

export async function patchApplication(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof ApplicationPatch>) {
  const row = await lockApplication(tx, id);
  assertFresh(row, b.updatedAt);
  const changes: Record<string, unknown> = {};
  if (b.rating !== undefined) changes.rating = b.rating;
  if (b.jobPositionId !== undefined) {
    if (row.status === 'hired') throw conflict('ALREADY_HIRED', 'Move the candidate out of Hired before changing the role');
    if (b.jobPositionId !== null) {
      const ok = await tx.query(`SELECT 1 FROM recruitment_vacancies WHERE recruitment_id = $1 AND job_position_id = $2`, [row.recruitment_id, b.jobPositionId]);
      if (!ok.rowCount) throw fieldError('jobPositionId', 'This role is not part of the recruitment');
    }
    changes.job_position_id = b.jobPositionId;
  }
  if (Object.keys(changes).length) {
    const set = buildSet(changes, 2);
    await tx.query(`UPDATE applications SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
    await writeAudit(tx, auth, {
      action: 'updated', entityType: 'application', entityId: id,
      before: { rating: row.rating, jobPositionId: row.job_position_id }, after: changes,
    });
  }
  return getApplication(tx, id);
}

export async function addNote(tx: Tx, auth: AuthContext, id: number, body: string) {
  const ok = await tx.query(`SELECT 1 FROM applications WHERE id = $1`, [id]);
  if (!ok.rowCount) throw notFound('Application');
  await tx.query(`INSERT INTO application_notes (tenant_id, application_id, author_user_id, body) VALUES ($1,$2,$3,$4)`,
    [auth.tenantId, id, auth.userId, body]);
  return getApplication(tx, id);
}

// -------------------------------------------------------------- rec_candidates ---

export async function listCandidates(tx: Tx, q: z.infer<typeof CandidateListQuery>) {
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count FROM (
       SELECT c.*,
              (SELECT count(*)::int FROM applications a WHERE a.candidate_id = c.id) AS application_count,
              (SELECT count(*)::int FROM applications a WHERE a.candidate_id = c.id AND a.status = 'active') AS active_count,
              (SELECT string_agg(rc.title || ' · ' || s.name, E'\\n' ORDER BY a.applied_at DESC)
                 FROM applications a JOIN recruitments rc ON rc.tenant_id = a.tenant_id AND rc.id = a.recruitment_id
                 JOIN recruitment_stages s ON s.tenant_id = a.tenant_id AND s.id = a.stage_id
                WHERE a.candidate_id = c.id) AS applications_text
         FROM rec_candidates c) t
      WHERE ($1::text IS NULL OR t.full_name ILIKE $1 OR t.email::text ILIKE $1 OR t.phone ILIKE $1 OR t.current_title ILIKE $1)
        AND ($2::text IS NULL OR t.source = $2)
        AND ($3::bigint IS NULL OR EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = t.id AND a.recruitment_id = $3))
      ORDER BY ${q.sort === 'name' ? 'lower(t.full_name) ASC' : 't.created_at DESC'}, t.id
      LIMIT $4 OFFSET $5`,
    [q.search ? likeTerm(q.search) : null, q.source ?? null, q.recruitmentId ?? null, q.limit, (q.page - 1) * q.limit],
  );
  return {
    items: r.rows.map((c) => ({ ...toCandidate(c), applicationCount: c.application_count as number, activeCount: c.active_count as number,
      applicationsText: (c.applications_text ?? null) as string | null })),
    total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit,
  };
}

const toCandidate = (c: any) => ({
  id: Number(c.id), fullName: c.full_name as string, email: c.email as string, phone: (c.phone ?? null) as string | null,
  currentCompany: (c.current_company ?? null) as string | null, currentTitle: (c.current_title ?? null) as string | null,
  experienceYears: (c.experience_years ?? null) as number | null, location: (c.location ?? null) as string | null,
  linkedinUrl: (c.linkedin_url ?? null) as string | null, source: c.source as string,
  createdAt: c.created_at as Date, updatedAt: c.updated_at as Date,
});

export async function getCandidate(tx: Tx, id: number) {
  const c = await tx.query(`SELECT * FROM rec_candidates WHERE id = $1`, [id]);
  if (!c.rowCount) throw notFound('Candidate');
  const apps = await listApplications(tx, { candidateId: id, status: 'all', sort: 'recent', page: 1, limit: 100 });
  const docs = await tx.query(
    `SELECT id, kind, file_name, content_type, byte_size, created_at FROM candidate_documents WHERE candidate_id = $1 ORDER BY created_at DESC`, [id]);
  return {
    ...toCandidate(c.rows[0]),
    applications: apps.items,
    documents: docs.rows.map((d) => ({
      id: Number(d.id), kind: d.kind as 'resume' | 'photo', fileName: d.file_name as string, contentType: d.content_type as string,
      byteSize: d.byte_size as number, uploadedAt: d.created_at as Date, url: `/api/v1/recruitment/documents/${d.id}`,
    })),
  };
}

export async function patchCandidate(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof CandidatePatch>) {
  const lock = await tx.query(`SELECT * FROM rec_candidates WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound('Candidate');
  assertFresh(lock.rows[0], b.updatedAt);
  const map: Record<string, string> = {
    fullName: 'full_name', phone: 'phone', currentCompany: 'current_company', currentTitle: 'current_title',
    experienceYears: 'experience_years', location: 'location', linkedinUrl: 'linkedin_url',
  };
  const changes: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(map)) if ((b as any)[k] !== undefined) changes[col] = (b as any)[k];
  if (Object.keys(changes).length) {
    const set = buildSet(changes, 2);
    await tx.query(`UPDATE rec_candidates SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
    await writeAudit(tx, auth, { action: 'candidate_updated', entityType: 'candidate', entityId: id, before: lock.rows[0] && pick(lock.rows[0], Object.keys(changes)), after: changes });
  }
  return getCandidate(tx, id);
}

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k]]));

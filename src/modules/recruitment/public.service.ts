import type { z } from 'zod';
import { env } from '../../config/env';
import { queryNoTenant, type Tx } from '../../config/db';
import { notFound, unprocessable } from '../../shared/errors';
import { postgresAssetStorage } from '../organization/asset-storage';
import { createApplicationRecord } from './application.service';
import { likeTerm } from './recruitment.common';
import type { PublicApplyBody, PublicJobsQuery } from './recruitment.schemas';

/**
 * The careers site has no session. The tenant is resolved by two narrow
 * SECURITY DEFINER lookups (organization slug, job slug); everything after
 * that runs in an ordinary tenant transaction under RLS. Only recruitments
 * that are published, open, inside their date window and still have a free
 * place are ever returned, and only fields meant for applicants.
 */

export async function resolveOrgTenant(slug: string | undefined): Promise<number> {
  const s = slug ?? env.CAREERS_DEFAULT_TENANT_SLUG;
  if (!s) throw unprocessable('ORG_REQUIRED', 'Tell us which organization to show (add ?org=your-organization to the link)');
  const r = await queryNoTenant(`SELECT * FROM public_tenant_by_slug($1)`, [s]);
  if (!r.rowCount) throw notFound('Organization');
  return Number(r.rows[0].tenant_id);
}

export async function resolveJobTenant(jobSlug: string): Promise<number> {
  const r = await queryNoTenant(`SELECT * FROM public_tenant_by_job_slug($1)`, [jobSlug]);
  if (!r.rowCount) throw notFound('Job');
  return Number(r.rows[0].tenant_id);
}

/** A recruitment applicants can see and apply to. */
const OPEN = `r.is_published AND r.status = 'open' AND r.start_date <= tenant_today() AND (r.end_date IS NULL OR r.end_date >= tenant_today())`;

const JOB_SELECT = `
  SELECT r.id, r.slug, r.title, r.description, r.skills, r.start_date, r.end_date, r.created_at,
         r.optional_resume, r.optional_photo, r.survey_template_id,
         COALESCE((
           SELECT json_agg(json_build_object('id', jp.id, 'title', jp.title, 'department', d.name,
                                              'openPlaces', v.vacancies - (SELECT count(*) FROM applications a
                                                WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id AND a.status = 'hired'))
                           ORDER BY jp.title)
             FROM recruitment_vacancies v
             JOIN rec_job_positions jp ON jp.tenant_id = v.tenant_id AND jp.id = v.job_position_id
             LEFT JOIN departments d ON d.tenant_id = jp.tenant_id AND d.id = jp.department_id
            WHERE v.recruitment_id = r.id
              AND v.vacancies > (SELECT count(*) FROM applications a
                                  WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id AND a.status = 'hired')
         ), '[]'::json) AS positions
    FROM recruitments r
   WHERE ${OPEN}`;

type Position = { id: number; title: string; department: string | null; openPlaces: number };

const plain = (md: string) => md.replace(/[#*_`>\-]+/g, ' ').replace(/\s+/g, ' ').trim();

async function organization(tx: Tx) {
  const t = await tx.query(`SELECT name FROM tenants`);
  const s = await tx.query(`SELECT * FROM recruitment_settings`);
  const logo = await postgresAssetStorage.head(tx, 'logo');
  return { t: t.rows[0], s: s.rows[0], hasLogo: !!logo };
}

export async function listJobs(tx: Tx, orgSlug: string, q: z.infer<typeof PublicJobsQuery>) {
  const { t, s, hasLogo } = await organization(tx);
  if (s && !s.careers_enabled) throw notFound('Careers page');
  const r = await tx.query(
    `SELECT x.* FROM (${JOB_SELECT}) x
      WHERE json_array_length(x.positions) > 0
        AND ($1::text IS NULL OR x.title ILIKE $1 OR x.description ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(x.skills) k WHERE k ILIKE $1))
      ORDER BY x.created_at DESC, x.id DESC LIMIT 200`,
    [q.search ? likeTerm(q.search) : null]);
  let jobs = r.rows.map((j) => {
    const positions = j.positions as Position[];
    return {
      slug: j.slug as string, title: j.title as string, excerpt: plain(j.description).slice(0, 220),
      skills: j.skills as string[], startDate: j.start_date as string, endDate: (j.end_date ?? null) as string | null,
      departments: [...new Set(positions.map((p) => p.department).filter((d): d is string => !!d))],
      openPlaces: positions.reduce((n, p) => n + p.openPlaces, 0), positionTitles: positions.map((p) => p.title),
    };
  });
  const departments = [...new Set(jobs.flatMap((j) => j.departments))].sort((a, b) => a.localeCompare(b));
  if (q.department) jobs = jobs.filter((j) => j.departments.includes(q.department!));
  return {
    organization: {
      name: t.name as string, slug: orgSlug, logoUrl: hasLogo ? `/api/v1/public/careers/logo?org=${encodeURIComponent(orgSlug)}` : null,
      headline: (s?.careers_headline ?? null) as string | null, intro: (s?.careers_intro ?? null) as string | null,
    },
    departments, jobs,
  };
}

async function loadJob(tx: Tx, slug: string) {
  const r = await tx.query(`SELECT x.* FROM (${JOB_SELECT}) x WHERE x.slug = $1 AND json_array_length(x.positions) > 0`, [slug]);
  if (!r.rowCount) throw notFound('Job');
  return r.rows[0];
}

export async function getJob(tx: Tx, slug: string) {
  const j = await loadJob(tx, slug);
  const { t, s, hasLogo } = await organization(tx);
  if (s && !s.careers_enabled) throw notFound('Job');
  const orgSlug = (await tx.query(`SELECT slug FROM tenants`)).rows[0].slug as string;
  const survey = j.survey_template_id
    ? (await tx.query(`SELECT questions FROM survey_templates WHERE id = $1`, [j.survey_template_id])).rows[0]?.questions ?? []
    : [];
  return {
    organization: {
      name: t.name as string, slug: orgSlug, logoUrl: hasLogo ? `/api/v1/public/careers/logo?org=${encodeURIComponent(orgSlug)}` : null,
      privacyNoticeUrl: (s?.privacy_notice_url ?? null) as string | null,
    },
    job: {
      slug: j.slug as string, title: j.title as string, description: j.description as string, skills: j.skills as string[],
      startDate: j.start_date as string, endDate: (j.end_date ?? null) as string | null,
      positions: j.positions as Position[], resumeRequired: !j.optional_resume, photoAllowed: j.optional_photo as boolean,
      questions: survey as { id: string; label: string; type: string; required: boolean; options: string[] }[],
    },
  };
}

export async function getLogo(tx: Tx) {
  return postgresAssetStorage.get(tx, 'logo');
}

/** Answers are validated against the template the recruitment uses and stored with their question text. */
function checkAnswers(
  questions: { id: string; label: string; type: string; required: boolean; options: string[] }[],
  given: z.infer<typeof PublicApplyBody>['answers'],
) {
  const byId = new Map(given.map((a) => [a.questionId, a.value]));
  const out: { questionId: string; label: string; type: string; value: string | number | boolean }[] = [];
  const errors: Record<string, string> = {};
  for (const q of questions) {
    const v = byId.get(q.id);
    const empty = v === undefined || v === '' || v === null;
    if (empty) {
      if (q.required) errors[`answer_${q.id}`] = 'This question is required';
      continue;
    }
    if (q.type === 'number' && (typeof v !== 'number' || !Number.isFinite(v))) errors[`answer_${q.id}`] = 'Enter a number';
    else if (q.type === 'yes_no' && typeof v !== 'boolean') errors[`answer_${q.id}`] = 'Choose yes or no';
    else if (q.type === 'select' && (typeof v !== 'string' || !q.options.includes(v))) errors[`answer_${q.id}`] = 'Choose one of the options';
    else if ((q.type === 'text' || q.type === 'textarea') && typeof v !== 'string') errors[`answer_${q.id}`] = 'Enter text';
    else out.push({ questionId: q.id, label: q.label, type: q.type, value: v as string | number | boolean });
  }
  if (Object.keys(errors).length) throw unprocessable('VALIDATION_FAILED', 'Please answer the highlighted questions', { fieldErrors: errors });
  return out;
}

export async function apply(tx: Tx, tenantId: number, slug: string, b: z.infer<typeof PublicApplyBody>, requestId?: string) {
  const job = await loadJob(tx, slug);
  const s = (await tx.query(`SELECT * FROM recruitment_settings`)).rows[0];
  if (s && !s.careers_enabled) throw notFound('Job');

  if (b.website) {
    // A bot filled the hidden field: answer like a success, store nothing.
    return { reference: 'APP-0000-000000', jobTitle: job.title as string, message: s?.confirmation_message ?? null };
  }
  if (!job.optional_resume && !b.resume) throw unprocessable('VALIDATION_FAILED', 'Please attach your resume', { fieldErrors: { resume: 'Please attach your resume' } });
  if (b.photo && !job.optional_photo) throw unprocessable('VALIDATION_FAILED', 'This job does not take a photo', { fieldErrors: { photo: 'This job does not take a photo' } });

  const questions = job.survey_template_id
    ? (await tx.query(`SELECT questions FROM survey_templates WHERE id = $1`, [job.survey_template_id])).rows[0]?.questions ?? []
    : [];
  const answers = checkAnswers(questions, b.answers);

  const positions = job.positions as Position[];
  if (b.jobPositionId != null && !positions.some((p) => p.id === b.jobPositionId)) {
    throw unprocessable('VALIDATION_FAILED', 'That role is no longer open', { fieldErrors: { jobPositionId: 'That role is no longer open' } });
  }
  const r = await createApplicationRecord(tx, { tenantId, userId: null, requestId }, Number(job.id), {
    fullName: b.fullName, email: b.email, phone: b.phone, currentCompany: b.currentCompany, currentTitle: b.currentTitle,
    experienceYears: b.experienceYears, location: b.location, linkedinUrl: b.linkedinUrl,
    jobPositionId: b.jobPositionId ?? (positions.length === 1 ? positions[0].id : null),
    coverLetter: b.coverLetter, resume: b.resume, photo: b.photo, answers, source: 'careers',
  });
  return { reference: r.reference, jobTitle: job.title as string, message: (s?.confirmation_message ?? null) as string | null };
}

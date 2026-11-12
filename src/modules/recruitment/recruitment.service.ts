import type { Tx } from '../../config/db';
import { conflict, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { assertFresh, buildSet, likeTerm, makeSlug, writeAudit } from './recruitment.common';
import type { StageType } from './recruitment.schemas';
import type { z } from 'zod';
import type { RecruitmentCreate, RecruitmentListQuery, RecruitmentPatch } from './recruitment.schemas';

type Create = z.infer<typeof RecruitmentCreate>;
type Patch = z.infer<typeof RecruitmentPatch>;
type ListQ = z.infer<typeof RecruitmentListQuery>;
type StageInput = { id?: number; name: string; stageType: StageType };

const fieldError = (field: string, message: string) =>
  unprocessable('VALIDATION_FAILED', message, { fieldErrors: { [field]: message } });

/** Stages that every pipeline has exactly once and whose type never changes. */
const FIXED_TYPES = new Set<StageType>(['applied', 'hired', 'rejected']);

/**
 * The entry stage comes first, "rejected" is last, "hired" sits before it and
 * names are unique. The database enforces one of each type; this gives a readable message first.
 */
export function validateStages(stages: StageInput[]) {
  const count = (t: StageType) => stages.filter((s) => s.stageType === t).length;
  if (count('applied') !== 1 || stages[0].stageType !== 'applied') {
    throw fieldError('stages', 'The first stage must be the single "Applied" stage');
  }
  if (count('rejected') !== 1 || stages[stages.length - 1].stageType !== 'rejected') {
    throw fieldError('stages', 'The last stage must be the single "Rejected" stage');
  }
  if (count('hired') !== 1) throw fieldError('stages', 'The pipeline needs exactly one "Hired" stage');
  const names = new Set<string>();
  for (const s of stages) {
    const k = s.name.trim().toLowerCase();
    if (names.has(k)) throw fieldError('stages', `Stage name "${s.name}" is used twice`);
    names.add(k);
  }
}

// ------------------------------------------------------------------- reads ---

const BASE_SELECT = `
  SELECT r.*,
         (SELECT COALESCE(sum(v.vacancies), 0)::int FROM recruitment_vacancies v WHERE v.recruitment_id = r.id) AS total_vacancies,
         (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = r.id AND a.status = 'hired') AS filled,
         (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = r.id) AS application_count
    FROM recruitments r`;

const toSummary = (r: any) => ({
  id: Number(r.id),
  title: r.title as string,
  slug: r.slug as string,
  status: r.status as 'open' | 'closed',
  isPublished: r.is_published as boolean,
  startDate: r.start_date as string,
  endDate: (r.end_date ?? null) as string | null,
  totalVacancies: r.total_vacancies as number,
  filled: r.filled as number,
  applicationCount: r.application_count as number,
  updatedAt: r.updated_at as Date,
});

export async function listRecruitments(tx: Tx, q: ListQ) {
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count
       FROM (${BASE_SELECT}) t
      WHERE ($1::text = 'all' OR t.status = $1)
        AND ($2::text IS NULL OR t.title ILIKE $2)
      ORDER BY t.status DESC, t.created_at DESC, t.id DESC
      LIMIT $3 OFFSET $4`,
    [q.status, q.search ? likeTerm(q.search) : null, q.limit, (q.page - 1) * q.limit],
  );
  return { items: r.rows.map(toSummary), total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit };
}

export async function getRecruitment(tx: Tx, id: number) {
  const r = await tx.query(`SELECT t.* FROM (${BASE_SELECT}) t WHERE t.id = $1`, [id]);
  if (!r.rowCount) throw notFound('Recruitment');
  const row = r.rows[0];

  const managers = await tx.query(
    `SELECT e.id, e.full_name, e.employee_code, e.job_title
       FROM recruitment_managers m JOIN employees e ON e.tenant_id = m.tenant_id AND e.id = m.employee_id
      WHERE m.recruitment_id = $1 ORDER BY lower(e.full_name), e.id`, [id]);
  const vacancies = await tx.query(
    `SELECT v.id, v.job_position_id, v.vacancies, jp.title, d.name AS department_name,
            (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id) AS applied,
            (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id AND a.status = 'hired') AS filled
       FROM recruitment_vacancies v
       JOIN rec_job_positions jp ON jp.tenant_id = v.tenant_id AND jp.id = v.job_position_id
       LEFT JOIN departments d ON d.tenant_id = jp.tenant_id AND d.id = jp.department_id
      WHERE v.recruitment_id = $1 ORDER BY v.id`, [id]);
  const stages = await tx.query(
    `SELECT s.id, s.name, s.stage_type, s.sequence,
            (SELECT count(*)::int FROM applications a WHERE a.stage_id = s.id) AS count
       FROM recruitment_stages s WHERE s.recruitment_id = $1 ORDER BY s.sequence`, [id]);
  const survey = row.survey_template_id
    ? (await tx.query(`SELECT id, name FROM survey_templates WHERE id = $1`, [row.survey_template_id])).rows[0]
    : null;

  return {
    ...toSummary(row),
    description: row.description as string,
    optionalResume: row.optional_resume as boolean,
    optionalPhoto: row.optional_photo as boolean,
    skills: row.skills as string[],
    surveyTemplate: survey ? { id: Number(survey.id), name: survey.name as string } : null,
    publicPath: `/careers/${row.slug}`,
    managers: managers.rows.map((m) => ({
      id: Number(m.id), name: m.full_name as string, code: m.employee_code as string, jobTitle: (m.job_title ?? null) as string | null,
    })),
    vacancies: vacancies.rows.map((v) => ({
      id: Number(v.id), jobPositionId: Number(v.job_position_id), title: v.title as string,
      department: (v.department_name ?? null) as string | null,
      vacancies: v.vacancies as number, applied: v.applied as number, filled: v.filled as number,
    })),
    stages: stages.rows.map((s) => ({
      id: Number(s.id), name: s.name as string, stageType: s.stage_type as StageType, sequence: s.sequence as number, count: s.count as number,
    })),
    createdAt: row.created_at as Date,
  };
}

/** Audit snapshot: business fields only. */
const snapshot = (d: Awaited<ReturnType<typeof getRecruitment>>) => ({
  title: d.title, description: d.description, startDate: d.startDate, endDate: d.endDate, status: d.status,
  isPublished: d.isPublished, optionalResume: d.optionalResume, optionalPhoto: d.optionalPhoto, skills: d.skills,
  surveyTemplateId: d.surveyTemplate?.id ?? null,
  managerIds: d.managers.map((m) => m.id),
  vacancies: d.vacancies.map((v) => ({ jobPositionId: v.jobPositionId, vacancies: v.vacancies })),
  stages: d.stages.map((s) => ({ name: s.name, stageType: s.stageType })),
});

// ------------------------------------------------------------- validations ---

async function assertManagers(tx: Tx, ids: number[]) {
  const r = await tx.query(`SELECT id FROM employees WHERE id = ANY($1::bigint[]) AND status <> 'exited'`, [ids]);
  if (r.rowCount !== ids.length) throw fieldError('managerIds', 'One of the managers is not a current employee');
}

async function assertPositions(tx: Tx, ids: number[], onlyNew?: number[]) {
  const r = await tx.query(`SELECT id, is_active FROM rec_job_positions WHERE id = ANY($1::bigint[])`, [ids]);
  if (r.rowCount !== ids.length) throw fieldError('vacancies', 'One of the job positions does not exist');
  const inactive = r.rows.filter((p) => !p.is_active && (!onlyNew || onlyNew.includes(Number(p.id))));
  if (inactive.length) throw fieldError('vacancies', 'One of the job positions is inactive');
}

async function assertSurvey(tx: Tx, id: number | null | undefined, current?: number | null) {
  if (id == null || id === current) return;
  const r = await tx.query(`SELECT is_active FROM survey_templates WHERE id = $1`, [id]);
  if (!r.rowCount) throw fieldError('surveyTemplateId', 'Survey template not found');
  if (!r.rows[0].is_active) throw fieldError('surveyTemplateId', 'This survey template is inactive');
}

// ------------------------------------------------------------------ create ---

export async function createRecruitment(tx: Tx, auth: AuthContext, b: Create) {
  validateStages(b.stages);
  await assertManagers(tx, b.managerIds);
  await assertPositions(tx, b.vacancies.map((v) => v.jobPositionId));
  await assertSurvey(tx, b.surveyTemplateId);

  const ins = await tx.query(
    `INSERT INTO recruitments
       (tenant_id, title, slug, description, start_date, end_date, is_published, optional_resume, optional_photo,
        skills, survey_template_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
    [auth.tenantId, b.title, makeSlug(b.title), b.description, b.startDate, b.endDate ?? null, b.isPublished,
     b.optionalResume, b.optionalPhoto, dedupeSkills(b.skills), b.surveyTemplateId ?? null, auth.userId],
  );
  const id = Number(ins.rows[0].id);

  for (const m of b.managerIds) {
    await tx.query(`INSERT INTO recruitment_managers (tenant_id, recruitment_id, employee_id) VALUES ($1,$2,$3)`, [auth.tenantId, id, m]);
  }
  for (const v of b.vacancies) {
    await tx.query(
      `INSERT INTO recruitment_vacancies (tenant_id, recruitment_id, job_position_id, vacancies) VALUES ($1,$2,$3,$4)`,
      [auth.tenantId, id, v.jobPositionId, v.vacancies]);
  }
  for (const [i, s] of b.stages.entries()) {
    await tx.query(
      `INSERT INTO recruitment_stages (tenant_id, recruitment_id, name, stage_type, sequence) VALUES ($1,$2,$3,$4,$5)`,
      [auth.tenantId, id, s.name, s.stageType, i + 1]);
  }
  const created = await getRecruitment(tx, id);
  await writeAudit(tx, auth, { action: 'created', entityType: 'recruitment', entityId: id, after: snapshot(created) });
  return created;
}

const dedupeSkills = (skills: string[]) => {
  const seen = new Set<string>();
  return skills.filter((s) => (seen.has(s.toLowerCase()) ? false : (seen.add(s.toLowerCase()), true)));
};

// ------------------------------------------------------------------ update ---

export async function updateRecruitment(tx: Tx, auth: AuthContext, id: number, b: Patch) {
  const lock = await tx.query(`SELECT * FROM recruitments WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound('Recruitment');
  const row = lock.rows[0];
  assertFresh(row, b.updatedAt);
  const before = snapshot(await getRecruitment(tx, id));

  const newStart = b.startDate ?? row.start_date;
  const newEnd = b.endDate === undefined ? row.end_date : b.endDate;
  if (newEnd && newEnd < newStart) throw fieldError('endDate', 'End date is before the start date');
  if (b.surveyTemplateId !== undefined) await assertSurvey(tx, b.surveyTemplateId, row.survey_template_id ? Number(row.survey_template_id) : null);

  const changes: Record<string, unknown> = {};
  if (b.title !== undefined) changes.title = b.title;
  if (b.description !== undefined) changes.description = b.description;
  if (b.startDate !== undefined) changes.start_date = b.startDate;
  if (b.endDate !== undefined) changes.end_date = b.endDate;
  if (b.surveyTemplateId !== undefined) changes.survey_template_id = b.surveyTemplateId;
  if (b.skills !== undefined) changes.skills = dedupeSkills(b.skills);
  if (b.isPublished !== undefined) changes.is_published = b.isPublished;
  if (b.optionalResume !== undefined) changes.optional_resume = b.optionalResume;
  if (b.optionalPhoto !== undefined) changes.optional_photo = b.optionalPhoto;
  changes.updated_by = auth.userId;
  const set = buildSet(changes, 2);
  await tx.query(`UPDATE recruitments SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
  // updated_at is bumped by the trigger even when only children changed below.

  if (b.managerIds) await replaceManagers(tx, auth, id, b.managerIds);
  if (b.vacancies) await replaceVacancies(tx, auth, id, b.vacancies);
  if (b.stages) await replaceStages(tx, auth, id, b.stages);
  await tx.query(`UPDATE recruitments SET updated_by = $2 WHERE id = $1`, [id, auth.userId]);

  const after = await getRecruitment(tx, id);
  await writeAudit(tx, auth, { action: 'updated', entityType: 'recruitment', entityId: id, before, after: snapshot(after) });
  return after;
}

async function replaceManagers(tx: Tx, auth: AuthContext, id: number, ids: number[]) {
  await assertManagers(tx, ids);
  await tx.query(`DELETE FROM recruitment_managers WHERE recruitment_id = $1 AND NOT (employee_id = ANY($2::bigint[]))`, [id, ids]);
  await tx.query(
    `INSERT INTO recruitment_managers (tenant_id, recruitment_id, employee_id)
     SELECT $1, $2, x FROM unnest($3::bigint[]) x ON CONFLICT DO NOTHING`, [auth.tenantId, id, ids]);
}

async function replaceVacancies(tx: Tx, auth: AuthContext, id: number, lines: Create['vacancies']) {
  const existing = await tx.query(
    `SELECT v.id, v.job_position_id, jp.title,
            (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id) AS applied,
            (SELECT count(*)::int FROM applications a WHERE a.recruitment_id = v.recruitment_id AND a.job_position_id = v.job_position_id AND a.status = 'hired') AS filled
       FROM recruitment_vacancies v JOIN rec_job_positions jp ON jp.tenant_id = v.tenant_id AND jp.id = v.job_position_id
      WHERE v.recruitment_id = $1 FOR UPDATE OF v`, [id]);
  const byPosition = new Map(existing.rows.map((r) => [Number(r.job_position_id), r]));
  await assertPositions(tx, lines.map((l) => l.jobPositionId), lines.map((l) => l.jobPositionId).filter((p) => !byPosition.has(p)));

  const keep = new Set(lines.map((l) => l.jobPositionId));
  for (const [pos, r] of byPosition) {
    if (keep.has(pos)) continue;
    if (r.applied > 0) {
      throw conflict('VACANCY_IN_USE', `"${r.title}" already has ${r.applied} application${r.applied === 1 ? '' : 's'} and cannot be removed`,
        { fieldErrors: { vacancies: `"${r.title}" already has applications and cannot be removed` } });
    }
    await tx.query(`DELETE FROM recruitment_vacancies WHERE id = $1`, [r.id]);
  }
  for (const l of lines) {
    const cur = byPosition.get(l.jobPositionId);
    if (!cur) {
      await tx.query(
        `INSERT INTO recruitment_vacancies (tenant_id, recruitment_id, job_position_id, vacancies) VALUES ($1,$2,$3,$4)`,
        [auth.tenantId, id, l.jobPositionId, l.vacancies]);
    } else {
      if (l.vacancies < cur.filled) {
        throw conflict('VACANCY_BELOW_FILLED', `"${cur.title}" already has ${cur.filled} hired; vacancies cannot go below that`,
          { fieldErrors: { vacancies: `"${cur.title}" already has ${cur.filled} hired` } });
      }
      await tx.query(`UPDATE recruitment_vacancies SET vacancies = $2 WHERE id = $1`, [cur.id, l.vacancies]);
    }
  }
}

async function replaceStages(tx: Tx, auth: AuthContext, id: number, stages: StageInput[]) {
  validateStages(stages);
  const existing = await tx.query(
    `SELECT s.id, s.name, s.stage_type,
            (SELECT count(*)::int FROM applications a WHERE a.stage_id = s.id) AS applications,
            (SELECT count(*)::int FROM application_stage_log l WHERE l.from_stage_id = s.id OR l.to_stage_id = s.id) AS history
       FROM recruitment_stages s WHERE s.recruitment_id = $1 FOR UPDATE OF s`, [id]);
  const byId = new Map(existing.rows.map((r) => [Number(r.id), r]));
  const sent = new Set<number>();
  for (const s of stages) {
    if (s.id === undefined) continue;
    const cur = byId.get(s.id);
    if (!cur) throw fieldError('stages', 'A stage does not belong to this recruitment');
    if (sent.has(s.id)) throw fieldError('stages', 'A stage appears twice');
    sent.add(s.id);
    if (cur.stage_type !== s.stageType && (FIXED_TYPES.has(cur.stage_type) || FIXED_TYPES.has(s.stageType))) {
      throw fieldError('stages', `The type of "${cur.name}" cannot be changed`);
    }
  }
  const removed = existing.rows.filter((r) => !sent.has(Number(r.id)));
  for (const r of removed) {
    if (r.applications > 0) throw conflict('STAGE_IN_USE', `"${r.name}" has ${r.applications} candidate${r.applications === 1 ? '' : 's'}; move them first`,
      { fieldErrors: { stages: `"${r.name}" has candidates; move them first` } });
    if (r.history > 0) throw conflict('STAGE_HAS_HISTORY', `"${r.name}" appears in candidate history and cannot be removed`,
      { fieldErrors: { stages: `"${r.name}" appears in candidate history and cannot be removed` } });
  }
  // Park every row at a high sequence so removals, renames and renumbering never collide.
  await tx.query(`UPDATE recruitment_stages SET sequence = sequence + 1000 WHERE recruitment_id = $1`, [id]);
  for (const r of removed) await tx.query(`DELETE FROM recruitment_stages WHERE id = $1`, [r.id]);
  // Names are unique per recruitment: rename existing rows to a temporary unique name first so a swap works.
  for (const s of stages) {
    if (s.id !== undefined) await tx.query(`UPDATE recruitment_stages SET name = '~' || id::text WHERE id = $1`, [s.id]);
  }
  for (const [i, s] of stages.entries()) {
    if (s.id !== undefined) {
      await tx.query(`UPDATE recruitment_stages SET name = $2, stage_type = $3, sequence = $4 WHERE id = $1`, [s.id, s.name, s.stageType, i + 1]);
    } else {
      await tx.query(
        `INSERT INTO recruitment_stages (tenant_id, recruitment_id, name, stage_type, sequence) VALUES ($1,$2,$3,$4,$5)`,
        [auth.tenantId, id, s.name, s.stageType, i + 1]);
    }
  }
}

// ------------------------------------------------------------------ status ---

export async function setRecruitmentStatus(tx: Tx, auth: AuthContext, id: number, status: 'open' | 'closed', clientUpdatedAt: string) {
  const lock = await tx.query(`SELECT * FROM recruitments WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound('Recruitment');
  const row = lock.rows[0];
  if (row.status === status) return getRecruitment(tx, id);
  assertFresh(row, clientUpdatedAt);
  await tx.query(
    `UPDATE recruitments SET status = $2::text, closed_at = CASE WHEN $2::text = 'closed' THEN now() ELSE NULL END,
            is_published = CASE WHEN $2::text = 'closed' THEN false ELSE is_published END, updated_by = $3 WHERE id = $1`,
    [id, status, auth.userId]);
  await writeAudit(tx, auth, {
    action: status === 'closed' ? 'closed' : 'reopened', entityType: 'recruitment', entityId: id,
    before: { status: row.status }, after: { status },
  });
  return getRecruitment(tx, id);
}

/** Active employees for manager / interviewer pickers. */
export async function employeeLookup(tx: Tx, q: { search?: string; ids?: string }) {
  const ids = q.ids ? q.ids.split(',').map(Number) : null;
  const r = await tx.query(
    `SELECT e.id, e.full_name, e.employee_code, e.job_title, d.name AS department_name
       FROM employees e LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
      WHERE e.status <> 'exited'
        AND ($1::text IS NULL OR e.full_name ILIKE $1 OR e.employee_code ILIKE $1)
        AND ($2::bigint[] IS NULL OR e.id = ANY($2))
      ORDER BY lower(e.full_name), e.id LIMIT 30`,
    [q.search ? likeTerm(q.search) : null, ids]);
  return r.rows.map((e) => ({
    id: Number(e.id), name: e.full_name as string, code: e.employee_code as string,
    jobTitle: (e.job_title ?? null) as string | null, department: (e.department_name ?? null) as string | null,
  }));
}

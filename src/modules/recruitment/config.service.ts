import type { z } from 'zod';
import type { Tx } from '../../config/db';
import { conflict, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { assertFresh, buildSet, likeTerm, writeAudit, type EntityType } from './recruitment.common';
import type {
  ConfigListQuery, JobPositionCreate, JobPositionPatch, RejectionReasonCreate, RejectionReasonPatch, SettingsBody,
  SurveyTemplateCreate, SurveyTemplatePatch,
} from './recruitment.schemas';

/**
 * Recruitment configuration: job positions, survey templates, rejection reasons
 * and the careers-site settings. Records are activated and deactivated, never
 * deleted (hrms_app has no DELETE on these tables), and every change is audited.
 */

export interface Def {
  table: string;
  entity: EntityType;
  label: string;
  /** Column holding the human name (job positions use "title"). */
  nameCol: string;
  select: string;
  toApi(row: any): Record<string, unknown>;
  /** Open recruitments that still use the record: they block deactivation. */
  inUse?(tx: Tx, id: number): Promise<{ id: number; title: string }[]>;
}

const base = (r: any) => ({
  id: Number(r.id), isActive: r.is_active as boolean, description: (r.description ?? null) as string | null,
  createdAt: r.created_at as Date, updatedAt: r.updated_at as Date,
});

export const jobPositionDef: Def = {
  table: 'rec_job_positions', entity: 'job_position', label: 'Job position', nameCol: 'title',
  select: `SELECT jp.*, d.name AS department_name,
                  (SELECT count(*)::int FROM recruitment_vacancies v JOIN recruitments r ON r.tenant_id = v.tenant_id AND r.id = v.recruitment_id
                    WHERE v.job_position_id = jp.id AND r.status = 'open') AS open_recruitments
             FROM rec_job_positions jp LEFT JOIN departments d ON d.tenant_id = jp.tenant_id AND d.id = jp.department_id`,
  toApi: (r) => ({ ...base(r), title: r.title, name: r.title, departmentId: r.department_id ? Number(r.department_id) : null,
    department: r.department_name ?? null, openRecruitments: r.open_recruitments }),
  async inUse(tx, id) {
    const r = await tx.query(
      `SELECT r.id, r.title FROM recruitment_vacancies v JOIN recruitments r ON r.tenant_id = v.tenant_id AND r.id = v.recruitment_id
        WHERE v.job_position_id = $1 AND r.status = 'open' ORDER BY r.title LIMIT 10`, [id]);
    return r.rows.map((x) => ({ id: Number(x.id), title: x.title }));
  },
};

export const surveyDef: Def = {
  table: 'survey_templates', entity: 'survey_template', label: 'Survey template', nameCol: 'name',
  select: `SELECT * FROM survey_templates`,
  toApi: (r) => ({ ...base(r), name: r.name, questions: r.questions }),
  async inUse(tx, id) {
    const r = await tx.query(`SELECT id, title FROM recruitments WHERE survey_template_id = $1 AND status = 'open' ORDER BY title LIMIT 10`, [id]);
    return r.rows.map((x) => ({ id: Number(x.id), title: x.title }));
  },
};

export const rejectionReasonDef: Def = {
  table: 'rejection_reasons', entity: 'rejection_reason', label: 'Rejection reason', nameCol: 'name',
  select: `SELECT * FROM rejection_reasons`,
  toApi: (r) => ({ ...base(r), name: r.name }),
};

export async function listConfig(tx: Tx, def: Def, q: z.infer<typeof ConfigListQuery>) {
  const r = await tx.query(
    `SELECT t.*, count(*) OVER ()::int AS total_count FROM (${def.select}) t
      WHERE ($1::text IS NULL OR t.${def.nameCol} ILIKE $1 OR t.description ILIKE $1)
        AND ($2::text = 'all' OR t.is_active = ($2 = 'active'))
      ORDER BY lower(t.${def.nameCol}), t.id LIMIT $3 OFFSET $4`,
    [q.search ? likeTerm(q.search) : null, q.status, q.limit, (q.page - 1) * q.limit]);
  return { items: r.rows.map(def.toApi), total: r.rows[0]?.total_count ?? 0, page: q.page, limit: q.limit };
}

export async function getConfig(tx: Tx, def: Def, id: number) {
  const r = await tx.query(`SELECT t.* FROM (${def.select}) t WHERE t.id = $1`, [id]);
  if (!r.rowCount) throw notFound(def.label);
  return def.toApi(r.rows[0]);
}

/** Active records for pickers. */
export async function configOptions(tx: Tx, def: Def) {
  const r = await tx.query(`SELECT t.* FROM (${def.select}) t WHERE t.is_active ORDER BY lower(t.${def.nameCol}), t.id`);
  return r.rows.map(def.toApi);
}

async function create(tx: Tx, auth: AuthContext, def: Def, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  const r = await tx.query(
    `INSERT INTO ${def.table} (tenant_id, ${keys.join(', ')}, created_by, updated_by)
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, $${keys.length + 2}, $${keys.length + 2}) RETURNING id`,
    [auth.tenantId, ...keys.map((k) => cols[k]), auth.userId]);
  const id = Number(r.rows[0].id);
  const rec = await getConfig(tx, def, id);
  await writeAudit(tx, auth, { action: 'created', entityType: def.entity, entityId: id, after: rec });
  return rec;
}

async function patch(tx: Tx, auth: AuthContext, def: Def, id: number, cols: Record<string, unknown>, updatedAt: string) {
  const lock = await tx.query(`SELECT * FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound(def.label);
  assertFresh(lock.rows[0], updatedAt);
  const before = await getConfig(tx, def, id);
  const set = buildSet({ ...cols, updated_by: auth.userId }, 2);
  await tx.query(`UPDATE ${def.table} SET ${set.sql} WHERE id = $1`, [id, ...set.values]);
  const after = await getConfig(tx, def, id);
  await writeAudit(tx, auth, { action: 'updated', entityType: def.entity, entityId: id, before, after });
  return after;
}

export async function setConfigStatus(tx: Tx, auth: AuthContext, def: Def, id: number, b: { isActive: boolean; updatedAt: string }) {
  const lock = await tx.query(`SELECT * FROM ${def.table} WHERE id = $1 FOR UPDATE`, [id]);
  if (!lock.rowCount) throw notFound(def.label);
  const row = lock.rows[0];
  if (row.is_active === b.isActive) return getConfig(tx, def, id);
  assertFresh(row, b.updatedAt);
  if (!b.isActive && def.inUse) {
    const used = await def.inUse(tx, id);
    if (used.length) {
      throw conflict('HAS_ACTIVE_DEPENDENTS', `This ${def.label.toLowerCase()} is used by ${used.length}${used.length >= 10 ? '+' : ''} open recruitment${used.length === 1 ? '' : 's'}. Close or change those first.`,
        { total: used.length, items: used });
    }
  }
  await tx.query(`UPDATE ${def.table} SET is_active = $2, updated_by = $3 WHERE id = $1`, [id, b.isActive, auth.userId]);
  await writeAudit(tx, auth, { action: b.isActive ? 'activated' : 'deactivated', entityType: def.entity, entityId: id });
  return getConfig(tx, def, id);
}

// ----------------------------------------------------------- per resource ---

async function assertDepartment(tx: Tx, id: number | null | undefined) {
  if (id == null) return;
  const r = await tx.query(`SELECT 1 FROM departments WHERE id = $1`, [id]);
  if (!r.rowCount) throw unprocessable('VALIDATION_FAILED', 'Department not found', { fieldErrors: { departmentId: 'Department not found' } });
}

export async function createJobPosition(tx: Tx, auth: AuthContext, b: z.infer<typeof JobPositionCreate>) {
  await assertDepartment(tx, b.departmentId);
  return create(tx, auth, jobPositionDef, { title: b.title, department_id: b.departmentId ?? null, description: b.description ?? null });
}
export async function updateJobPosition(tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof JobPositionPatch>) {
  await assertDepartment(tx, b.departmentId);
  const cols: Record<string, unknown> = {};
  if (b.title !== undefined) cols.title = b.title;
  if (b.departmentId !== undefined) cols.department_id = b.departmentId;
  if (b.description !== undefined) cols.description = b.description;
  return patch(tx, auth, jobPositionDef, id, cols, b.updatedAt);
}

export const createRejectionReason = (tx: Tx, auth: AuthContext, b: z.infer<typeof RejectionReasonCreate>) =>
  create(tx, auth, rejectionReasonDef, { name: b.name, description: b.description ?? null });
export const updateRejectionReason = (tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof RejectionReasonPatch>) => {
  const cols: Record<string, unknown> = {};
  if (b.name !== undefined) cols.name = b.name;
  if (b.description !== undefined) cols.description = b.description;
  return patch(tx, auth, rejectionReasonDef, id, cols, b.updatedAt);
};

/** Question ids are assigned here when missing, and must stay unique within the template. */
function normalizeQuestions(qs: z.infer<typeof SurveyTemplateCreate>['questions']) {
  const used = new Set<string>();
  const out = qs.map((q, i) => {
    let id = q.id ?? `q${i + 1}`;
    while (used.has(id)) id = `${id}_`;
    used.add(id);
    return { id, label: q.label, type: q.type, required: q.required, options: q.type === 'select' ? q.options : [] };
  });
  return JSON.stringify(out);
}
export const createSurveyTemplate = (tx: Tx, auth: AuthContext, b: z.infer<typeof SurveyTemplateCreate>) =>
  create(tx, auth, surveyDef, { name: b.name, description: b.description ?? null, questions: normalizeQuestions(b.questions) });
export const updateSurveyTemplate = (tx: Tx, auth: AuthContext, id: number, b: z.infer<typeof SurveyTemplatePatch>) => {
  const cols: Record<string, unknown> = {};
  if (b.name !== undefined) cols.name = b.name;
  if (b.description !== undefined) cols.description = b.description;
  if (b.questions !== undefined) cols.questions = normalizeQuestions(b.questions);
  return patch(tx, auth, surveyDef, id, cols, b.updatedAt);
};

// ---------------------------------------------------------------- settings ---

const toSettings = (r: any) => ({
  careersEnabled: r?.careers_enabled ?? true,
  careersHeadline: (r?.careers_headline ?? null) as string | null,
  careersIntro: (r?.careers_intro ?? null) as string | null,
  confirmationMessage: (r?.confirmation_message ?? null) as string | null,
  privacyNoticeUrl: (r?.privacy_notice_url ?? null) as string | null,
  updatedAt: (r?.updated_at ?? null) as Date | null,
});

export async function getSettings(tx: Tx) {
  const r = await tx.query(`SELECT * FROM recruitment_settings`);
  return toSettings(r.rows[0]);
}

export async function saveSettings(tx: Tx, auth: AuthContext, b: z.infer<typeof SettingsBody>) {
  const before = await getSettings(tx);
  await tx.query(
    `INSERT INTO recruitment_settings (tenant_id, careers_enabled, careers_headline, careers_intro, confirmation_message, privacy_notice_url, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id) DO UPDATE SET careers_enabled = EXCLUDED.careers_enabled, careers_headline = EXCLUDED.careers_headline,
       careers_intro = EXCLUDED.careers_intro, confirmation_message = EXCLUDED.confirmation_message,
       privacy_notice_url = EXCLUDED.privacy_notice_url, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [auth.tenantId, b.careersEnabled, b.careersHeadline ?? null, b.careersIntro ?? null, b.confirmationMessage ?? null, b.privacyNoticeUrl ?? null, auth.userId]);
  const after = await getSettings(tx);
  await writeAudit(tx, auth, { action: 'updated', entityType: 'settings', entityId: auth.tenantId, before, after });
  return after;
}

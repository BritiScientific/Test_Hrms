import type { Tx } from '../../config/db';
import { AppError, conflict, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { MAX_LOGO_BYTES, assetStorage, sniffImageType, type StoredAsset } from './asset-storage';
import {
  COUNTRY_SET, CURRENCY_SET, LOCALE_CODES, TIMEZONE_SET, postalCodeError,
} from './organization.reference';

/**
 * Organization profile, preferences, branding and onboarding status for the
 * CURRENT tenant. The tenant is never a parameter: every query runs inside
 * withTenantTx and RLS (tenant_self / tenant_isolation) limits it to the
 * caller's own organization. Every write is audited in the same transaction.
 */

// ------------------------------------------------------------- shapes -----

export interface ProfilePatch {
  displayName?: string;
  legalName?: string | null;
  industry?: string | null;
  website?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  contactPerson?: string | null;
  registrationNumber?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    stateProvince?: string | null;
    postalCode?: string | null;
    countryCode?: string | null;
  };
  version?: number;
}

export interface SettingsPatch {
  timezone?: string;
  weeklyOffs?: number[];
  locale?: string;
  dateFormat?: string;
  currency?: string;
  financialYearStartMonth?: number;
  weekStartDay?: number;
  version?: number;
}

/** API field -> tenants column. */
const PROFILE_FIELDS: Record<string, string> = {
  displayName: 'name',
  legalName: 'legal_name',
  industry: 'industry',
  website: 'website',
  contactEmail: 'contact_email',
  contactPhone: 'contact_phone',
  contactPerson: 'contact_person',
  registrationNumber: 'registration_number',
};
const ADDRESS_FIELDS: Record<string, string> = {
  line1: 'address_line1',
  line2: 'address_line2',
  city: 'city',
  stateProvince: 'state_province',
  postalCode: 'postal_code',
  countryCode: 'country_code',
};

const TENANT_COLUMNS = `id, name, legal_name, slug, industry, website, contact_email, contact_phone,
  contact_person, registration_number, address_line1, address_line2, city, state_province,
  postal_code, country_code, is_active, onboarding_completed_at, created_at, updated_at, version`;

const logoUrl = (a: StoredAsset | null) => (a ? `/api/v1/organization/logo?v=${a.sha256.slice(0, 12)}` : null);

const statusOf = (row: any) => (!row.is_active ? 'inactive' : row.onboarding_completed_at ? 'active' : 'onboarding');

function toProfile(row: any, logo: StoredAsset | null) {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.name,
    legalName: row.legal_name,
    industry: row.industry,
    website: row.website,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    contactPerson: row.contact_person,
    registrationNumber: row.registration_number,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      stateProvince: row.state_province,
      postalCode: row.postal_code,
      countryCode: row.country_code ? String(row.country_code).trim() : null,
    },
    status: statusOf(row),
    onboardingCompletedAt: row.onboarding_completed_at,
    logo: logo ? { url: logoUrl(logo), contentType: logo.contentType, byteSize: logo.byteSize, updatedAt: logo.updatedAt } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

async function loadTenantRow(tx: Tx, lock = false) {
  const r = await tx.query(
    `SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = current_tenant_id()${lock ? ' FOR UPDATE' : ''}`,
  );
  if (!r.rowCount) throw notFound('Organization');
  return r.rows[0];
}

// ------------------------------------------------------------ profile -----

/** Identity block for /me and the shell (every member may see it). */
export async function getTenantSummary(tx: Tx) {
  const row = await loadTenantRow(tx);
  const logo = await assetStorage.head(tx, 'logo');
  const s = await getSettings(tx);
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.name,
    legalName: row.legal_name,
    logoUrl: logoUrl(logo),
    status: statusOf(row),
    onboardingCompleted: !!row.onboarding_completed_at,
    // Display preferences every member's UI needs (not sensitive; editing needs organization.settings.*).
    preferences: { timezone: s.timezone, locale: s.locale, dateFormat: s.dateFormat, currency: s.currency },
  };
}

export async function getProfile(tx: Tx) {
  const row = await loadTenantRow(tx);
  return toProfile(row, await assetStorage.head(tx, 'logo'));
}

export async function updateProfile(tx: Tx, actor: AuthContext, patch: ProfilePatch) {
  const before = await loadTenantRow(tx, true);
  if (patch.version !== undefined && patch.version !== before.version) {
    throw conflict('VERSION_CONFLICT', 'The organization profile was changed by someone else. Reload and try again.', {
      currentVersion: before.version,
    });
  }

  const sets: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(PROFILE_FIELDS)) {
    const v = (patch as any)[field];
    if (v !== undefined) sets[column] = v;
  }
  for (const [field, column] of Object.entries(ADDRESS_FIELDS)) {
    const v = (patch.address as any)?.[field];
    if (v !== undefined) sets[column] = v;
  }

  // Cross-field validation on the merged result.
  const country = (sets.country_code !== undefined ? sets.country_code : before.country_code?.trim() ?? null) as string | null;
  const postal = (sets.postal_code !== undefined ? sets.postal_code : before.postal_code) as string | null;
  const fieldErrors: Record<string, string> = {};
  if (country && !COUNTRY_SET.has(country)) fieldErrors['address.countryCode'] = 'Unknown country code';
  if (postal && (sets.postal_code !== undefined || sets.country_code !== undefined)) {
    const e = postalCodeError(country, postal);
    if (e) fieldErrors['address.postalCode'] = e;
  }
  if (Object.keys(fieldErrors).length) {
    throw unprocessable('VALIDATION_FAILED', 'Invalid organization profile', { fieldErrors });
  }

  const changed = Object.keys(sets).filter((c) => !sameValue(before[c], sets[c]));
  if (!changed.length) return toProfile(before, await assetStorage.head(tx, 'logo'));

  const cols = changed.map((c, i) => `${c} = $${i + 1}`);
  const r = await tx.query(
    `UPDATE tenants SET ${cols.join(', ')}, version = version + 1
      WHERE id = current_tenant_id() RETURNING ${TENANT_COLUMNS}`,
    changed.map((c) => sets[c]),
  );
  const after = r.rows[0];
  await orgAudit(tx, actor, 'organization.update', 'organization', actor.tenantId,
    pick(before, changed), pick(after, changed));
  return toProfile(after, await assetStorage.head(tx, 'logo'));
}

// ----------------------------------------------------------- settings -----

const SETTINGS_SQL = `
  SELECT t.timezone, t.weekly_offs,
         COALESCE(s.locale, 'en-IN') AS locale,
         COALESCE(s.date_format, 'DD/MM/YYYY') AS date_format,
         COALESCE(s.currency, 'INR') AS currency,
         COALESCE(s.financial_year_start_month, 4) AS financial_year_start_month,
         COALESCE(s.week_start_day, 1) AS week_start_day,
         s.confirmed_at, COALESCE(s.version, 0) AS version, s.updated_at
    FROM tenants t
    LEFT JOIN tenant_settings s ON s.tenant_id = t.id
   WHERE t.id = current_tenant_id()`;

function toSettings(r: any) {
  return {
    timezone: r.timezone,
    weeklyOffs: [...r.weekly_offs].map(Number).sort(),
    locale: r.locale,
    dateFormat: r.date_format,
    currency: String(r.currency).trim(),
    financialYearStartMonth: r.financial_year_start_month,
    weekStartDay: r.week_start_day,
    confirmedAt: r.confirmed_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

export async function getSettings(tx: Tx) {
  const r = await tx.query(SETTINGS_SQL);
  if (!r.rowCount) throw notFound('Organization');
  return toSettings(r.rows[0]);
}

export async function updateSettings(tx: Tx, actor: AuthContext, patch: SettingsPatch) {
  await tx.query(`SELECT 1 FROM tenants WHERE id = current_tenant_id() FOR UPDATE`);
  const before = await getSettings(tx);
  if (patch.version !== undefined && patch.version !== before.version) {
    throw conflict('VERSION_CONFLICT', 'Preferences were changed by someone else. Reload and try again.', {
      currentVersion: before.version,
    });
  }

  const fieldErrors: Record<string, string> = {};
  if (patch.timezone !== undefined) {
    const known = await tx.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [patch.timezone]);
    if (!TIMEZONE_SET.has(patch.timezone) || !known.rowCount) fieldErrors.timezone = 'Unknown IANA timezone';
  }
  if (patch.locale !== undefined && !LOCALE_CODES.has(patch.locale)) fieldErrors.locale = 'Unsupported locale';
  if (patch.currency !== undefined && !CURRENCY_SET.has(patch.currency)) fieldErrors.currency = 'Unknown currency code';
  if (patch.weeklyOffs !== undefined) {
    const offs = new Set(patch.weeklyOffs);
    if (offs.size !== patch.weeklyOffs.length) fieldErrors.weeklyOffs = 'Duplicate days';
    else if (offs.size > 6) fieldErrors.weeklyOffs = 'At least one working day is required';
  }
  if (Object.keys(fieldErrors).length) {
    throw unprocessable('VALIDATION_FAILED', 'Invalid organization preferences', { fieldErrors });
  }

  if (patch.timezone !== undefined || patch.weeklyOffs !== undefined) {
    await tx.query(
      `UPDATE tenants SET timezone = COALESCE($1, timezone), weekly_offs = COALESCE($2::smallint[], weekly_offs)
        WHERE id = current_tenant_id()`,
      [patch.timezone ?? null, patch.weeklyOffs ? [...patch.weeklyOffs].sort() : null],
    );
  }
  await tx.query(
    `INSERT INTO tenant_settings AS s (tenant_id, locale, date_format, currency, financial_year_start_month,
                                       week_start_day, confirmed_at, updated_by)
     VALUES (current_tenant_id(), COALESCE($1, 'en-IN'), COALESCE($2, 'DD/MM/YYYY'), COALESCE($3, 'INR'),
             COALESCE($4, 4), COALESCE($5, 1), now(), $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       locale = COALESCE($1, s.locale),
       date_format = COALESCE($2, s.date_format),
       currency = COALESCE($3, s.currency),
       financial_year_start_month = COALESCE($4, s.financial_year_start_month),
       week_start_day = COALESCE($5, s.week_start_day),
       confirmed_at = COALESCE(s.confirmed_at, now()),
       updated_by = $6,
       version = s.version + 1`,
    [patch.locale ?? null, patch.dateFormat ?? null, patch.currency ?? null,
     patch.financialYearStartMonth ?? null, patch.weekStartDay ?? null, actor.userId],
  );
  const after = await getSettings(tx);
  const keys = ['timezone', 'weeklyOffs', 'locale', 'dateFormat', 'currency', 'financialYearStartMonth', 'weekStartDay'] as const;
  const changed = keys.filter((k) => !sameValue(before[k], after[k]));
  await orgAudit(tx, actor, 'organization.settings.update', 'organization_settings', actor.tenantId,
    pick(before, changed), pick(after, changed));
  return after;
}

// --------------------------------------------------------------- logo -----

export async function getLogo(tx: Tx) {
  const logo = await assetStorage.get(tx, 'logo');
  if (!logo) throw notFound('Logo');
  return logo;
}

export async function uploadLogo(tx: Tx, actor: AuthContext, declaredType: string | undefined, data: unknown) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new AppError(400, 'EMPTY_UPLOAD', 'Send the image bytes as the request body with an image Content-Type');
  }
  if (data.length > MAX_LOGO_BYTES) throw new AppError(413, 'FILE_TOO_LARGE', 'Logo must be 512 KB or smaller');
  const detected = sniffImageType(data);
  const declared = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  if (!detected) throw unprocessable('UNSUPPORTED_IMAGE', 'Logo must be a PNG, JPEG or WebP image');
  if (declared !== detected) {
    throw unprocessable('CONTENT_TYPE_MISMATCH', `File content is ${detected} but was sent as ${declared || 'unknown'}`);
  }
  const before = await assetStorage.head(tx, 'logo');
  const after = await assetStorage.put(tx, actor.tenantId, 'logo', detected, data, actor.userId);
  await orgAudit(tx, actor, 'organization.logo.update', 'organization', actor.tenantId,
    before ? { sha256: before.sha256, byteSize: before.byteSize, contentType: before.contentType } : null,
    { sha256: after.sha256, byteSize: after.byteSize, contentType: after.contentType });
  return { url: logoUrl(after), contentType: after.contentType, byteSize: after.byteSize, updatedAt: after.updatedAt };
}

export async function removeLogo(tx: Tx, actor: AuthContext) {
  const before = await assetStorage.head(tx, 'logo');
  if (!before) throw notFound('Logo');
  await assetStorage.remove(tx, 'logo');
  await orgAudit(tx, actor, 'organization.logo.remove', 'organization', actor.tenantId,
    { sha256: before.sha256, byteSize: before.byteSize, contentType: before.contentType }, { removed: true });
}

// --------------------------------------------------------- onboarding -----

export async function getOnboardingStatus(tx: Tx) {
  const row = await loadTenantRow(tx);
  const settings = await getSettings(tx);
  const logo = await assetStorage.head(tx, 'logo');
  const steps = [
    { key: 'profile', label: 'Organization details', description: 'Legal and display name', done: !!row.legal_name && !!row.name, optional: false },
    { key: 'contact', label: 'Contact details', description: 'Email or phone for HR queries', done: !!row.contact_email || !!row.contact_phone, optional: false },
    { key: 'address', label: 'Registered address', description: 'City and country', done: !!row.city && !!row.country_code, optional: false },
    { key: 'preferences', label: 'Regional preferences', description: 'Timezone, currency, financial year', done: !!settings.confirmedAt, optional: false },
    { key: 'branding', label: 'Logo', description: 'Shown in the portal header', done: !!logo, optional: true },
  ];
  const required = steps.filter((s) => !s.optional);
  return {
    completed: !!row.onboarding_completed_at,
    completedAt: row.onboarding_completed_at,
    canComplete: required.every((s) => s.done),
    progress: { done: steps.filter((s) => s.done).length, total: steps.length },
    steps,
  };
}

export async function completeOnboarding(tx: Tx, actor: AuthContext) {
  await loadTenantRow(tx, true);
  const status = await getOnboardingStatus(tx);
  if (status.completed) return status;
  if (!status.canComplete) {
    throw unprocessable('ONBOARDING_INCOMPLETE', 'Complete the required steps first', {
      missing: status.steps.filter((s) => !s.optional && !s.done).map((s) => s.key),
    });
  }
  await tx.query(`UPDATE tenants SET onboarding_completed_at = now() WHERE id = current_tenant_id()`);
  await orgAudit(tx, actor, 'organization.onboarding.complete', 'organization', actor.tenantId, null, { completed: true });
  return getOnboardingStatus(tx);
}

// -------------------------------------------------------------- audit -----

export async function orgAudit(
  tx: Tx,
  actor: AuthContext,
  action: string,
  targetType: string,
  targetId: number | null,
  before: unknown,
  after: unknown,
) {
  await tx.query(
    `INSERT INTO organization_audit_log (tenant_id, actor_user_id, action, target_type, target_id,
                                         before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.tenantId, actor.userId, action, targetType, targetId,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after),
     actor.requestId ?? null],
  );
}

function pick(obj: any, keys: readonly string[]) {
  return Object.fromEntries(keys.map((k) => [k, obj[k] ?? null]));
}

function sameValue(a: unknown, b: unknown) {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : v ?? null);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

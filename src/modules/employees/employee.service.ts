import type { Tx } from '../../config/db';
import { env } from '../../config/env';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';
import type { AuthContext } from '../../shared/types';
import { hashInvitationToken, newInvitationToken } from '../onboarding/provisioning';
import { COUNTRY_SET, postalCodeError } from '../organization/organization.reference';
import { enqueueEvent } from '../outbox/outbox';
import { assertNoLockout, assignRole } from '../rbac/rbac.service';

/**
 * Employee creation, approach "A + D":
 *
 *  A — Quick add (HR). ONE transaction creates or links the login identity,
 *      the tenant membership (status 'invited'), the employee record, the
 *      reporting line, role assignments and a one-time activation link. Any
 *      failure rolls all of it back, so there are never half-created people.
 *      Only full name, work email and joining date are mandatory.
 *  D — Self-service. After activating, the employee fills their own personal,
 *      address and emergency-contact details (SELF fields). HR can fill or
 *      correct any field, including those.
 *
 * The tenant is never a parameter: everything runs inside withTenantTx/RLS.
 */

export const INVITE_TTL_HOURS = 7 * 24;

// API field -> employees column -------------------------------------------
const HR_FIELDS: Record<string, string> = {
  fullName: 'full_name',
  employeeCode: 'employee_code',
  departmentId: 'department_id',
  jobTitle: 'job_title',
  employmentType: 'employment_type',
  workLocation: 'work_location',
  dateOfJoining: 'date_of_joining',
  status: 'status',
};
const SELF_FIELDS: Record<string, string> = {
  preferredName: 'preferred_name',
  dateOfBirth: 'date_of_birth',
  gender: 'gender',
  personalEmail: 'personal_email',
  mobilePhone: 'mobile_phone',
};
const ADDRESS_FIELDS: Record<string, string> = {
  line1: 'address_line1',
  line2: 'address_line2',
  city: 'city',
  stateProvince: 'state_province',
  postalCode: 'postal_code',
  countryCode: 'country_code',
};
const EMERGENCY_FIELDS: Record<string, string> = {
  name: 'emergency_contact_name',
  relation: 'emergency_contact_relation',
  phone: 'emergency_contact_phone',
};

/** Self-service items that make a profile "complete". */
const REQUIRED_SELF: { key: string; column: string; label: string }[] = [
  { key: 'dateOfBirth', column: 'date_of_birth', label: 'Date of birth' },
  { key: 'mobilePhone', column: 'mobile_phone', label: 'Mobile phone' },
  { key: 'address.city', column: 'city', label: 'City' },
  { key: 'address.countryCode', column: 'country_code', label: 'Country' },
  { key: 'emergencyContact.name', column: 'emergency_contact_name', label: 'Emergency contact name' },
  { key: 'emergencyContact.phone', column: 'emergency_contact_phone', label: 'Emergency contact phone' },
];

export interface QuickAddInput {
  fullName: string;
  workEmail: string;
  dateOfJoining: string;
  employeeCode?: string | null;
  departmentId?: number | null;
  managerId?: number | null;
  jobTitle?: string | null;
  employmentType?: string;
  employeeTypeId?: number;
  roleIds?: number[];
  sendInvite?: boolean;
}

export interface EmployeePatch {
  [key: string]: unknown;
  address?: Record<string, unknown>;
  emergencyContact?: Record<string, unknown>;
  managerId?: number | null;
  version?: number;
}

// ------------------------------------------------------------- reading ----

const BASE = `
  SELECT e.*, d.name AS department_name, u.email AS work_email, tu.status AS membership_status,
         et.name AS employee_type_name, et.is_active AS employee_type_active,
         m.id AS manager_id, m.full_name AS manager_name, m.job_title AS manager_title,
         inv.expires_at AS invite_expires_at, inv.created_at AS invited_at,
         CASE WHEN e.user_id IS NULL THEN 'no_login'
              WHEN tu.status = 'active' THEN 'active'
              WHEN tu.status = 'invited' AND inv.expires_at > now() THEN 'invited'
              WHEN tu.status = 'invited' THEN 'invite_expired'
              ELSE tu.status END AS access_status
    FROM employees e
    LEFT JOIN departments d  ON d.tenant_id = e.tenant_id AND d.id = e.department_id
    LEFT JOIN employee_types et ON et.tenant_id = e.tenant_id AND et.id = e.employee_type_id
    LEFT JOIN users u        ON u.id = e.user_id
    LEFT JOIN tenant_users tu ON tu.tenant_id = e.tenant_id AND tu.user_id = e.user_id
    LEFT JOIN LATERAL (
      SELECT er.manager_id FROM employee_reporting er
       WHERE er.tenant_id = e.tenant_id AND er.employee_id = e.id
         AND (er.effective_to IS NULL OR er.effective_to >= tenant_today())
       ORDER BY er.effective_from LIMIT 1) cur ON true
    LEFT JOIN employees m ON m.tenant_id = e.tenant_id AND m.id = cur.manager_id
    LEFT JOIN LATERAL (
      SELECT i.expires_at, i.created_at FROM organization_invitations i
       WHERE i.tenant_id = e.tenant_id AND i.employee_id = e.id
         AND i.revoked_at IS NULL AND i.accepted_at IS NULL
       ORDER BY i.created_at DESC LIMIT 1) inv ON true`;

const val = (v: unknown) => (typeof v === 'string' ? v.trim() : v);

function profileOf(row: any) {
  const missing = REQUIRED_SELF.filter((f) => row[f.column] == null || String(row[f.column]).trim() === '');
  return {
    completed: missing.length === 0,
    completedAt: row.profile_completed_at,
    done: REQUIRED_SELF.length - missing.length,
    total: REQUIRED_SELF.length,
    missing: missing.map((f) => ({ key: f.key, label: f.label })),
  };
}

export function toEmployee(row: any) {
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    preferredName: row.preferred_name,
    workEmail: row.work_email,
    jobTitle: row.job_title,
    employmentType: row.employment_type,
    // Null only for a row the migration backfill could not match; the UI then shows employmentType.
    employeeTypeId: row.employee_type_id == null ? null : Number(row.employee_type_id),
    employeeTypeName: (row.employee_type_name ?? null) as string | null,
    // An inactive type stays readable on existing employees, but is never offered for new ones.
    employeeTypeActive: (row.employee_type_active ?? null) as boolean | null,
    workLocation: row.work_location,
    dateOfJoining: row.date_of_joining,
    status: row.status,
    department: row.department_id ? { id: row.department_id, name: row.department_name } : null,
    manager: row.manager_id ? { id: row.manager_id, name: row.manager_name, jobTitle: row.manager_title } : null,
    userId: row.user_id,
    access: {
      status: row.access_status as 'active' | 'invited' | 'invite_expired' | 'no_login' | 'suspended' | 'left',
      invitedAt: row.invited_at ?? null,
      inviteExpiresAt: row.invite_expires_at ?? null,
    },
    dateOfBirth: row.date_of_birth,
    gender: row.gender,
    personalEmail: row.personal_email,
    mobilePhone: row.mobile_phone,
    address: {
      line1: row.address_line1,
      line2: row.address_line2,
      city: row.city,
      stateProvince: row.state_province,
      postalCode: row.postal_code,
      countryCode: row.country_code ? String(row.country_code).trim() : null,
    },
    emergencyContact: {
      name: row.emergency_contact_name,
      relation: row.emergency_contact_relation,
      phone: row.emergency_contact_phone,
    },
    profile: profileOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
export type Employee = ReturnType<typeof toEmployee>;

export async function getEmployee(tx: Tx, id: number): Promise<Employee> {
  const r = await tx.query(`${BASE} WHERE e.id = $1`, [id]);
  if (!r.rowCount) throw notFound('Employee');
  return toEmployee(r.rows[0]);
}

export async function listEmployees(tx: Tx, q: {
  search?: string; departmentId?: number; access?: string; status?: 'current' | 'exited' | 'all'; limit?: number; offset?: number;
}) {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const search = q.search?.trim() ? `%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const r = await tx.query(
    `WITH x AS (${BASE})
     SELECT x.*, count(*) OVER ()::int AS total FROM x
      WHERE ($1::text IS NULL OR x.full_name ILIKE $1 OR x.employee_code ILIKE $1 OR x.work_email ILIKE $1
             OR x.job_title ILIKE $1 OR x.preferred_name ILIKE $1)
        AND ($2::bigint IS NULL OR x.department_id = $2)
        AND ($3::text IS NULL OR x.access_status = $3)
        AND (CASE $4::text WHEN 'all' THEN true WHEN 'exited' THEN x.status = 'exited' ELSE x.status <> 'exited' END)
      ORDER BY lower(x.full_name), x.id
      LIMIT $5 OFFSET $6`,
    [search, q.departmentId ?? null, q.access ?? null, q.status ?? 'current', limit, offset],
  );
  return { items: r.rows.map(toEmployee), total: r.rows[0]?.total ?? 0, limit, offset };
}

/** Next code following the tenant's own convention (e.g. E502 -> E503); EMP001 for the first employee. */
export async function nextEmployeeCode(tx: Tx): Promise<string> {
  const latest = await tx.query(`SELECT employee_code FROM employees ORDER BY created_at DESC, id DESC LIMIT 1`);
  const m = /^(.*?)(\d+)$/.exec(latest.rows[0]?.employee_code ?? '');
  const prefix = m ? m[1] : 'EMP';
  const width = m ? m[2].length : 3;
  const all = await tx.query(`SELECT employee_code FROM employees WHERE employee_code LIKE $1`, [`${prefix}%`]);
  let max = 0;
  for (const row of all.rows) {
    const mm = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`).exec(row.employee_code);
    if (mm) max = Math.max(max, Number(mm[1]));
  }
  return `${prefix}${String(max + 1).padStart(width, '0')}`;
}

// -------------------------------------------------------------- quick add --

export async function quickAddEmployee(tx: Tx, actor: AuthContext, input: QuickAddInput) {
  // Serialise employee creation per tenant (code generation + duplicate checks).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('employees'), $1::int)`, [actor.tenantId]);

  const fieldErrors: Record<string, string> = {};
  if (input.departmentId) {
    const d = await tx.query(`SELECT 1 FROM departments WHERE id = $1 AND is_active`, [input.departmentId]);
    if (!d.rowCount) fieldErrors.departmentId = 'Unknown department';
  }
  if (input.managerId) {
    const m = await tx.query(`SELECT 1 FROM employees WHERE id = $1 AND status <> 'exited'`, [input.managerId]);
    if (!m.rowCount) fieldErrors.managerId = 'Unknown manager';
  }
  const code = input.employeeCode?.trim() || (await nextEmployeeCode(tx));
  const dupCode = await tx.query(`SELECT 1 FROM employees WHERE employee_code = $1`, [code]);
  if (dupCode.rowCount) fieldErrors.employeeCode = 'This employee code is already used';

  // Employee type: the chosen one (must be active), or for an older client that
  // only sends employmentType, the default type for that category.
  let employmentType = input.employmentType ?? 'full_time';
  let employeeTypeId: number | null = null;
  if (input.employeeTypeId) {
    const t = await lockEmployeeType(tx, input.employeeTypeId);
    if (!t?.is_active) fieldErrors.employeeTypeId = 'Choose an active employee type';
    else { employeeTypeId = Number(t.id); employmentType = t.base_category; }
  } else {
    const t = await defaultEmployeeType(tx, employmentType);
    employeeTypeId = t ? Number(t.id) : null;
  }
  const roleIds = [...new Set(input.roleIds ?? [])];
  if (roleIds.length && !actor.permissions.has('roles.assign')) {
    throw forbidden('MISSING_PERMISSION', 'Assigning roles needs the roles.assign permission');
  }
  if (Object.keys(fieldErrors).length) throw unprocessable('VALIDATION_FAILED', 'Invalid employee', { fieldErrors });

  // 1. Login identity: new passwordless account, or the existing one for this email.
  const u = await tx.query(`SELECT * FROM employee_ensure_user($1, $2)`, [input.workEmail.trim(), input.fullName.trim()]);
  const userId = Number(u.rows[0].out_user_id);
  if (!u.rows[0].out_is_active) {
    throw unprocessable('VALIDATION_FAILED', 'Invalid employee', { fieldErrors: { workEmail: 'This account is disabled' } });
  }

  // 2. Membership. Someone already in the organization keeps their access; their
  //    employee record is simply linked. Everyone else starts as 'invited'.
  const mem = await tx.query(`SELECT status FROM tenant_users WHERE user_id = $1`, [userId]);
  let membership: string = mem.rows[0]?.status ?? 'invited';
  if (mem.rowCount) {
    const linked = await tx.query(`SELECT id FROM employees WHERE user_id = $1`, [userId]);
    if (linked.rowCount) {
      throw conflict('EMPLOYEE_EXISTS', 'This person already has an employee record', { employeeId: linked.rows[0].id });
    }
    if (membership === 'left' || membership === 'suspended') {
      await tx.query(`UPDATE tenant_users SET status = 'invited' WHERE user_id = $1`, [userId]);
      membership = 'invited';
    }
  } else {
    await tx.query(`INSERT INTO tenant_users (tenant_id, user_id, status) VALUES ($1, $2, 'invited')`, [actor.tenantId, userId]);
  }

  // 3. Employee record.
  const e = await tx.query(
    `INSERT INTO employees (tenant_id, user_id, employee_code, full_name, department_id, date_of_joining,
                            job_title, employment_type, employee_type_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [actor.tenantId, userId, code, input.fullName.trim(), input.departmentId ?? null, input.dateOfJoining,
     input.jobTitle?.trim() || null, employmentType, employeeTypeId, actor.userId],
  );
  const employeeId = Number(e.rows[0].id);

  // 4. Reporting line from the joining date.
  if (input.managerId) {
    await tx.query(
      `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [actor.tenantId, employeeId, input.managerId, input.dateOfJoining, actor.userId],
    );
  }

  // 5. Roles (same anti-escalation rules and audit as the RBAC screens).
  for (const roleId of roleIds) await assignRole(tx, actor, { userId, roleId });

  // 6. Activation link (only for people who cannot sign in to this organization yet).
  let invitation: { url: string; expiresAt: Date } | null = null;
  if (membership === 'invited' && input.sendInvite !== false) {
    invitation = await issueInvitation(tx, actor, employeeId, input.workEmail.trim(), input.fullName.trim());
  }

  const created = await getEmployee(tx, employeeId);
  await employeeAudit(tx, actor, 'employee.create', employeeId, null, {
    employeeCode: code, fullName: created.fullName, workEmail: created.workEmail, dateOfJoining: created.dateOfJoining,
    departmentId: input.departmentId ?? null, managerId: input.managerId ?? null, roleIds,
    employeeTypeId, employeeType: created.employeeTypeName, employmentType,
    linkedExistingMember: membership === 'active',
  });
  await enqueueEvent(tx, actor.tenantId, 'employee.created', 'employee', employeeId, {
    employeeId, invited: !!invitation, requestId: actor.requestId ?? null,
  });
  return { employee: created, invitation, linkedExistingMember: membership === 'active' };
}

/** Revoke unused links for this employee and issue a fresh one (shown once to HR). */
async function issueInvitation(tx: Tx, actor: AuthContext, employeeId: number, email: string, fullName: string) {
  await tx.query(
    `UPDATE organization_invitations SET revoked_at = now()
      WHERE employee_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [employeeId],
  );
  const token = newInvitationToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600_000);
  const i = await tx.query(
    `INSERT INTO organization_invitations (tenant_id, email, full_name, kind, employee_id, token_hash, expires_at, invited_by)
     VALUES ($1, $2, $3, 'employee', $4, $5, $6, $7) RETURNING id`,
    [actor.tenantId, email, fullName, employeeId, hashInvitationToken(token), expiresAt, actor.userId],
  );
  await employeeAudit(tx, actor, 'employee.invite', employeeId, null, { invitationId: i.rows[0].id, expiresAt });
  return { url: `${env.APP_BASE_URL.replace(/\/$/, '')}/activate?token=${token}`, expiresAt };
}

export async function reissueInvitation(tx: Tx, actor: AuthContext, employeeId: number) {
  const emp = await getEmployee(tx, employeeId);
  if (emp.status === 'exited') throw conflict('EMPLOYEE_EXITED', 'This employee has left the organization');
  if (!emp.userId || !['invited', 'invite_expired'].includes(emp.access.status)) {
    throw conflict('ALREADY_ACTIVE', 'This employee can already sign in');
  }
  return issueInvitation(tx, actor, employeeId, emp.workEmail, emp.fullName);
}

// ---------------------------------------------------------------- update --

/**
 * mode 'hr': every field (employee.update). mode 'self': SELF fields of the
 * caller's own record only — the route schema rejects anything else.
 */
export async function updateEmployee(tx: Tx, actor: AuthContext, employeeId: number, patch: EmployeePatch, mode: 'hr' | 'self') {
  const cur = await tx.query(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [employeeId]);
  if (!cur.rowCount) throw notFound('Employee');
  const row = cur.rows[0];
  if (patch.version !== undefined && patch.version !== row.version) {
    throw conflict('VERSION_CONFLICT', 'This profile was changed by someone else. Reload and try again.', { currentVersion: row.version });
  }

  const sets: Record<string, unknown> = {};
  const take = (map: Record<string, string>, src: Record<string, unknown> | undefined) => {
    for (const [field, column] of Object.entries(map)) if (src && src[field] !== undefined) sets[column] = val(src[field]);
  };
  take(SELF_FIELDS, patch);
  take(ADDRESS_FIELDS, patch.address);
  take(EMERGENCY_FIELDS, patch.emergencyContact);
  if (mode === 'hr') take(HR_FIELDS, patch);

  const fieldErrors: Record<string, string> = {};
  const merged = { ...row, ...sets };
  const country = merged.country_code ? String(merged.country_code).trim() : null;
  if (country && !COUNTRY_SET.has(country)) fieldErrors['address.countryCode'] = 'Unknown country code';
  if (merged.postal_code && (sets.postal_code !== undefined || sets.country_code !== undefined)) {
    const err = postalCodeError(country, String(merged.postal_code));
    if (err) fieldErrors['address.postalCode'] = err;
  }
  if (sets.date_of_birth) {
    const dob = new Date(String(sets.date_of_birth));
    const age = (Date.now() - dob.getTime()) / (365.25 * 86400_000);
    if (age < 14) fieldErrors.dateOfBirth = 'Date of birth looks incorrect (must be at least 14 years ago)';
  }
  if (sets.department_id) {
    const d = await tx.query(`SELECT 1 FROM departments WHERE id = $1`, [sets.department_id]);
    if (!d.rowCount) fieldErrors.departmentId = 'Unknown department';
  }
  if (sets.employee_code && sets.employee_code !== row.employee_code) {
    const dup = await tx.query(`SELECT 1 FROM employees WHERE employee_code = $1 AND id <> $2`, [sets.employee_code, employeeId]);
    if (dup.rowCount) fieldErrors.employeeCode = 'This employee code is already used';
  }
  // Employee type (HR only). employment_type always follows the type's base
  // category, in the same UPDATE. Keeping an already-saved inactive type is
  // allowed; switching TO an inactive type is not.
  if (mode === 'hr' && patch.employeeTypeId !== undefined) {
    const requested = Number(patch.employeeTypeId);
    const current = row.employee_type_id == null ? null : Number(row.employee_type_id);
    const t = await lockEmployeeType(tx, requested);
    if (!t || (requested !== current && !t.is_active)) fieldErrors.employeeTypeId = 'Choose an active employee type';
    else {
      sets.employee_type_id = Number(t.id);
      sets.employment_type = t.base_category;
    }
  } else if (mode === 'hr' && sets.employment_type !== undefined && sets.employment_type !== row.employment_type) {
    // Older client that only knows employmentType: keep the current type if it
    // already has that category, otherwise move to the default for it.
    const cur = row.employee_type_id == null ? null : await lockEmployeeType(tx, Number(row.employee_type_id));
    if (cur?.base_category !== sets.employment_type) {
      const t = await defaultEmployeeType(tx, String(sets.employment_type));
      sets.employee_type_id = t ? Number(t.id) : null;
    }
  }
  if (mode === 'hr' && patch.managerId) {
    if (patch.managerId === employeeId) fieldErrors.managerId = 'An employee cannot report to themselves';
    else {
      const m = await tx.query(`SELECT 1 FROM employees WHERE id = $1 AND status <> 'exited'`, [patch.managerId]);
      if (!m.rowCount) fieldErrors.managerId = 'Unknown manager';
    }
  }
  if (Object.keys(fieldErrors).length) throw unprocessable('VALIDATION_FAILED', 'Invalid employee', { fieldErrors });

  const before = await getEmployee(tx, employeeId);
  const changed = Object.keys(sets).filter((c) => JSON.stringify(normalize(row[c])) !== JSON.stringify(normalize(sets[c])));
  if (changed.length) {
    await tx.query(
      `UPDATE employees SET ${changed.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1`,
      [employeeId, ...changed.map((c) => (sets[c] === '' ? null : sets[c]))],
    );
  }
  let managerChanged = false;
  if (mode === 'hr' && patch.managerId !== undefined) managerChanged = await setManager(tx, actor, employeeId, patch.managerId);

  // Leaving the organization ends access; returning restores it.
  if (mode === 'hr' && changed.includes('status') && row.user_id) {
    if (sets.status === 'exited') {
      await tx.query(`UPDATE tenant_users SET status = 'left' WHERE user_id = $1 AND status IN ('active', 'invited')`, [row.user_id]);
      await tx.query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'admin' WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      await tx.query(`UPDATE organization_invitations SET revoked_at = now() WHERE employee_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [employeeId]);
      await assertNoLockout(tx);
    } else if (row.status === 'exited') {
      const accepted = await tx.query(`SELECT 1 FROM users WHERE id = $1 AND password_hash IS NOT NULL`, [row.user_id]);
      await tx.query(`UPDATE tenant_users SET status = $2 WHERE user_id = $1 AND status = 'left'`,
        [row.user_id, accepted.rowCount ? 'active' : 'invited']);
    }
  }

  let after = await getEmployee(tx, employeeId);
  if (changed.length || managerChanged) {
    const diffKeys = new Set<string>();
    for (const c of changed) diffKeys.add(c);
    if (managerChanged) diffKeys.add('manager');
    await employeeAudit(tx, actor, mode === 'self' ? 'employee.self_update' : 'employee.update', employeeId,
      pickDiff(before, diffKeys), pickDiff(after, diffKeys));
  }
  if (after.profile.completed && !after.profile.completedAt) {
    await tx.query(`UPDATE employees SET profile_completed_at = now() WHERE id = $1`, [employeeId]);
    await employeeAudit(tx, actor, 'employee.profile.complete', employeeId, null, { by: mode });
    after = await getEmployee(tx, employeeId);
  }
  return after;
}

/** Change the reporting line from today (future-dated lines are replaced). */
async function setManager(tx: Tx, actor: AuthContext, employeeId: number, managerId: number | null): Promise<boolean> {
  const lines = await tx.query(
    `SELECT id, manager_id, effective_from, (effective_from > tenant_today()) AS future,
            (effective_from = tenant_today()) AS today
       FROM employee_reporting
      WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to >= tenant_today())
      ORDER BY effective_from`,
    [employeeId],
  );
  const current = lines.rows[0];
  if ((current?.manager_id ?? null) === managerId && lines.rowCount! <= 1) return false;
  for (const l of lines.rows) {
    if (l.future || l.today) await tx.query(`DELETE FROM employee_reporting WHERE id = $1`, [l.id]);
    else await tx.query(`UPDATE employee_reporting SET effective_to = tenant_today() - 1 WHERE id = $1`, [l.id]);
  }
  if (managerId) {
    const start = current?.future ? current.effective_from : null;
    await tx.query(
      `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from, created_by)
       VALUES ($1, $2, $3, COALESCE($4::date, tenant_today()), $5)`,
      [actor.tenantId, employeeId, managerId, start, actor.userId],
    );
  }
  return true;
}

// ----------------------------------------------------------- departments --

export async function listDepartments(tx: Tx) {
  const r = await tx.query(
    `SELECT d.id, d.name, d.is_active,
            (SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.status <> 'exited') AS headcount
       FROM departments d ORDER BY d.is_active DESC, d.name`,
  );
  return r.rows.map((d) => ({ id: d.id, name: d.name, isActive: d.is_active, headcount: d.headcount }));
}

export async function createDepartment(tx: Tx, actor: AuthContext, name: string) {
  const dup = await tx.query(`SELECT 1 FROM departments WHERE lower(name) = lower($1)`, [name.trim()]);
  if (dup.rowCount) throw conflict('DUPLICATE', 'A department with this name already exists');
  const r = await tx.query(
    `INSERT INTO departments (tenant_id, name) VALUES ($1, $2) RETURNING id, name, is_active`,
    [actor.tenantId, name.trim()],
  );
  return { id: r.rows[0].id, name: r.rows[0].name, isActive: r.rows[0].is_active, headcount: 0 };
}

// --------------------------------------------------------- employee types --

/**
 * A type in this tenant (RLS hides others), held FOR SHARE until commit so it
 * cannot be deactivated between this check and the employee write.
 */
async function lockEmployeeType(tx: Tx, id: number) {
  const r = await tx.query(`SELECT id, base_category, is_active FROM employee_types WHERE id = $1 FOR SHARE`, [id]);
  return r.rows[0] as { id: number; base_category: string; is_active: boolean } | undefined;
}

/** The type a legacy employmentType maps to: the oldest active type with that base category. */
async function defaultEmployeeType(tx: Tx, category: string) {
  const r = await tx.query(
    `SELECT id, base_category FROM employee_types WHERE base_category = $1 AND is_active
      ORDER BY id LIMIT 1 FOR SHARE`,
    [category],
  );
  return r.rows[0] as { id: number; base_category: string } | undefined;
}

// ----------------------------------------------------------------- audit --

async function employeeAudit(tx: Tx, actor: AuthContext, action: string, employeeId: number, before: unknown, after: unknown) {
  await tx.query(
    `INSERT INTO employee_audit_log (tenant_id, actor_user_id, action, employee_id, before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor.tenantId, actor.userId, action, employeeId,
     before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after), actor.requestId ?? null],
  );
}

const COLUMN_TO_FIELD: Record<string, string> = Object.fromEntries(
  [...Object.entries(HR_FIELDS), ...Object.entries(SELF_FIELDS),
   ...Object.entries(ADDRESS_FIELDS).map(([k, v]) => [`address.${k}`, v]),
   ...Object.entries(EMERGENCY_FIELDS).map(([k, v]) => [`emergencyContact.${k}`, v])].map(([k, v]) => [v, k]),
);

function pickDiff(e: Employee, columns: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const c of columns) {
    if (c === 'manager') { out.manager = e.manager?.name ?? null; continue; }
    if (c === 'employee_type_id') { out.employeeType = e.employeeTypeName; out.employeeTypeId = e.employeeTypeId; continue; }
    if (c === 'department_id') { out.department = e.department?.name ?? null; continue; }
    const field = COLUMN_TO_FIELD[c];
    if (!field) continue;
    out[field] = field.split('.').reduce<any>((o, k) => o?.[k], e) ?? null;
  }
  return out;
}

function normalize(v: unknown) {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  return v ?? null;
}

/** Own employee record of the caller (self-service). */
export async function getOwnEmployee(tx: Tx, actor: AuthContext) {
  if (!actor.employeeId) throw new AppError(404, 'NO_EMPLOYEE_RECORD', 'You do not have an employee record in this organization');
  return getEmployee(tx, actor.employeeId);
}

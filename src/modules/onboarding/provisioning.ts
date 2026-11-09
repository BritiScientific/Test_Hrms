import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';

/**
 * Platform-side tenant provisioning (Milestone 2, step 1–2).
 *
 * Runs ONLY on an hrms_owner connection (the platform CLI, or tests); the API
 * role has no INSERT on tenants and no access to organization_invitations.
 * Creates, in one transaction:
 *   tenant -> default settings -> protected "Tenant Admin" system role holding
 *   every catalog permission -> one-time invitation for the first admin.
 * Nobody is a member yet: the admin becomes one only by redeeming the token,
 * and the only role an invitation can grant is the one fixed here.
 */

export const ProvisionInput = z.object({
  displayName: z.string().trim().min(2).max(200),
  legalName: z.string().trim().min(2).max(200).optional(),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'lowercase letters, digits and single hyphens').min(3).max(50),
  timezone: z.string().min(1).max(64).default('Asia/Kolkata'),
  countryCode: z.string().regex(/^[A-Z]{2}$/).optional(),
  adminEmail: z.string().trim().email().max(254),
  adminName: z.string().trim().min(1).max(200),
  inviteTtlHours: z.number().int().min(1).max(24 * 14).default(72),
});
export type ProvisionInput = z.input<typeof ProvisionInput>;

export const hashInvitationToken = (token: string) => createHash('sha256').update(token, 'utf8').digest();
export const newInvitationToken = () => randomBytes(32).toString('base64url');

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

export interface Invitation {
  invitationId: number;
  token: string;
  expiresAt: Date;
}

export async function provisionOrganization(client: pg.ClientBase, raw: ProvisionInput) {
  const input = ProvisionInput.parse(raw);
  await client.query('BEGIN');
  try {
    const tz = await client.query(`SELECT 1 FROM pg_timezone_names WHERE name = $1`, [input.timezone]);
    if (!tz.rowCount) throw new Error(`Unknown timezone ${input.timezone}`);
    const dup = await client.query(`SELECT 1 FROM tenants WHERE slug = $1`, [input.slug]);
    if (dup.rowCount) throw new Error(`An organization with slug "${input.slug}" already exists`);

    const t = await client.query(
      `INSERT INTO tenants (name, legal_name, slug, timezone, country_code)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.displayName, input.legalName ?? null, input.slug, input.timezone, input.countryCode ?? null],
    );
    const tenantId = Number(t.rows[0].id);
    await client.query(`INSERT INTO tenant_settings (tenant_id) VALUES ($1)`, [tenantId]);
    await seedDefaultEmployeeTypes(client, tenantId);

    const r = await client.query(
      `INSERT INTO roles (tenant_id, name, description, is_system_role)
       VALUES ($1, 'Tenant Admin', 'Full access. Protected system role.', true) RETURNING id`,
      [tenantId],
    );
    const adminRoleId = Number(r.rows[0].id);
    await client.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id)
       SELECT $1, $2, id FROM permissions WHERE is_active`,
      [tenantId, adminRoleId],
    );

    await client.query(
      `INSERT INTO organization_audit_log (tenant_id, actor_label, action, target_type, target_id, after_state)
       VALUES ($1, 'platform:cli', 'organization.create', 'organization', $1, $2)`,
      [tenantId, JSON.stringify({ displayName: input.displayName, slug: input.slug, timezone: input.timezone })],
    );
    const invitation = await insertInvitation(client, tenantId, adminRoleId, input.adminEmail, input.adminName, input.inviteTtlHours);
    await client.query('COMMIT');
    return { tenantId, adminRoleId, slug: input.slug, invitation };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/**
 * The four employee types every tenant starts with. Each maps to one legacy
 * employment_type code, so employees.employment_type stays valid. Same rows as
 * migration 017 seeds for tenants that already existed.
 */
export const DEFAULT_EMPLOYEE_TYPES = [
  { name: 'Full-Time', baseCategory: 'full_time', description: 'Permanent employee working full standard hours' },
  { name: 'Part-Time', baseCategory: 'part_time', description: 'Employee working reduced standard hours' },
  { name: 'Contract', baseCategory: 'contract', description: 'Fixed-term or contractual engagement' },
  { name: 'Intern', baseCategory: 'intern', description: 'Trainee or internship engagement' },
] as const;

/** Idempotent: a re-run (or a tenant that already has these names) inserts nothing. */
export async function seedDefaultEmployeeTypes(client: pg.ClientBase, tenantId: number) {
  for (const t of DEFAULT_EMPLOYEE_TYPES) {
    await client.query(
      `INSERT INTO employee_types (tenant_id, name, base_category, description)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [tenantId, t.name, t.baseCategory, t.description],
    );
  }
}

/** Re-issue an activation link for a tenant's first/additional administrator (bootstrap role only). */
export async function inviteTenantAdmin(
  client: pg.ClientBase,
  opts: { slug: string; email: string; name: string; ttlHours?: number },
) {
  await client.query('BEGIN');
  try {
    const t = await client.query(
      `SELECT t.id, r.id AS role_id FROM tenants t
         JOIN roles r ON r.tenant_id = t.id AND r.is_system_role AND r.name = 'Tenant Admin'
        WHERE t.slug = $1 AND t.is_active`,
      [opts.slug],
    );
    if (!t.rowCount) throw new Error(`No active organization "${opts.slug}" with a Tenant Admin role`);
    // Older unused links for the same email stop working.
    await client.query(
      `UPDATE organization_invitations SET revoked_at = now()
        WHERE tenant_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [t.rows[0].id, opts.email],
    );
    const invitation = await insertInvitation(client, Number(t.rows[0].id), Number(t.rows[0].role_id),
      opts.email, opts.name, opts.ttlHours ?? 72);
    await client.query('COMMIT');
    return { tenantId: Number(t.rows[0].id), invitation };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

async function insertInvitation(
  client: pg.ClientBase, tenantId: number, roleId: number, email: string, name: string, ttlHours: number,
): Promise<Invitation> {
  const token = newInvitationToken();
  const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
  const i = await client.query(
    `INSERT INTO organization_invitations (tenant_id, email, full_name, role_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, email, name, roleId, hashInvitationToken(token), expiresAt],
  );
  const invitationId = Number(i.rows[0].id);
  await client.query(
    `INSERT INTO organization_audit_log (tenant_id, actor_label, action, target_type, target_id, after_state)
     VALUES ($1, 'platform:cli', 'invitation.create', 'invitation', $2, $3)`,
    [tenantId, invitationId, JSON.stringify({ email, roleId, expiresAt })],
  );
  return { invitationId, token, expiresAt };
}

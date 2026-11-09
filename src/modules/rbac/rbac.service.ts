import type { Tx } from '../../config/db';
import type { AuthContext } from '../../shared/types';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors';

/**
 * RBAC rules enforced here (not in the original design):
 *  1. Anti-escalation: you can only GRANT permissions you hold yourself, and
 *     only ASSIGN roles whose every permission you hold. Without this, anyone
 *     with roles.manage can give themselves payroll.process.
 *  2. System roles are immutable through the API.
 *  3. Lockout protection: a change may not leave the tenant with nobody who
 *     holds roles.manage.
 *  4. Every change is written to rbac_audit_log in the same transaction.
 *  5. RBAC mutations are serialised per tenant (advisory lock) so two admins
 *     revoking each other concurrently cannot both pass the lockout check.
 */

const LOCKOUT_PERMISSION = 'roles.manage';

export interface RoleRow {
  id: number;
  name: string;
  description: string | null;
  is_system_role: boolean;
  is_active: boolean;
}

// ----------------------------------------------------------- auth context --

export async function loadAuthContext(
  tx: Tx,
  tenantId: number,
  userId: number,
  requestId?: string,
): Promise<AuthContext | null> {
  const m = await tx.query(
    `SELECT tu.status, u.is_active
       FROM tenant_users tu JOIN users u ON u.id = tu.user_id
      WHERE tu.user_id = $1`,
    [userId],
  );
  if (!m.rowCount || m.rows[0].status !== 'active' || !m.rows[0].is_active) return null;

  // Sequential on purpose: one client = one connection; never Promise.all on a tx.
  const emp = await tx.query(`SELECT id FROM employees WHERE user_id = $1 AND status <> 'exited'`, [userId]);
  const perms = await tx.query(`SELECT permission_code FROM v_effective_permissions WHERE user_id = $1`, [userId]);
  return {
    tenantId,
    userId,
    employeeId: emp.rows[0]?.id ?? null,
    permissions: new Set(perms.rows.map((r) => r.permission_code as string)),
    requestId,
  };
}

export async function userHasPermission(tx: Tx, userId: number, code: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM v_effective_permissions WHERE user_id = $1 AND permission_code = $2`,
    [userId, code],
  );
  return (r.rowCount ?? 0) > 0;
}

export async function getUserEffectivePermissions(tx: Tx, userId: number): Promise<string[]> {
  const r = await tx.query(
    `SELECT permission_code FROM v_effective_permissions WHERE user_id = $1 ORDER BY 1`,
    [userId],
  );
  return r.rows.map((x) => x.permission_code);
}

// ------------------------------------------------------------- catalog ------

export async function listPermissions(tx: Tx) {
  const r = await tx.query(
    `SELECT code, module, description FROM permissions WHERE is_active ORDER BY module, code`,
  );
  return r.rows;
}

// --------------------------------------------------------------- roles ------

/** An assignment that grants access today (same rule as v_effective_permissions). */
const CURRENT_ASSIGNMENT = `ur.revoked_at IS NULL AND ur.effective_from <= tenant_today()
  AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today())`;

export interface RoleFilters {
  search?: string;
  status?: 'active' | 'inactive' | 'all';
  type?: 'system' | 'custom' | 'all';
}

/** Role list with counts. Existing fields are unchanged; counts/timestamps are additive. */
export async function listRoles(tx: Tx, filters: RoleFilters = {}) {
  const r = await tx.query(
    `SELECT r.id, r.name, r.description, r.is_system_role, r.is_active,
            COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions,
            count(p.code)::int AS permission_count,
            (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur
              WHERE ur.tenant_id = r.tenant_id AND ur.role_id = r.id AND ${CURRENT_ASSIGNMENT}) AS member_count,
            r.created_at, r.updated_at
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      WHERE ($1::text IS NULL OR r.name ILIKE $1 OR r.description ILIKE $1)
        AND ($2::text = 'all' OR ($2 = 'active') = r.is_active)
        AND ($3::text = 'all' OR ($3 = 'system') = r.is_system_role)
      GROUP BY r.tenant_id, r.id
      ORDER BY r.is_system_role DESC, r.name`,
    [likePattern(filters.search), filters.status ?? 'all', filters.type ?? 'all'],
  );
  return r.rows;
}

/** Role detail: metadata, permissions with catalog metadata, counts and creator. */
export async function getRoleDetail(tx: Tx, roleId: number) {
  const r = await tx.query(
    `SELECT r.id, r.name, r.description, r.is_system_role, r.is_active, r.created_at, r.updated_at,
            r.created_by, u.full_name AS created_by_name,
            (SELECT count(DISTINCT ur.user_id)::int FROM user_roles ur
              WHERE ur.tenant_id = r.tenant_id AND ur.role_id = r.id AND ${CURRENT_ASSIGNMENT}) AS member_count
       FROM roles r LEFT JOIN users u ON u.id = r.created_by
      WHERE r.id = $1`,
    [roleId],
  );
  if (!r.rowCount) throw notFound('Role');
  const p = await tx.query(
    `SELECT p.code, p.module, p.description, rp.granted_at
       FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 ORDER BY p.module, p.code`,
    [roleId],
  );
  return { ...r.rows[0], permission_count: p.rowCount, permissions: p.rows };
}

/** Users who currently hold the role (and scheduled future assignments). */
export async function listRoleMembers(tx: Tx, roleId: number) {
  await getRole(tx, roleId);
  const r = await tx.query(
    `SELECT ur.id AS assignment_id, u.id AS user_id, u.full_name, u.email, tu.status AS membership_status,
            ur.effective_from, ur.effective_to, ur.assigned_at,
            (ur.effective_from > tenant_today()) AS scheduled
       FROM user_roles ur
       JOIN users u ON u.id = ur.user_id
       JOIN tenant_users tu ON tu.tenant_id = ur.tenant_id AND tu.user_id = ur.user_id
      WHERE ur.role_id = $1 AND ur.revoked_at IS NULL
        AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today())
      ORDER BY u.full_name`,
    [roleId],
  );
  return r.rows;
}

/** Duplicate a role (permissions included). Anti-escalation applies to the copied set. */
export async function cloneRole(
  tx: Tx,
  actor: AuthContext,
  sourceRoleId: number,
  input: { name: string; description?: string | null },
) {
  await lockRbac(tx, actor.tenantId);
  const source = await getRole(tx, sourceRoleId);
  const perms = await getRolePermissions(tx, sourceRoleId);
  if (perms.some((c) => !actor.permissions.has(c))) {
    throw forbidden('PRIVILEGE_ESCALATION', 'You can only copy roles whose permissions you hold yourself');
  }
  const r = await tx.query(
    `INSERT INTO roles (tenant_id, name, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, is_system_role, is_active`,
    [actor.tenantId, input.name.trim(), input.description ?? source.description, actor.userId],
  );
  const role = r.rows[0] as RoleRow;
  if (perms.length) {
    await tx.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id, granted_by)
       SELECT $1, $2, p.id, $3 FROM permissions p WHERE p.code = ANY($4::text[])`,
      [actor.tenantId, role.id, actor.userId, perms],
    );
  }
  await audit(tx, actor, 'role.create', 'role', role.id, null, { ...role, clonedFromRoleId: sourceRoleId, permissions: perms });
  return { ...role, permissions: perms };
}

export async function activateRole(tx: Tx, actor: AuthContext, roleId: number) {
  await lockRbac(tx, actor.tenantId);
  const before = await getRoleForUpdate(tx, roleId);
  assertNotSystem(before);
  if (before.is_active) return before;
  // Re-activating revives every current assignment of the role: same bar as assigning it.
  const perms = await getRolePermissions(tx, roleId);
  if (perms.some((c) => !actor.permissions.has(c))) {
    throw forbidden('PRIVILEGE_ESCALATION', 'You can only re-activate roles whose permissions you hold yourself');
  }
  const r = await tx.query(
    `UPDATE roles SET is_active = true WHERE id = $1 RETURNING id, name, description, is_system_role, is_active`,
    [roleId],
  );
  await audit(tx, actor, 'role.activate', 'role', roleId, before, r.rows[0]);
  return r.rows[0] as RoleRow;
}

export async function createRole(
  tx: Tx,
  actor: AuthContext,
  input: { name: string; description?: string | null },
) {
  await lockRbac(tx, actor.tenantId);
  const r = await tx.query(
    `INSERT INTO roles (tenant_id, name, description, created_by)
     VALUES ($1, $2, $3, $4) RETURNING id, name, description, is_system_role, is_active`,
    [actor.tenantId, input.name.trim(), input.description ?? null, actor.userId],
  );
  await audit(tx, actor, 'role.create', 'role', r.rows[0].id, null, r.rows[0]);
  return r.rows[0] as RoleRow;
}

export async function updateRole(
  tx: Tx,
  actor: AuthContext,
  roleId: number,
  input: { name?: string; description?: string | null },
) {
  await lockRbac(tx, actor.tenantId);
  const before = await getRoleForUpdate(tx, roleId);
  assertNotSystem(before);
  // description: undefined = keep, null/"" = clear.
  const r = await tx.query(
    `UPDATE roles SET name = COALESCE($2, name),
                      description = CASE WHEN $4 THEN NULLIF(trim($3), '') ELSE description END
      WHERE id = $1 RETURNING id, name, description, is_system_role, is_active`,
    [roleId, input.name?.trim() ?? null, input.description ?? null, input.description !== undefined],
  );
  await audit(tx, actor, 'role.update', 'role', roleId, before, r.rows[0]);
  return r.rows[0] as RoleRow;
}

export async function deactivateRole(tx: Tx, actor: AuthContext, roleId: number) {
  await lockRbac(tx, actor.tenantId);
  const before = await getRoleForUpdate(tx, roleId);
  assertNotSystem(before);
  const inUse = await tx.query(
    `SELECT 1 FROM workflow_steps s
       JOIN workflow_definitions d ON d.tenant_id = s.tenant_id AND d.id = s.workflow_id
      WHERE d.status = 'published' AND (s.approver_role_id = $1 OR s.fallback_role_id = $1)
      LIMIT 1`,
    [roleId],
  );
  if (inUse.rowCount) {
    throw conflict('ROLE_IN_USE', 'Role is an approver in a published workflow; publish a new version first');
  }
  await tx.query(`UPDATE roles SET is_active = false WHERE id = $1`, [roleId]);
  await assertNoLockout(tx);
  await audit(tx, actor, 'role.deactivate', 'role', roleId, before, { ...before, is_active: false });
}

export async function getRolePermissions(tx: Tx, roleId: number): Promise<string[]> {
  await getRole(tx, roleId);
  const r = await tx.query(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
      WHERE rp.role_id = $1 ORDER BY p.code`,
    [roleId],
  );
  return r.rows.map((x) => x.code);
}

/** Replace a role's permission set. */
export async function setRolePermissions(
  tx: Tx,
  actor: AuthContext,
  roleId: number,
  codes: string[],
) {
  await lockRbac(tx, actor.tenantId);
  const role = await getRoleForUpdate(tx, roleId);
  assertNotSystem(role);

  const wanted = [...new Set(codes)];
  const valid = await tx.query(
    `SELECT id, code FROM permissions WHERE is_active AND code = ANY($1::text[])`,
    [wanted],
  );
  const unknown = wanted.filter((c) => !valid.rows.some((r) => r.code === c));
  if (unknown.length) throw unprocessable('UNKNOWN_PERMISSION', 'Unknown permission codes', { unknown });

  const current = await getRolePermissions(tx, roleId);
  const added = wanted.filter((c) => !current.includes(c));
  const removed = current.filter((c) => !wanted.includes(c));

  const notHeld = added.filter((c) => !actor.permissions.has(c));
  if (notHeld.length) {
    throw forbidden('PRIVILEGE_ESCALATION', 'You can only grant permissions you hold yourself');
  }

  if (removed.length) {
    await tx.query(
      `DELETE FROM role_permissions rp USING permissions p
        WHERE rp.permission_id = p.id AND rp.role_id = $1 AND p.code = ANY($2::text[])`,
      [roleId, removed],
    );
  }
  if (added.length) {
    await tx.query(
      `INSERT INTO role_permissions (tenant_id, role_id, permission_id, granted_by)
       SELECT $1, $2, p.id, $3 FROM permissions p WHERE p.code = ANY($4::text[])`,
      [actor.tenantId, roleId, actor.userId, added],
    );
  }
  await assertNoLockout(tx);
  await audit(tx, actor, 'role.permissions.set', 'role', roleId, { permissions: current }, { permissions: wanted });
  return { roleId, permissions: wanted.sort(), added, removed };
}

// ---------------------------------------------------------- user roles ------

export async function listUserRoles(tx: Tx, userId: number) {
  await assertMember(tx, userId);
  const r = await tx.query(
    `SELECT ur.id, ur.role_id, r.name AS role_name, ur.effective_from, ur.effective_to,
            ur.revoked_at, ur.assigned_at
       FROM user_roles ur JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE ur.user_id = $1 ORDER BY ur.assigned_at DESC`,
    [userId],
  );
  return r.rows;
}

export async function assignRole(
  tx: Tx,
  actor: AuthContext,
  input: { userId: number; roleId: number; effectiveFrom?: string; effectiveTo?: string | null },
) {
  await lockRbac(tx, actor.tenantId);
  const role = await getRole(tx, input.roleId);
  if (!role.is_active) throw unprocessable('ROLE_INACTIVE', 'Role is inactive');

  const member = await tx.query(
    `SELECT status FROM tenant_users WHERE user_id = $1`,
    [input.userId],
  );
  // 'invited' members (HR quick add) may hold roles up front: v_effective_permissions
  // only counts ACTIVE memberships, so nothing is granted before activation.
  if (!member.rowCount || !['active', 'invited'].includes(member.rows[0].status)) throw notFound('User');

  const rolePerms = await getRolePermissions(tx, input.roleId);
  const notHeld = rolePerms.filter((c) => !actor.permissions.has(c));
  if (notHeld.length) {
    throw forbidden('PRIVILEGE_ESCALATION', 'You can only assign roles whose permissions you hold yourself');
  }

  const r = await tx.query(
    `INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from, effective_to, assigned_by)
     VALUES ($1, $2, $3, COALESCE($4::date, tenant_today()), $5::date, $6)
     RETURNING id, user_id, role_id, effective_from, effective_to`,
    [actor.tenantId, input.userId, input.roleId, input.effectiveFrom ?? null, input.effectiveTo ?? null, actor.userId],
  );
  await audit(tx, actor, 'user_role.assign', 'user_role', r.rows[0].id, null, r.rows[0]);
  return r.rows[0];
}

export async function revokeRole(tx: Tx, actor: AuthContext, userId: number, assignmentId: number) {
  await lockRbac(tx, actor.tenantId);
  const cur = await tx.query(
    `SELECT id, user_id, role_id, effective_from, effective_to, revoked_at
       FROM user_roles WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [assignmentId, userId],
  );
  if (!cur.rowCount) throw notFound('Role assignment');
  if (cur.rows[0].revoked_at) throw conflict('ALREADY_REVOKED', 'Role assignment already revoked');

  // Revoking a role you could not have granted is also escalation-relevant
  // (e.g. removing the Tenant Admin role from the owner).
  const rolePerms = await getRolePermissions(tx, cur.rows[0].role_id);
  if (rolePerms.some((c) => !actor.permissions.has(c))) {
    throw forbidden('PRIVILEGE_ESCALATION', 'You can only revoke roles whose permissions you hold yourself');
  }

  await tx.query(
    `UPDATE user_roles SET revoked_at = now(), revoked_by = $2 WHERE id = $1`,
    [assignmentId, actor.userId],
  );
  await assertNoLockout(tx);
  await audit(tx, actor, 'user_role.revoke', 'user_role', assignmentId, cur.rows[0], { revoked: true });
}

// --------------------------------------------------------- user lookup ------
// Milestone 3 (employee administration) is out of scope: this is only the
// directory of EXISTING tenant members that role assignment needs.

export async function listUsers(tx: Tx, q: { search?: string; limit?: number; offset?: number }) {
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const r = await tx.query(
    `SELECT u.id, u.email, u.full_name, u.is_active, tu.status AS membership_status, tu.joined_at,
            e.employee_code,
            COALESCE(jsonb_agg(jsonb_build_object(
                'assignmentId', ur.id, 'roleId', r.id, 'roleName', r.name,
                'isSystemRole', r.is_system_role, 'roleActive', r.is_active,
                'effectiveFrom', ur.effective_from, 'effectiveTo', ur.effective_to,
                'scheduled', ur.effective_from > tenant_today())
              ORDER BY r.name) FILTER (WHERE ur.id IS NOT NULL), '[]') AS roles,
            count(*) OVER ()::int AS total
       FROM tenant_users tu
       JOIN users u ON u.id = tu.user_id
       LEFT JOIN employees e ON e.tenant_id = tu.tenant_id AND e.user_id = tu.user_id
       LEFT JOIN user_roles ur ON ur.tenant_id = tu.tenant_id AND ur.user_id = tu.user_id
             AND ur.revoked_at IS NULL AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today())
       LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE ($1::text IS NULL OR u.full_name ILIKE $1 OR u.email ILIKE $1 OR e.employee_code ILIKE $1)
      GROUP BY u.id, tu.tenant_id, tu.user_id, e.employee_code
      ORDER BY u.full_name, u.id
      LIMIT $2 OFFSET $3`,
    [likePattern(q.search), limit, offset],
  );
  const total = r.rows[0]?.total ?? (offset > 0 ? (await countMembers(tx)) : 0);
  return { items: r.rows.map(({ total: _t, ...row }) => row), total, limit, offset };
}

export async function getUser(tx: Tx, userId: number) {
  const r = await tx.query(
    `SELECT u.id, u.email, u.full_name, u.is_active, tu.status AS membership_status, tu.joined_at,
            e.employee_code,
            COALESCE(jsonb_agg(jsonb_build_object(
                'assignmentId', ur.id, 'roleId', r.id, 'roleName', r.name,
                'isSystemRole', r.is_system_role, 'roleActive', r.is_active,
                'effectiveFrom', ur.effective_from, 'effectiveTo', ur.effective_to,
                'scheduled', ur.effective_from > tenant_today())
              ORDER BY r.name) FILTER (WHERE ur.id IS NOT NULL), '[]') AS roles
       FROM tenant_users tu
       JOIN users u ON u.id = tu.user_id
       LEFT JOIN employees e ON e.tenant_id = tu.tenant_id AND e.user_id = tu.user_id
       LEFT JOIN user_roles ur ON ur.tenant_id = tu.tenant_id AND ur.user_id = tu.user_id
             AND ur.revoked_at IS NULL AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today())
       LEFT JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id
      WHERE tu.user_id = $1
      GROUP BY u.id, tu.tenant_id, tu.user_id, e.employee_code`,
    [userId],
  );
  if (!r.rowCount) throw notFound('User');
  return r.rows[0];
}

/**
 * Effective permissions WITH the roles that grant them. Uses exactly the
 * same rules as v_effective_permissions (which authorization reads), so the
 * preview cannot disagree with what the API enforces.
 */
export async function getUserPermissionSources(tx: Tx, userId: number) {
  await assertMember(tx, userId);
  const r = await tx.query(
    `SELECT p.code, p.module, p.description,
            jsonb_agg(DISTINCT jsonb_build_object('roleId', r.id, 'roleName', r.name)) AS sources
       FROM v_effective_permissions v
       JOIN permissions p ON p.code = v.permission_code
       JOIN user_roles ur ON ur.tenant_id = v.tenant_id AND ur.user_id = v.user_id AND ${CURRENT_ASSIGNMENT}
       JOIN roles r ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id AND r.is_active
       JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND rp.permission_id = p.id
      WHERE v.user_id = $1
      GROUP BY p.code, p.module, p.description
      ORDER BY p.module, p.code`,
    [userId],
  );
  return r.rows;
}

// ---------------------------------------------------------------- audit ------

/** RBAC + organization audit timeline, filtered to what the caller may see. */
export async function listAuditEvents(
  tx: Tx,
  actor: AuthContext,
  q: {
    limit?: number; offset?: number; category?: 'rbac' | 'organization' | 'employee' | 'work_schedule';
    targetType?: string; targetId?: number;
  },
) {
  const canRbac = ['roles.view', 'roles.manage', 'roles.assign'].some((c) => actor.permissions.has(c));
  const canOrg = ['organization.view', 'organization.update', 'organization.settings.view', 'organization.settings.update']
    .some((c) => actor.permissions.has(c));
  const canEmp = actor.permissions.has('employee.view');
  // Any work schedule permission shows its configuration history.
  const canWs = [...actor.permissions].some((c) => c.startsWith('workschedule.'));
  if (!canRbac && !canOrg && !canEmp && !canWs) throw forbidden('MISSING_PERMISSION', 'Permission denied');
  const limit = Math.min(Math.max(q.limit ?? 25, 1), 100);
  const offset = Math.max(q.offset ?? 0, 0);
  const r = await tx.query(
    `SELECT x.category, x.id, x.action, x.target_type, x.target_id, x.before_state, x.after_state,
            x.request_id, x.at, x.actor_user_id, COALESCE(u.full_name, x.actor_label) AS actor_name
       FROM (
         SELECT 'rbac'::text AS category, a.id, a.action, a.target_type, a.target_id, a.before_state,
                a.after_state, a.request_id, a.at, a.actor_user_id, NULL::text AS actor_label
           FROM rbac_audit_log a WHERE $1
         UNION ALL
         SELECT 'organization', o.id, o.action, o.target_type, o.target_id, o.before_state,
                o.after_state, o.request_id, o.at, o.actor_user_id, o.actor_label
           FROM organization_audit_log o WHERE $2
         UNION ALL
         SELECT 'employee', ea.id, ea.action, 'employee', ea.employee_id, ea.before_state,
                ea.after_state, ea.request_id, ea.at, ea.actor_user_id, NULL
           FROM employee_audit_log ea WHERE $8
         UNION ALL
         SELECT 'work_schedule', w.id, w.entity_type || '.' || w.action, w.entity_type, w.entity_id, w.before_state,
                w.after_state, w.request_id, w.created_at, w.actor_user_id, NULL
           FROM work_schedule_audit_log w WHERE $9
       ) x
       LEFT JOIN users u ON u.id = x.actor_user_id
      WHERE ($3::text IS NULL OR x.category = $3)
        AND ($4::text IS NULL OR x.target_type = $4)
        AND ($5::bigint IS NULL OR x.target_id = $5)
      ORDER BY x.at DESC, x.id DESC
      LIMIT $6 OFFSET $7`,
    [canRbac, canOrg, q.category ?? null, q.targetType ?? null, q.targetId ?? null, limit + 1, offset, canEmp, canWs],
  );
  return { items: r.rows.slice(0, limit), hasMore: r.rows.length > limit, limit, offset };
}

// ------------------------------------------------------------- helpers ------

/** 404 (not 403) for users outside this tenant: existence is never disclosed. */
async function assertMember(tx: Tx, userId: number) {
  const m = await tx.query(`SELECT 1 FROM tenant_users WHERE user_id = $1`, [userId]);
  if (!m.rowCount) throw notFound('User');
}

async function countMembers(tx: Tx): Promise<number> {
  const r = await tx.query(`SELECT count(*)::int AS n FROM tenant_users`);
  return r.rows[0].n;
}

function likePattern(search?: string): string | null {
  const s = search?.trim();
  if (!s) return null;
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function lockRbac(tx: Tx, tenantId: number) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('rbac'), $1::int)`, [tenantId]);
}

async function getRole(tx: Tx, roleId: number): Promise<RoleRow> {
  const r = await tx.query(
    `SELECT id, name, description, is_system_role, is_active FROM roles WHERE id = $1`,
    [roleId],
  );
  if (!r.rowCount) throw notFound('Role');
  return r.rows[0];
}

async function getRoleForUpdate(tx: Tx, roleId: number): Promise<RoleRow> {
  const r = await tx.query(
    `SELECT id, name, description, is_system_role, is_active FROM roles WHERE id = $1 FOR UPDATE`,
    [roleId],
  );
  if (!r.rowCount) throw notFound('Role');
  return r.rows[0];
}

function assertNotSystem(role: RoleRow) {
  if (role.is_system_role) throw forbidden('SYSTEM_ROLE', 'System roles cannot be modified');
}

export async function assertNoLockout(tx: Tx) {
  const r = await tx.query(
    `SELECT count(*)::int AS n FROM v_effective_permissions WHERE permission_code = $1`,
    [LOCKOUT_PERMISSION],
  );
  if (r.rows[0].n === 0) {
    throw new AppError(409, 'LOCKOUT', `This change would leave nobody with ${LOCKOUT_PERMISSION}`);
  }
}

async function audit(
  tx: Tx,
  actor: AuthContext,
  action: string,
  targetType: string,
  targetId: number,
  before: unknown,
  after: unknown,
) {
  await tx.query(
    `INSERT INTO rbac_audit_log (tenant_id, actor_user_id, action, target_type, target_id,
                                 before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor.tenantId, actor.userId, action, targetType, targetId,
     before === null ? null : JSON.stringify(before), JSON.stringify(after), actor.requestId ?? null],
  );
}

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

export async function listRoles(tx: Tx) {
  const r = await tx.query(
    `SELECT r.id, r.name, r.description, r.is_system_role, r.is_active,
            COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.tenant_id = r.tenant_id AND rp.role_id = r.id
       LEFT JOIN permissions p ON p.id = rp.permission_id
      GROUP BY r.tenant_id, r.id
      ORDER BY r.name`,
  );
  return r.rows;
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
  const r = await tx.query(
    `UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description)
      WHERE id = $1 RETURNING id, name, description, is_system_role, is_active`,
    [roleId, input.name?.trim() ?? null, input.description ?? null],
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
  if (!member.rowCount || member.rows[0].status !== 'active') throw notFound('User');

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

// ------------------------------------------------------------- helpers ------

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

async function assertNoLockout(tx: Tx) {
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

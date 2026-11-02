import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { forbidden } from '../../shared/errors';
import * as rbac from './rbac.service';

const RoleBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).nullish(),
});
const RolePatch = RoleBody.partial();
const PermissionsBody = z.object({ permissions: z.array(z.string().max(150)).max(500) });
// z.coerce on IDs: JSON bodies from Postman/forms carry "3" rather than 3.
const AssignBody = z.object({
  roleId: z.coerce.number().int().positive(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

const RoleListQuery = z.object({
  search: z.string().max(100).optional(),
  status: z.enum(['active', 'inactive', 'all']).optional(),
  type: z.enum(['system', 'custom', 'all']).optional(),
});
const UserListQuery = z.object({
  search: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
const AuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  category: z.enum(['rbac', 'organization']).optional(),
  targetType: z.string().regex(/^[a-z_]{1,30}$/).optional(),
  targetId: z.coerce.number().int().positive().optional(),
});

export const rbacRouter = Router();
// Scoped to the paths this router owns, so an unknown URL still gets a 404
// from the app-level fallback instead of a misleading 401.
rbacRouter.use('/roles', authenticate);
rbacRouter.use('/users', authenticate);
rbacRouter.use('/permissions', authenticate);
rbacRouter.use('/audit-events', authenticate);

const canView = requirePermission('roles.view', 'roles.manage', 'roles.assign');

rbacRouter.get('/permissions', canView, tenantHandler((tx) => rbac.listPermissions(tx)));

rbacRouter.get('/roles', canView, tenantHandler((tx, _a, req) => rbac.listRoles(tx, RoleListQuery.parse(req.query))));

rbacRouter.get('/roles/:id', canView, tenantHandler((tx, _a, req) => rbac.getRoleDetail(tx, idParam(req))));

rbacRouter.get('/roles/:id/members', canView, tenantHandler((tx, _a, req) => rbac.listRoleMembers(tx, idParam(req))));

rbacRouter.post('/roles/:id/clone', requirePermission('roles.manage'),
  tenantHandler((tx, auth, req) => rbac.cloneRole(tx, auth, idParam(req), RoleBody.parse(req.body)), 201));

rbacRouter.post('/roles/:id/activate', requirePermission('roles.manage'),
  tenantHandler((tx, auth, req) => rbac.activateRole(tx, auth, idParam(req))));

rbacRouter.post('/roles', requirePermission('roles.manage'),
  tenantHandler((tx, auth, req) => rbac.createRole(tx, auth, RoleBody.parse(req.body)), 201));

rbacRouter.put('/roles/:id', requirePermission('roles.manage'),
  tenantHandler((tx, auth, req) => rbac.updateRole(tx, auth, idParam(req), RolePatch.parse(req.body))));

rbacRouter.delete('/roles/:id', requirePermission('roles.manage'),
  tenantHandler(async (tx, auth, req) => { await rbac.deactivateRole(tx, auth, idParam(req)); }));

rbacRouter.get('/roles/:id/permissions', canView,
  tenantHandler((tx, _a, req) => rbac.getRolePermissions(tx, idParam(req))));

rbacRouter.put('/roles/:id/permissions', requirePermission('roles.manage'),
  tenantHandler((tx, auth, req) =>
    rbac.setRolePermissions(tx, auth, idParam(req), PermissionsBody.parse(req.body).permissions)));

// Directory of existing tenant members for role assignment (not employee administration).
rbacRouter.get('/users', canView, tenantHandler((tx, _a, req) => rbac.listUsers(tx, UserListQuery.parse(req.query))));

rbacRouter.get('/users/:id', canView, tenantHandler((tx, _a, req) => rbac.getUser(tx, idParam(req))));

rbacRouter.get('/users/:id/roles', canView, tenantHandler((tx, _a, req) => rbac.listUserRoles(tx, idParam(req))));

rbacRouter.post('/users/:id/roles', requirePermission('roles.assign'),
  tenantHandler((tx, auth, req) => rbac.assignRole(tx, auth, { userId: idParam(req), ...AssignBody.parse(req.body) }), 201));

rbacRouter.delete('/users/:id/roles/:assignmentId', requirePermission('roles.assign'),
  tenantHandler(async (tx, auth, req) => {
    await rbac.revokeRole(tx, auth, idParam(req), idParam(req, 'assignmentId'));
  }));

rbacRouter.get('/users/:id/permissions', tenantHandler((tx, auth, req) => {
  const userId = idParam(req);
  const allowed = userId === auth.userId || ['roles.view', 'roles.manage', 'roles.assign'].some((c) => auth.permissions.has(c));
  if (!allowed) throw forbidden('MISSING_PERMISSION', 'Permission denied');
  // ?include=sources -> [{code, module, description, sources:[{roleId, roleName}]}]; default stays string[].
  if (req.query.include === 'sources') return rbac.getUserPermissionSources(tx, userId);
  return rbac.getUserEffectivePermissions(tx, userId);
}));

rbacRouter.get('/audit-events', tenantHandler((tx, auth, req) => rbac.listAuditEvents(tx, auth, AuditQuery.parse(req.query))));

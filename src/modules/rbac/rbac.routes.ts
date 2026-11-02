import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { idParam, tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { forbidden } from '../../shared/errors';
import * as rbac from './rbac.service';

const RoleBody = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(1000).nullish(),
});
const RolePatch = RoleBody.partial();
const PermissionsBody = z.object({ permissions: z.array(z.string().max(150)).max(500) });
// z.coerce on IDs: JSON bodies from Postman/forms carry "3" rather than 3.
const AssignBody = z.object({
  roleId: z.coerce.number().int().positive(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

export const rbacRouter = Router();
// Scoped to the paths this router owns, so an unknown URL still gets a 404
// from the app-level fallback instead of a misleading 401.
rbacRouter.use('/roles', authenticate);
rbacRouter.use('/users', authenticate);
rbacRouter.use('/permissions', authenticate);

const canView = requirePermission('roles.view', 'roles.manage', 'roles.assign');

rbacRouter.get('/permissions', canView, tenantHandler((tx) => rbac.listPermissions(tx)));

rbacRouter.get('/roles', canView, tenantHandler((tx) => rbac.listRoles(tx)));

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
  return rbac.getUserEffectivePermissions(tx, userId);
}));

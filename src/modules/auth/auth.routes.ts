import { Router } from 'express';
import { z } from 'zod';
import { queryNoTenant } from '../../config/db';
import { authenticate, signAccessToken } from '../../middleware/authenticate';
import { handle, tenantHandler } from '../../middleware/http';
import { AppError } from '../../shared/errors';
import { getUserEffectivePermissions } from '../rbac/rbac.service';
import { verifyDummy, verifyPassword } from './password';

const LoginBody = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  tenantId: z.number().int().positive().optional(),
});

export const authRouter = Router();

/**
 * POST /auth/login. Put a rate limiter (per IP + per email) in front of this.
 * The tenant comes from verified membership, never from an unvalidated header.
 */
authRouter.post('/auth/login', handle(async (req, res) => {
  const body = LoginBody.parse(req.body);
  const u = await queryNoTenant(`SELECT * FROM auth_find_user($1)`, [body.email]);
  const user = u.rows[0];
  const ok = user ? await verifyPassword(body.password, user.password_hash) : await verifyDummy(body.password);
  if (!user || !ok || !user.is_active) throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

  const t = await queryNoTenant(`SELECT * FROM auth_user_tenants($1)`, [user.user_id]);
  const tenants = t.rows.map((r) => ({ id: Number(r.tenant_id), name: r.tenant_name }));
  if (!tenants.length) throw new AppError(403, 'NO_TENANT', 'No active tenant membership');

  let tenantId = body.tenantId;
  if (tenantId === undefined) {
    if (tenants.length > 1) throw new AppError(409, 'TENANT_REQUIRED', 'Choose a tenant', { tenants });
    tenantId = tenants[0].id;
  }
  if (!tenants.some((x) => x.id === tenantId)) throw new AppError(403, 'NOT_A_MEMBER', 'Not a member of that tenant');

  res.json({ accessToken: signAccessToken(Number(user.user_id), tenantId), tokenType: 'Bearer', tenantId, tenants });
}));

/** GET /me — what the frontend uses to show/hide menus (UX only; the API re-checks everything). */
authRouter.get('/me', authenticate, tenantHandler(async (tx, auth) => ({
  userId: auth.userId,
  tenantId: auth.tenantId,
  employeeId: auth.employeeId,
  permissions: await getUserEffectivePermissions(tx, auth.userId),
})));

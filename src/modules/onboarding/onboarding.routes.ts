import { Router } from 'express';
import { z } from 'zod';
import { queryNoTenant } from '../../config/db';
import { handle } from '../../middleware/http';
import { publicTokenLimiter } from '../../middleware/rate-limit';
import { AppError } from '../../shared/errors';
import { listMemberships } from '../auth/auth.routes';
import { hashPassword, verifyPassword } from '../auth/password';
import { createSession, deliverSession } from '../auth/session';
import { hashInvitationToken } from './provisioning';

/**
 * Public, token-bound activation of an invited administrator (Milestone 2,
 * step 3). The token is the only credential: it is hashed before lookup,
 * expires, is consumed under a row lock (single use), and every invalid state
 * returns the same 404 so a guesser learns nothing.
 */

const TokenParam = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);

export const PasswordPolicy = z.string()
  .min(10, 'Use at least 10 characters')
  .max(200)
  .regex(/[A-Za-z]/, 'Include at least one letter')
  .regex(/[0-9]/, 'Include at least one number');

const ActivateBody = z.object({
  token: TokenParam,
  password: z.string().min(1).max(200),
  fullName: z.string().trim().min(1).max(200).optional(),
});

const invalid = () => new AppError(404, 'INVITATION_INVALID', 'This activation link is invalid, has expired or was already used');

async function lookup(token: string) {
  const r = await queryNoTenant(`SELECT * FROM onboarding_invitation_lookup($1)`, [hashInvitationToken(token)]);
  return r.rows[0] ?? null;
}

export const onboardingRouter = Router();

/** GET /onboarding/invitations/:token — what the activation screen needs to render. */
onboardingRouter.get('/onboarding/invitations/:token', publicTokenLimiter, handle(async (req, res) => {
  const parsed = TokenParam.safeParse(req.params.token);
  if (!parsed.success) throw invalid();
  const inv = await lookup(parsed.data);
  if (!inv) throw invalid();
  res.json({
    email: inv.email,
    fullName: inv.full_name,
    organizationName: inv.organization_name,
    // Existing account: the user confirms with their CURRENT password instead of creating one.
    accountExists: !!inv.user_exists && !!inv.user_has_password,
  });
}));

/** POST /onboarding/activate — accept the invitation and sign in. */
onboardingRouter.post('/onboarding/activate', publicTokenLimiter, handle(async (req, res) => {
  const body = ActivateBody.parse(req.body);
  const inv = await lookup(body.token);
  if (!inv) throw invalid();

  let passwordHash: string | null;
  if (inv.user_exists && inv.user_has_password) {
    const u = await queryNoTenant(`SELECT * FROM auth_find_user($1)`, [inv.email]);
    if (!u.rows[0] || !(await verifyPassword(body.password, u.rows[0].password_hash))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Enter the current password of this existing account');
    }
    passwordHash = null;
  } else {
    const policy = PasswordPolicy.safeParse(body.password);
    if (!policy.success) {
      throw new AppError(422, 'WEAK_PASSWORD', policy.error.issues[0].message, {
        fieldErrors: { password: policy.error.issues.map((i) => i.message) },
      });
    }
    if (body.password.toLowerCase().includes(String(inv.email).split('@')[0].toLowerCase())) {
      throw new AppError(422, 'WEAK_PASSWORD', 'Password must not contain your email name');
    }
    passwordHash = await hashPassword(body.password);
  }

  let accepted;
  try {
    const r = await queryNoTenant(
      `SELECT * FROM onboarding_accept_invitation($1, $2, $3, $4)`,
      [hashInvitationToken(body.token), passwordHash, body.fullName ?? null, req.requestId ?? null],
    );
    accepted = r.rows[0];
  } catch (e: any) {
    if (e?.code === 'P0001') {
      if (e.message === 'INVITATION_INVALID') throw invalid();
      throw new AppError(409, e.message, 'The account changed while activating. Please reload and try again.');
    }
    throw e;
  }

  const tenantId = Number(accepted.out_tenant_id);
  const userId = Number(accepted.out_user_id);
  const session = await createSession(req, userId, tenantId);
  deliverSession(req, res, session, { tenantId, tenants: await listMemberships(userId) });
}));

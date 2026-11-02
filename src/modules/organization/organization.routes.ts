import express, { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate';
import { tenantHandler } from '../../middleware/http';
import { requirePermission } from '../../middleware/require-permission';
import { withTenantTx } from '../../config/db';
import { MAX_LOGO_BYTES } from './asset-storage';
import { COUNTRIES, CURRENCIES, DATE_FORMATS, LOCALES, TIMEZONES } from './organization.reference';
import * as org from './organization.service';

/** Optional text: trims, and turns "" into null so a field can be cleared. */
const optText = (max: number) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? null : v), z.string().trim().max(max).nullable()).optional();

const ProfileBody = z.object({
  displayName: z.string().trim().min(2).max(200).optional(),
  legalName: optText(200),
  industry: optText(100),
  website: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().max(300).url().refine((u) => /^https?:\/\//i.test(u), 'Must start with http:// or https://').nullable(),
  ).optional(),
  contactEmail: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().email().max(254).nullable(),
  ).optional(),
  contactPhone: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().trim().regex(/^\+?[0-9 ()-]{5,40}$/, 'Digits, spaces, +, ( ) and - only').nullable(),
  ).optional(),
  contactPerson: optText(200),
  registrationNumber: optText(100),
  address: z.object({
    line1: optText(200),
    line2: optText(200),
    city: optText(100),
    stateProvince: optText(100),
    postalCode: optText(20),
    countryCode: z.preprocess(
      (v) => (typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim().toUpperCase() : v),
      z.string().regex(/^[A-Z]{2}$/).nullable(),
    ).optional(),
  }).strict().optional(),
  version: z.coerce.number().int().positive().optional(),
}).strict();

const SettingsBody = z.object({
  timezone: z.string().min(1).max(64).optional(),
  weeklyOffs: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  locale: z.string().max(35).optional(),
  dateFormat: z.enum(DATE_FORMATS).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  financialYearStartMonth: z.number().int().min(1).max(12).optional(),
  weekStartDay: z.number().int().min(0).max(6).optional(),
  version: z.coerce.number().int().min(0).optional(),
}).strict();

export const organizationRouter = Router();
organizationRouter.use('/organization', authenticate);

const canViewProfile = requirePermission('organization.view', 'organization.update');
const canUpdateProfile = requirePermission('organization.update');
const canViewSettings = requirePermission('organization.settings.view', 'organization.settings.update');
const canUpdateSettings = requirePermission('organization.settings.update');

organizationRouter.get('/organization', canViewProfile, tenantHandler((tx) => org.getProfile(tx)));

organizationRouter.patch('/organization', canUpdateProfile,
  tenantHandler((tx, auth, req) => org.updateProfile(tx, auth, ProfileBody.parse(req.body))));

organizationRouter.get('/organization/settings', canViewSettings, tenantHandler((tx) => org.getSettings(tx)));

organizationRouter.patch('/organization/settings', canUpdateSettings,
  tenantHandler((tx, auth, req) => org.updateSettings(tx, auth, SettingsBody.parse(req.body))));

/** Reference lists for the settings forms (any member). */
organizationRouter.get('/organization/options', tenantHandler(async () => ({
  timezones: TIMEZONES,
  locales: LOCALES,
  currencies: CURRENCIES,
  countries: COUNTRIES,
  dateFormats: DATE_FORMATS,
})));

organizationRouter.get('/organization/onboarding-status', tenantHandler((tx) => org.getOnboardingStatus(tx)));

organizationRouter.post('/organization/onboarding/complete', canUpdateProfile,
  tenantHandler((tx, auth) => org.completeOnboarding(tx, auth)));

/** Logo bytes for any member of the organization; never another tenant's. */
organizationRouter.get('/organization/logo', (req, res, next) => {
  withTenantTx(req.auth!.tenantId, (tx) => org.getLogo(tx))
    .then((logo) => {
      res.setHeader('content-type', logo.contentType);
      res.setHeader('content-length', String(logo.byteSize));
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('content-security-policy', "default-src 'none'");
      res.setHeader('cache-control', 'private, max-age=86400');
      res.setHeader('etag', `"${logo.sha256}"`);
      if (req.header('if-none-match') === `"${logo.sha256}"`) res.status(304).end();
      else res.end(logo.data);
    })
    .catch(next);
});

/**
 * POST /organization/logo — raw image bytes as the body, Content-Type
 * image/png | image/jpeg | image/webp. The bytes are sniffed and must match.
 */
organizationRouter.post('/organization/logo', canUpdateProfile,
  express.raw({ type: () => true, limit: MAX_LOGO_BYTES + 1 }),
  tenantHandler((tx, auth, req) => org.uploadLogo(tx, auth, req.header('content-type'), req.body), 201));

organizationRouter.delete('/organization/logo', canUpdateProfile,
  tenantHandler(async (tx, auth) => { await org.removeLogo(tx, auth); }));

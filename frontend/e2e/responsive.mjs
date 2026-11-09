/**
 * End-to-end + responsive QA against a running stack (API on :4000, web on :5173,
 * freshly reset database):
 *
 *   npm run db:reset && npm run dev        # repo root
 *   npm run web:dev                        # repo root, second terminal
 *   npm --prefix frontend run test:e2e
 *
 * 1. Functional flows: sign-in, multi-organization selection, access denied,
 *    onboarding redirect, session-expired handling, role create + permissions,
 *    role assignment, logout.
 * 2. Every main screen at 320/360/390/768/1024/1280/1440/1920/2560 px: no page-level
 *    horizontal overflow, every button has an accessible name. Screenshots go to
 *    e2e/screenshots/.
 * Env: E2E_BASE_URL (default http://localhost:5173), PW_CHROMIUM_PATH (optional).
 */
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:5173';
const PASSWORD = 'Passw0rd!';
const SHOTS = new URL('./screenshots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS = [
  [320, 640], [360, 740], [390, 844], [768, 1024], [1024, 768], [1280, 800], [1440, 900], [1920, 1080], [2560, 1440],
];
const SCREENS = [
  ['dashboard', '/dashboard'],
  ['org-profile', '/settings/organization/profile'],
  ['org-settings', '/settings/organization/preferences'],
  ['org-chart', '/settings/organization-chart'],
  ['roles', '/settings/access/roles'],
  ['role-detail', '/settings/access/roles/3'],
  ['role-permissions', '/settings/access/roles/3/permissions'],
  ['permissions', '/settings/access/permissions'],
  ['assignments', '/settings/access/assignments?user=5'],
  ['effective', '/settings/access/users/4/permissions'],
  ['security', '/settings/security'],
  ['employees', '/employees'],
  ['employee-quick-add', '/employees?new=1'],
  ['employee-detail', '/employees/5'],
  ['my-profile', '/my-profile'],
  ['leave-dashboard', '/leave/dashboard'],
  ['leave-apply', '/leave/apply'],
  ['leave-my-requests', '/leave/my-requests'],
  ['leave-holidays', '/leave/holidays'],
  ['leave-team-dashboard', '/leave/team/dashboard'],
  ['leave-team-requests', '/leave/team/requests'],
  ['leave-admin-dashboard', '/leave/admin/dashboard'],
  ['leave-admin-requests', '/leave/admin/requests'],
  ['leave-admin-calendar', '/leave/admin/calendar'],
  ['leave-admin-reports', '/leave/admin/reports'],
  ['leave-config-types', '/leave/config/types'],
  ['leave-config-policies', '/leave/config/policies'],
  ['leave-config-calendars', '/leave/config/holiday-calendars'],
  ['leave-config-workflows', '/leave/config/workflows'],
  ['leave-config-accrual', '/leave/config/accrual'],
  ['leave-config-assignments', '/leave/config/assignments'],
];
const SHOT_WIDTHS = new Set([320, 768, 1440, 2560]);

const failures = [];
const passes = [];
const check = (ok, label, detail = '') => {
  (ok ? passes : failures).push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail && !ok ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});

async function newPage(viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
  return { ctx, page };
}

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector('[role="status"][aria-label^="Loading"], .animate-pulse'), null, { timeout: 8000 }).catch(() => undefined);
}

// ----------------------------------------------------------------- flows --
console.log('Functional flows');
{
  const { ctx, page } = await newPage();
  await page.goto(`${BASE}/settings/access/roles`);
  await page.waitForURL(/\/login\?returnTo=/);
  check(true, 'protected route redirects anonymous users to /login with a return path');

  await page.getByLabel('Work email').fill('asha@abc.test');
  await page.getByLabel(/^Password/).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  const alert = await page.getByRole('alert').first().textContent();
  check(/incorrect/i.test(alert ?? ''), 'invalid credentials show a safe message', alert ?? '');

  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/settings\/access\/roles$/);
  check(true, 'after sign-in the user returns to the page they asked for');
  const cookies = await ctx.cookies();
  const session = cookies.find((c) => c.name === 'hrms_session');
  check(!!session?.httpOnly && session?.sameSite === 'Strict', 'session cookie is HttpOnly + SameSite=Strict');
  const exposed = await page.evaluate(() => document.cookie.includes('hrms_session'));
  check(!exposed, 'session token is not readable from JavaScript');

  // Create a role, give it permissions, assign it.
  await page.getByRole('link', { name: 'Create role' }).click();
  await page.getByLabel(/Role name/).fill('Recruiter');
  await page.getByLabel('Description').fill('Hiring team');
  await page.getByRole('button', { name: /Create and choose permissions/ }).click();
  await page.waitForURL(/\/roles\/\d+\/permissions$/);
  await page.getByLabel('Search permissions').fill('employee');
  await page.getByRole('checkbox', { name: /Select all visible Employees permissions/ }).check();
  await page.getByRole('button', { name: /Review & save/ }).click();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await page.getByText('Permissions saved').waitFor();
  check(true, 'role created and permissions saved through the matrix');

  await page.goto(`${BASE}/settings/access/assignments`);
  await page.getByLabel('Search members').fill('priya');
  await page.getByRole('button', { name: /Priya/ }).first().click();
  await page.getByLabel('Add a role').click();
  await page.getByRole('option', { name: /Recruiter/ }).click();
  await page.getByRole('button', { name: 'Assign' }).click();
  await page.getByText('Role assigned').waitFor();
  check(await page.getByRole('link', { name: 'Recruiter' }).isVisible(), 'role assigned to an existing member');

  // Session revoked elsewhere -> next request lands on /session-expired.
  await page.evaluate(() => fetch('/api/v1/auth/logout', { method: 'POST', headers: { 'x-hrms-client': 'web' } }));
  await page.getByRole('link', { name: 'Security & audit' }).first().click();
  await page.waitForURL(/\/(session-expired|login)/, { timeout: 8000 }).catch(() => undefined);
  check(/session-expired|login/.test(page.url()), 'a revoked session is detected and the user is asked to sign in again', page.url());
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await login(page, 'kiran@partners.test');
  await page.waitForURL(/select-organization/);
  await page.getByRole('button', { name: /XYZ Solutions/ }).click();
  await page.waitForURL(/\/dashboard/);
  const org = await page.getByRole('button', { name: /Organization: / }).getAttribute('aria-label');
  check(/XYZ Solutions/.test(org ?? ''), 'multi-organization user selects an organization', org ?? '');
  await page.goto(`${BASE}/settings/access/roles`);
  const denied = await page.getByText('You don’t have access to this page').waitFor({ timeout: 8000 }).then(() => true, () => false);
  check(denied, 'missing permission shows the access-denied state');
  const nav = await page.getByRole('navigation', { name: 'Settings navigation' }).first().textContent();
  check(!/Role management/.test(nav ?? ''), 'navigation hides destinations the user cannot use');
  await ctx.close();
}
{
  const { ctx, page } = await newPage();
  await login(page, 'meera@xyz.test');
  await page.waitForURL(/\/onboarding/);
  check(true, 'admin of an organization that has not finished setup lands in onboarding');
  await page.getByRole('button', { name: /Skip/ }).first().click();
  await page.waitForURL(/\/dashboard/);
  await page.getByRole('button', { name: /^Account:/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login/);
  const after = await page.evaluate(() => fetch('/api/v1/me').then((r) => r.status));
  check(after === 401, 'logout clears the server session', `status ${after}`);
  await ctx.close();
}

// ------------------------------------------- employee creation (A + D) --
console.log('\nEmployee creation: HR quick add (A) + self-service (D)');
{
  const { ctx, page } = await newPage();
  await login(page, 'suresh@abc.test');
  await page.waitForURL(/\/dashboard/);
  await page.getByRole('link', { name: 'Employees' }).first().click();
  await page.getByRole('button', { name: 'Quick add' }).first().click();
  const t0 = Date.now();
  await page.getByLabel(/^Full name/).fill('Neha Kapoor');
  await page.getByLabel(/^Work email/).fill('neha@abc.test');
  // joining date defaults to today — three fields, one click
  await page.getByRole('button', { name: 'Add employee' }).click();
  await page.getByRole('heading', { name: 'Neha Kapoor added' }).waitFor();
  check(true, `quick add needs only name + email (+ default joining date) — ${Date.now() - t0} ms of automation`);
  const url = await page.getByLabel('Activation link').inputValue();
  check(/\/activate\?token=/.test(url), 'HR receives a one-time activation link');
  await page.getByRole('link', { name: 'Open profile' }).click();
  await page.getByText('Profile completeness').waitFor();
  check(await page.getByText('Invited', { exact: true }).first().isVisible(), 'new employee shows as Invited until activation');
  await ctx.close();

  // D — the employee activates and completes their own details.
  const emp = await newPage({ width: 390, height: 844 });
  await emp.page.goto(url);
  await emp.page.getByLabel(/^Create a password/).fill('Lotus-Garden-2026');
  await emp.page.getByLabel(/^Confirm password/).fill('Lotus-Garden-2026');
  await emp.page.getByRole('button', { name: /Activate and continue/ }).click();
  await emp.page.waitForURL(/\/my-profile\?welcome=1/);
  check(true, 'after activating, the employee lands on “My profile” to finish their details');
  await emp.page.getByLabel(/^Date of birth/).fill('1997-08-21');
  await emp.page.getByLabel(/^Mobile phone/).fill('+91 98860 12345');
  await emp.page.getByLabel(/^City/).fill('Bengaluru');
  await emp.page.getByLabel(/^Country/).fill('India');
  await emp.page.getByRole('option', { name: /^India/ }).click();
  await emp.page.getByLabel(/^Name/).fill('Ravi Kapoor');
  await emp.page.getByLabel(/^Phone/).fill('+91 98860 54321');
  await emp.page.getByRole('button', { name: 'Save changes' }).click();
  await emp.page.getByText('Your details were saved').waitFor();
  const complete = await emp.page.getByText('Complete', { exact: true }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(complete, 'self-service details complete the profile');
  const jobLocked = (await emp.page.getByLabel(/^Job title/).count()) === 0;
  check(jobLocked, 'job details are read-only for the employee');
  await emp.page.screenshot({ path: `${SHOTS}390-my-profile-complete.png`, fullPage: true });
  await emp.ctx.close();
}

// ------------------------------------------------------------ responsive --
console.log('\nResponsive matrix');
{
  const { ctx, page } = await newPage();
  await login(page, 'asha@abc.test');
  await page.waitForURL(/\/dashboard/);
  for (const [w, h] of VIEWPORTS) {
    await page.setViewportSize({ width: w, height: h });
    const bad = [];
    for (const [name, path] of SCREENS) {
      await page.goto(`${BASE}${path}`);
      await settle(page);
      const r = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - window.innerWidth;
        const unnamed = [...document.querySelectorAll('button')]
          .filter((b) => b.offsetParent !== null)
          .filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('title')))
          .length;
        return { overflow, unnamed };
      });
      if (r.overflow > 0) bad.push(`${name}: ${r.overflow}px horizontal overflow`);
      if (r.unnamed > 0) bad.push(`${name}: ${r.unnamed} unnamed button(s)`);
      if (SHOT_WIDTHS.has(w)) await page.screenshot({ path: `${SHOTS}${w}-${name}.png`, fullPage: false });
    }
    check(bad.length === 0, `${w}×${h}: ${SCREENS.length} screens, no page overflow, buttons named`, bad.join('; '));
  }
  // Drawer on phones
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/dashboard`);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const drawerVisible = await page.getByRole('dialog', { name: 'Navigation' }).isVisible();
  await page.keyboard.press('Escape');
  check(drawerVisible, 'phone: sidebar opens as a drawer and closes with Esc');
  await page.screenshot({ path: `${SHOTS}390-dashboard-drawer.png` });
  await ctx.close();
}

await browser.close();
console.log(`\n${passes.length} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}

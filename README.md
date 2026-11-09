# HRMS — Tenant portal, RBAC, Workflow Engine, Leave Management

Multi-tenant (shared schema + PostgreSQL RLS) HRMS with a React tenant portal.

* **Backend** (repo root): Node.js 20+, Express 4, TypeScript, PostgreSQL 15+ (tested on 16), zod, pg.
  RBAC engine, reusable approval workflow engine, Leave Management, sessions, organization onboarding/profile.
* **Frontend** (`frontend/`): React 19, TypeScript, Tailwind CSS 4, React Router, TanStack Query,
  React Hook Form + zod, lucide icons. Delivers Milestones 1 (foundation & shell), 2 (organization
  onboarding & profile) and 4 (RBAC & permission management).

## Quick start

```bash
npm install
cp .env.example .env     # then edit: ADMIN_DATABASE_URL (your postgres superuser) + JWT_SECRET
npm run db:reset         # creates roles + database, runs migrations, loads the demo data
npm run dev              # API on http://localhost:4000
```

Then the web portal (second terminal):

```bash
npm run web:install      # once
npm run web:dev          # http://localhost:5173 — proxies /api to :4000
```

`npm run db:reset` is a Node script — it works on Windows, macOS and Linux and needs no `psql`.
(`npm run db:reset:bash` is the same thing via psql, if you prefer.)
**Upgrading an existing database?** Use `npm run db:migrate`, not `db:reset`: it applies new migrations and keeps
your data. Migrations `011`–`014` delete the old leave data, so read
[docs/leave-management.md](docs/leave-management.md) first.

Verify with `npm run typecheck` and `npm test` (integration tests against the real database, run one file at a
time). **`npm test` and `db:reset` drop the database named in `DB_NAME`**: point them at a throwaway database
(`DB_NAME`, `DATABASE_URL`, `OUTBOX_DATABASE_URL`, `TEST_ADMIN_DATABASE_URL`), never at one you need. Frontend: `npm run web:test` (Vitest) and,
with both servers running on a freshly reset database, `npm --prefix frontend run test:e2e`
(Playwright: user flows plus every main screen at 320–2560 px checked for horizontal overflow;
screenshots land in `frontend/e2e/screenshots/`).

### Postman

Import both files from `postman/` (Collection and Environment), select the **HRMS local**
environment, then run the folders top to bottom — the login requests in folder 1 capture every
token automatically, and later requests reuse the captured ids.
`npm run db:reset` before a full run: a few requests are one-shot by design (publishing a
workflow version, overlapping leave dates).

Seed users (password `Passw0rd!`): `rahul@abc.test` (employee), `krishna@abc.test`
(manager), `suresh@abc.test` / `anita@abc.test` (HR Admin), `vikram@abc.test`
(Suresh's manager), `asha@abc.test` (Tenant Admin), and tenant 2: `meera@xyz.test` (HR + Tenant Admin;
XYZ has **not** finished onboarding, so she lands in the setup wizard), `arjun@xyz.test`.
`kiran@partners.test` belongs to **both** organizations (exercises organization selection).

```bash
TOKEN=$(curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"rahul@abc.test","password":"Passw0rd!"}' | jq -r .accessToken)
curl -s localhost:4000/api/v1/leave/requests -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d '{"leaveTypeCode":"CL","startDate":"2026-12-03","endDate":"2026-12-07","reason":"Personal work"}'
# -> totalDays: 3 (server-computed, skips the weekend), task assigned to Krishna
```

## Tenant portal (frontend)

| Area | Routes |
|---|---|
| Sign-in | `/login`, `/select-organization` (only for multi-organization accounts), `/activate?token=…`, `/session-expired`, `/unauthorized` |
| Portal | `/dashboard` (only API-backed figures: pending approvals, members, roles, your permissions, setup progress, recent audit) |
| Onboarding | `/onboarding?step=details\|address\|preferences\|branding\|review` |
| Leave: employee | `/leave/dashboard`, `/leave/apply`, `/leave/my-requests?tab=balance\|requests`, `/leave/holidays` |
| Leave: manager | `/leave/team/dashboard`, `/leave/team/requests?tab=pending\|all\|history` |
| Leave: HR | `/leave/admin/dashboard`, `/leave/admin/requests`, `/leave/admin/calendar`, `/leave/admin/reports` |
| Leave: configuration | `/leave/config/types`, `policies`, `holiday-calendars`, `workflows`, `accrual?tab=accrual\|carry\|expiry\|encashment`, `assignments` |
| Settings (own sidebar + back arrow) | `/settings/organization/profile`, `/settings/organization/preferences`, `/settings/organization-chart`, `/settings/access/roles[/new\|/:id\|/:id/permissions]`, `/settings/access/permissions`, `/settings/access/assignments`, `/settings/access/users/:id/permissions`, `/settings/security` |

* Future modules (attendance, payroll, recruitment, performance, training,
  reports) appear only under a collapsed **Coming later** group, disabled and labelled “Soon”.
* Menus and route guards are built from `/me` permissions for UX only; every API call is
  authorized server-side.
* Layout: drawer below 1024 px, fixed sidebar collapsible to an icon rail above it,
  `max-w-workspace` (1600 px) content, slightly larger base font at ≥1920 px; tables turn into
  cards or scroll inside their own container on small screens.

### Employee creation — quick add + self-service

Two halves of one flow:

* **Quick add (HR, `employee.create`)** — only **full name, work email and joining date** are required
  (code, job title, department, manager, employment type and role are optional; the code is
  suggested from the tenant's own pattern, e.g. `E901`). `POST /employees` does everything in
  **one transaction**: creates a passwordless login (or links the existing account for that email),
  adds an `invited` membership, the employee record, the reporting line, role assignments and a
  one-time activation link. Any failure rolls the whole thing back. Invited members can hold roles but
  have no effective permissions until they activate. Someone who is already an active member is just
  linked to the new record and needs no link.
* **Self-service (the employee)** — the activation link (7 days, single use, hashed) lets them set
  a password; they land on **My profile** (`/my-profile`) and fill their own personal, home-address
  and emergency-contact details (`PATCH /me/employee` accepts only those fields). The profile is
  marked complete automatically once date of birth, mobile, city, country and an emergency contact
  are present.
* **HR can still fill anything** (`employee.update`, `PATCH /employees/:id`): job details and the
  self-service fields, with optimistic concurrency. Setting status to `exited` ends portal access
  at once (membership `left`, sessions revoked, open links revoked).
* Every change is in the append-only `employee_audit_log` (shown under Security & audit and on the
  employee page). There is no email delivery yet: HR sees the activation link once and shares it;
  `POST /employees/:id/invitation` issues a new one and voids the old.

### Organization chart

`/settings/organization-chart` draws the hierarchy from `employee_reporting`, so changing a reporting
manager on an employee record is all it takes to change the chart. Nothing is stored for the chart itself.

* **What counts:** only the line in force today (tenant-local date). Ended lines are ignored; a line that
  starts later is shown as "reports to X from <date>" but doesn't place the person yet.
* **Roots and unassigned:** no manager and a team = root (there can be several); no manager and no team =
  the separate *No reporting manager* list.
* **Exited employees** are hidden by default. Anyone still reporting to one is flagged "Manager has left"
  rather than dropped. `status=exited|all` reveals them.
* **Filters** keep the structure honest: the managers between a match and the top stay on the chart as
  dimmed context (`matched: false`), and report counts are always the real ones.
* **Cycles** are rejected on write (`prevent_reporting_cycle`, whole period of the line). If one exists anyway,
  the chart cuts it at the lowest employee id, shows everyone once and flags it for HR.
* **Access:** `organization.chart.view`, separate from `employee.view` so a role can see the chart without
  personal details. The response carries directory fields only: no date of birth, personal email, phone,
  address, emergency contact or login email.

### Sessions (Milestone 1)

* Login creates an `auth_sessions` row; the JWT carries its id (`sid`) and `authenticate()` checks it on
  every request, so **logout, organization switch and session revocation take effect immediately**.
* The SPA sends `X-HRMS-Client: web` and receives the token only as an **HttpOnly, SameSite=Strict
  cookie** (never in the body, never readable by JavaScript). Cookie-authenticated writes must carry
  that header (CSRF guard). Postman/scripts keep getting a bearer token.
* Idle timeout = `ACCESS_TOKEN_TTL_SECONDS` (15 min, sliding for the browser); hard cap
  `SESSION_ABSOLUTE_TTL_HOURS` (12 h).
* **Role changes need no re-login**: permissions are read from the database on every request; the
  SPA also revalidates `/me` on navigation and shows `/session-expired` as soon as the API says the
  session is gone.
* Login, tenant selection and activation are rate-limited in-process (put a shared limiter at the
  gateway when running several instances).

### Organization onboarding (Milestone 2)

New organizations are provisioned by the **platform CLI** (runs as `hrms_owner`; the API role can't create tenants):

```bash
npm run tenant:provision -- --name "Acme Corp" --admin-email ana@acme.test --admin-name "Ana Silva" --country IN
# -> prints a one-time activation link: http://localhost:5173/activate?token=…
npm run tenant:invite -- --slug acme-corp --email ana@acme.test --name "Ana Silva"   # re-issue a link
```

The CLI creates the tenant, its settings, a protected **Tenant Admin** system role and a hashed,
expiring (72 h), single-use invitation. Activating sets the password (or, for an existing account,
confirms the *current* password — an invitation can never overwrite one), joins the organization with
only that bootstrap role, and signs in. The admin then completes the onboarding wizard. Logos are
stored in Postgres (`tenant_assets`, ≤512 KB, PNG/JPEG/WebP verified by magic bytes) behind an
`AssetStorage` interface so S3 can replace it.

## Database roles

| Role | Used by | Notes |
|---|---|---|
| `hrms_owner` | migrations only | owns objects, BYPASSRLS |
| `hrms_app` | the API | NOBYPASSRLS, not owner; append-only tables are SELECT/INSERT only; `leave_balances` has no bucket UPDATE |
| `hrms_worker` | outbox dispatcher | sees `outbox_events` across tenants, nothing else |

## Layout

```
db/migrations/000..005   roles, core, rbac, workflow, first leave implementation (removed by 011), RLS+grants
db/migrations/006        auth_sessions (server-side sessions)
db/migrations/007        organization profile/settings/logo/invitations/audit, organization.* permissions
db/migrations/008        role re-activation audit action
db/migrations/009        employee creation: profile fields, 'invited' memberships, employee invitations, employee audit
db/migrations/010        organization.chart.view permission; reporting-cycle check covers the line's whole period
db/migrations/011        DESTRUCTIVE: removes the first leave implementation and its data
db/migrations/012..014   Leave Management: configuration, requests + ledger, permissions
db/migrations/015        comp off claims approved through the workflow engine (module comp_off)
db/seed/dev_seed.sql     two tenants, Rahul -> Krishna -> Suresh scenario
src/config               env, pg pool + withTenantTx (tenant-local set_config, retry on 40001/40P01)
src/middleware           authenticate (fresh permissions per request), requirePermission, errors
src/modules/rbac         roles, grants, assignments (anti-escalation, lockout guard, audit)
src/modules/workflow     engine, approver resolver, condition evaluator, definitions, delegations
src/modules/leave        requests, ledger, accrual, carry-forward, comp off, configuration, reports (docs/leave-management.md)
src/modules/outbox       transactional outbox + SKIP LOCKED worker
src/modules/auth         login, tenant selection/switch, sessions, logout, /me
src/modules/organization profile, preferences, logo storage, onboarding status
src/modules/onboarding   invitation activation (public) + provisioning (CLI/owner only)
src/modules/employees    quick add (single transaction), HR edit, self-service profile, departments
src/cli/tenant-cli.ts    platform provisioning CLI
src/cli/leave-jobs.ts    scheduled leave jobs: accrual, expiry, carry-forward
scripts/db-migrate.mjs   forward migrations with schema_migrations; dumps before destructive ones
test/                    integration tests (service-level + HTTP-level portal tests)
frontend/                React tenant portal (app/, layouts/, components/, modules/, services/)
```

## API (all under `/api/v1`)

| Method | Path | Permission |
|---|---|---|
| POST | /auth/login | — (409 `TENANT_REQUIRED` + selection token for multi-org accounts) |
| POST | /auth/select-tenant, /auth/switch-tenant, /auth/logout | selection token / authenticated / — |
| GET, DELETE | /auth/sessions[/:sid] | own sessions |
| GET | /me | authenticated (user, organization summary, memberships, permissions, session) |
| GET | /onboarding/invitations/:token · POST /onboarding/activate | invitation token |
| GET, PATCH | /organization | organization.view / organization.update |
| GET, PATCH | /organization/settings | organization.settings.view / .update |
| GET | /organization/chart?departmentId=&managerId=&search=&status= | organization.chart.view |
| GET, POST, DELETE | /organization/logo | member / organization.update |
| GET | /organization/options, /organization/onboarding-status | member |
| POST | /organization/onboarding/complete | organization.update |
| GET | /roles/:id, /roles/:id/members | roles.view |
| POST | /roles/:id/clone, /roles/:id/activate | roles.manage |
| GET | /users?search=&limit=&offset=, /users/:id | roles.view (tenant members only) |
| GET | /users/:id/permissions?include=sources | self, or roles.* |
| GET | /audit-events | roles.* (RBAC events), organization.* (organization events), employee.view (employee events) |
| GET | /employees?search=&departmentId=&access=&status=, /employees/:id | employee.view (own record: any employee) |
| GET | /employees/next-code | employee.create |
| POST | /employees (quick add), /employees/:id/invitation | employee.create (+ roles.assign to set roles) |
| PATCH | /employees/:id | employee.update (any field) |
| GET, PATCH | /me/employee | own record; PATCH = self-service fields only |
| GET, POST | /departments | employee.view / employee.create |
| GET | /permissions, /roles, /roles/:id/permissions, /users/:id/roles | roles.view / manage / assign |
| POST, PUT, DELETE | /roles, /roles/:id | roles.manage |
| PUT | /roles/:id/permissions | roles.manage (+ must hold every granted code) |
| POST, DELETE | /users/:id/roles, /users/:id/roles/:assignmentId | roles.assign (+ must hold the role's codes) |
| GET | /users/:id/permissions | self, or roles.* |
| GET | /workflows/my-tasks, /workflows/tasks/:id | authenticated (own/delegated tasks only) |
| POST | /workflows/tasks/:id/approve \| reject \| return | the **step's** required permission |
| GET | /workflows/instances/:id/history | requester, approvers, workflow.admin, module view-all |
| GET, POST, DELETE | /workflows/delegations | workflow.delegate to create |
| GET | /workflows/definitions[/:id] | workflow.view / configure |
| POST, PUT, DELETE | /workflows/definitions[/:id], /:id/clone, /:id/validate, /:id/publish | workflow.configure |
| | /leave/... | Leave Management: see [docs/leave-management.md](docs/leave-management.md#api) |

## Engine rules worth knowing

* **Lock order** is always `workflow_instance → task / leave_request → leave_balance`.
* **No approver?** `on_no_approver` = `fail` (whole transaction rolls back with 422 — nothing
  is left stuck), `skip`, or `fallback_role` (logged as `escalate`).
* **SoD:** the submitter and the employee the request is for are never assigned and can never act,
  even through delegation.
* **Delegation** is checked at action time; the task stays with the real approver and the log
  records `actor_user_id` + `on_behalf_of_user_id`. Delegates see only *pending* delegated tasks.
* **Conditions** are per step, data-only JSON (`all`/`any`/`not`, `eq…between…in`), validated at
  publish against the module's declared context fields (for leave: days, type, category, employee category, department, manager).
* **Versioning:** publishing archives the old version in the same transaction; running instances
  stay on the version they started with. DB triggers block edits to published versions.

## Adding the next module (attendance, expense …)

1. Add its permissions to the catalog (e.g. `expense.approve`).
2. Create the business table with `workflow_instance_id`, status guard trigger, RLS policy.
3. `registerWorkflowHandler({ module: 'expense', contextSchema: { amount: 'number' }, onApproved, onRejected, onReturned, summarize })`.
4. Call `startWorkflow(tx, tenantId, {...})` in the same transaction that creates the record.

## Known limits / next steps

* Leave Management's limits are listed in [docs/leave-management.md](docs/leave-management.md#known-limits).
* Put helmet and a shared rate limiter in front of the API in production; consider RS256 for tokens.
* No email delivery yet: admin activation links are printed by the CLI; employee links are shown to
  HR once in the portal. The `employee.created` outbox event is the hook for a future mailer.
* A work email cannot be changed after quick add (it is the sign-in identity); bulk import and
  document uploads are not implemented.

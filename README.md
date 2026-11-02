# HRMS — RBAC, Workflow Engine, Leave Management

Multi-tenant (shared schema + PostgreSQL RLS) implementation of the RBAC engine,
a reusable approval workflow engine, and Leave Management as its first module.
Stack: Node.js 20+, Express 4, TypeScript, PostgreSQL 15+ (tested on 16), zod, pg.

## Quick start

```bash
npm install
cp .env.example .env     # then edit: ADMIN_DATABASE_URL (your postgres superuser) + JWT_SECRET
npm run db:reset         # creates roles + database, runs migrations, loads the demo data
npm run dev              # API on http://localhost:4000
```

`npm run db:reset` is a Node script — it works on Windows, macOS and Linux and needs no `psql`.
(`npm run db:reset:bash` is the same thing via psql, if you prefer.)
Verify with `npm run typecheck` and `npm test` (30 integration tests against the real database).

### Postman

Import both files from `postman/` (Collection and Environment), select the **HRMS local**
environment, then run the folders top to bottom — the login requests in folder 1 capture every
token automatically, and later requests reuse the captured ids.
`npm run db:reset` before a full run: a few requests are one-shot by design (publishing a
workflow version, overlapping leave dates).

Seed users (password `Passw0rd!`): `rahul@abc.test` (employee), `krishna@abc.test`
(manager), `suresh@abc.test` / `anita@abc.test` (HR Admin), `vikram@abc.test`
(Suresh's manager), `asha@abc.test` (Tenant Admin), and tenant 2: `meera@xyz.test`, `arjun@xyz.test`.

```bash
TOKEN=$(curl -s localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"rahul@abc.test","password":"Passw0rd!"}' | jq -r .accessToken)
curl -s localhost:4000/api/v1/leave-requests -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "idempotency-key: $(uuidgen)" \
  -d '{"leaveType":"annual","startDate":"2026-11-05","endDate":"2026-11-09","reason":"Personal work"}'
# -> totalDays: 3 (server-computed), task assigned to Krishna
```

## Database roles

| Role | Used by | Notes |
|---|---|---|
| `hrms_owner` | migrations only | owns objects, BYPASSRLS |
| `hrms_app` | the API | NOBYPASSRLS, not owner; append-only tables are SELECT/INSERT only; `leave_balances` has no bucket UPDATE |
| `hrms_worker` | outbox dispatcher | sees `outbox_events` across tenants, nothing else |

## Layout

```
db/migrations/000..005   roles, core, rbac, workflow, leave, RLS+grants
db/seed/dev_seed.sql     two tenants, Rahul -> Krishna -> Suresh scenario
src/config               env, pg pool + withTenantTx (tenant-local set_config, retry on 40001/40P01)
src/middleware           authenticate (fresh permissions per request), requirePermission, errors
src/modules/rbac         roles, grants, assignments (anti-escalation, lockout guard, audit)
src/modules/workflow     engine, approver resolver, condition evaluator, definitions, delegations
src/modules/leave        apply/resubmit/withdraw, day calculation, ledger-based balances, engine hooks
src/modules/outbox       transactional outbox + SKIP LOCKED worker
test/                    integration tests
```

## API (all under `/api/v1`)

| Method | Path | Permission |
|---|---|---|
| POST | /auth/login | — |
| GET | /me | authenticated |
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
| POST | /leave-requests | leave.create (`Idempotency-Key` header supported) |
| GET | /leave-requests?scope=own\|team\|all | leave.view.own / team / all |
| GET | /leave-requests/:id | owner, team manager, approver, or view.all |
| POST | /leave-requests/:id/resubmit, /:id/withdraw | owner (leave.create / leave.withdraw) |
| GET | /leave-balances/me | leave.view.own |
| POST | /leave-balances/allocations | leave.balance.manage |

## Engine rules worth knowing

* **Lock order** is always `workflow_instance → task / leave_request → leave_balance`.
* **No approver?** `on_no_approver` = `fail` (whole transaction rolls back with 422 — nothing
  is left stuck), `skip`, or `fallback_role` (logged as `escalate`).
* **SoD:** the submitter and the employee the request is for are never assigned and can never act,
  even through delegation.
* **Delegation** is checked at action time; the task stays with the real approver and the log
  records `actor_user_id` + `on_behalf_of_user_id`. Delegates see only *pending* delegated tasks.
* **Conditions** are per step, data-only JSON (`all`/`any`/`not`, `eq…between…in`), validated at
  publish against the module's declared context fields (`totalDays`, `leaveTypeCode` for leave).
* **Versioning:** publishing archives the old version in the same transaction; running instances
  stay on the version they started with. DB triggers block edits to published versions.

## Adding the next module (attendance, expense …)

1. Add its permissions to the catalog (e.g. `expense.approve`).
2. Create the business table with `workflow_instance_id`, status guard trigger, RLS policy.
3. `registerWorkflowHandler({ module: 'expense', contextSchema: { amount: 'number' }, onApproved, onRejected, onReturned, summarize })`.
4. Call `startWorkflow(tx, tenantId, {...})` in the same transaction that creates the record.

## Known limits / next steps

* Leave cannot span two leave years (calendar year); fiscal-year periods need a `leave_periods` table.
* Two half-days on the same date are blocked by the overlap constraint.
* Cancelling *approved* leave (`credit` ledger entry) and SLA escalation jobs are prepared in the
  schema but have no endpoint/worker yet.
* Put rate limiting, helmet and a CORS allow-list in front of the API; consider RS256 + refresh tokens.

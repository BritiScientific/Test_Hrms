/**
 * End-to-end integration tests against a real PostgreSQL (RLS on, app role).
 *   ./scripts/reset-db.sh && npm test
 * Services are called exactly the way the HTTP layer calls them:
 * withTenantTx(tenant) -> loadAuthContext(user) -> service(tx, auth, ...).
 *
 * Leave is the module these tests drive the workflow engine through. Dates are in
 * next year so notice periods never interfere, and that year's balances come from
 * the accrual job.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';

import { pool, withTenantTx, type Tx } from '../src/config/db';
import type { AuthContext } from '../src/shared/types';
import { AppError } from '../src/shared/errors';
import { loadAuthContext } from '../src/modules/rbac/rbac.service';
import * as rbac from '../src/modules/rbac/rbac.service';
import * as engine from '../src/modules/workflow/workflow-engine.service';
import * as defs from '../src/modules/workflow/workflow-definition.service';
import * as delegations from '../src/modules/workflow/delegation.service';
import { runAccrual } from '../src/modules/leave/leave-accrual.service';
import * as leave from '../src/modules/leave/leave-request.service';
import { listBalances } from '../src/modules/leave/leave-balance.service';
import { registerLeaveWorkflow } from '../src/modules/leave/leave.workflow-handler';

// Superuser pool ON THE APP DATABASE, used to assert on rows RLS would hide.
// Distinct from ADMIN_DATABASE_URL, which db-reset.mjs points at `postgres`.
const admin = new pg.Pool({
  connectionString: process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5432/hrms',
});
const T1 = 1;
const T2 = 2;
const ids: Record<string, number> = {};
const emp: Record<string, number> = {};
const Y = new Date().getFullYear() + 1;

/** Date in test year Y: `week` weeks after the first Monday in February, `dow` 0 = Monday .. 4 = Friday. */
function day(week: number, dow = 0): string {
  const d = new Date(Date.UTC(Y, 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + week * 7 + dow);
  return d.toISOString().slice(0, 10);
}

async function as<T>(tenant: number, who: string, fn: (tx: Tx, auth: AuthContext) => Promise<T>): Promise<T> {
  return withTenantTx(tenant, async (tx) => {
    const auth = await loadAuthContext(tx, tenant, ids[who]);
    assert.ok(auth, `${who} has no active membership in tenant ${tenant}`);
    return fn(tx, auth);
  });
}

async function expectError(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (e: any) {
    if (e instanceof AppError) {
      assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
      if (status) assert.equal(e.status, status);
      return e;
    }
    if (e?.code && code.startsWith('PG:')) {
      assert.equal(e.code, code.slice(3), `expected SQLSTATE ${code}, got ${e.code}: ${e.message}`);
      return e;
    }
    throw e;
  }
  assert.fail(`expected error ${code}`);
}

const myTasks = (who: string, tenant = T1) => as(tenant, who, (tx, a) => engine.listMyTasks(tx, a));
const taskFor = async (who: string, entityId: number) => {
  const t = (await myTasks(who)).find((x: any) => x.entity_id === entityId);
  assert.ok(t, `${who} has no task for leave ${entityId}`);
  return t.task_id as number;
};
const balance = async (who: string, code = 'EL') => {
  const rows = await as(T1, who, (tx, a) => listBalances(tx, a.employeeId!, Y));
  return rows.find((r: any) => r.leave_type_code === code);
};
const apply = (who: string, startDate: string, endDate: string, extra: Partial<leave.ApplyLeaveInput> = {}, tenant = T1) =>
  as(tenant, who, (tx, a) => leave.applyLeave(tx, a, {
    leaveTypeCode: tenant === T1 ? 'EL' : 'AL', startDate, endDate, reason: 'test', ...extra,
  }));
const act = (who: string, taskId: number, action: engine.TaskAction, comments?: string, tenant = T1) =>
  as(tenant, who, (tx, a) => engine.actOnTask(tx, a, taskId, action, comments));

before(async () => {
  // Cross-platform reset (same script npm run db:reset uses).
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'db-reset.mjs')], { stdio: 'ignore' });
  registerLeaveWorkflow();
  const u = await admin.query(`SELECT id, split_part(email, '@', 1) AS n FROM users`);
  for (const r of u.rows) ids[r.n] = Number(r.id);
  const e = await admin.query(`SELECT e.id, split_part(u.email, '@', 1) AS n FROM employees e JOIN users u ON u.id = e.user_id`);
  for (const r of e.rows) emp[r.n] = Number(r.id);
  for (const t of [T1, T2]) await withTenantTx(t, (tx) => runAccrual(tx, t, { asOf: `${Y}-12-31` }));
});

after(async () => {
  await pool.end();
  await admin.end();
});

describe('Rahul -> Krishna -> HR happy path', () => {
  let leaveId: number;

  test('server computes working days (Thursday to Monday spans a weekend = 3)', async () => {
    const { request } = await apply('rahul', day(0, 3), day(1, 0));
    leaveId = request.id;
    assert.equal(request.total_days, 3);
    assert.equal(request.status, 'pending');
    const b = await balance('rahul');
    assert.deepEqual([b.accrued, b.used, b.pending, b.available], [18, 0, 3, 15]);
  });

  test('task is assigned to Krishna (USER id resolved through the EMPLOYEE hierarchy)', async () => {
    const tasks = await myTasks('krishna');
    const t = tasks.find((x: any) => x.entity_id === leaveId);
    assert.ok(t);
    assert.equal(t.assigned_to, ids.krishna);
    assert.equal(t.step_name, 'Manager Approval');
    assert.equal((t.summary as any).total_days, 3);
  });

  test('another user cannot act on the task by guessing its id (404, not 403)', async () => {
    const taskId = await taskFor('krishna', leaveId);
    await expectError(act('priya', taskId, 'approve'), 'NOT_FOUND', 404);
    await expectError(act('suresh', taskId, 'approve'), 'NOT_FOUND', 404);
  });

  test('tenant 2 cannot see or act on tenant 1 data (RLS)', async () => {
    const taskId = await taskFor('krishna', leaveId);
    await expectError(act('meera', taskId, 'approve', undefined, T2), 'NOT_FOUND', 404);
    await expectError(as(T2, 'meera', (tx, a) => leave.getLeaveRequest(tx, a, leaveId)), 'NOT_FOUND', 404);
  });

  test('Krishna approves -> HR step creates a task for every eligible HR Admin', async () => {
    const taskId = await taskFor('krishna', leaveId);
    const r = await act('krishna', taskId, 'approve', 'Approved by manager');
    assert.equal(r.instance.status, 'pending');
    assert.equal(r.instance.currentStepOrder, 2);
    await taskFor('suresh', leaveId);
    await taskFor('anita', leaveId);
  });

  test('intermediate approval does not deduct: the days stay held', async () => {
    const b = await balance('rahul');
    assert.deepEqual([b.used, b.pending, b.available], [0, 3, 15]);
  });

  test('replaying the same approval is rejected (no double advance)', async () => {
    const rows = await admin.query(`SELECT id FROM workflow_tasks WHERE assigned_to = $1 AND status = 'approved'`, [ids.krishna]);
    await expectError(act('krishna', Number(rows.rows[0].id), 'approve'), 'TASK_ALREADY_ACTED', 409);
  });

  test('two HR admins approving at the same moment: exactly one wins', async () => {
    const [ts, ta] = [await taskFor('suresh', leaveId), await taskFor('anita', leaveId)];
    const results = await Promise.allSettled([act('suresh', ts, 'approve', 'ok'), act('anita', ta, 'approve', 'ok')]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad.length, 1);
    assert.ok(['TASK_ALREADY_ACTED', 'INSTANCE_NOT_PENDING'].includes(bad[0].reason.code), bad[0].reason.code);
  });

  test('final approval deducts once: hold, release and consumption in the ledger, no drift', async () => {
    const req = await as(T1, 'rahul', (tx, a) => leave.getLeaveRequest(tx, a, leaveId));
    assert.equal(req.status, 'approved');
    const b = await balance('rahul');
    assert.deepEqual([b.used, b.pending, b.available], [3, 0, 15]);
    const l = await admin.query(
      `SELECT txn_type FROM leave_balance_transactions WHERE leave_request_id = $1 ORDER BY id`, [leaveId]);
    assert.deepEqual(l.rows.map((x) => x.txn_type), ['LEAVE_HOLD', 'LEAVE_HOLD_RELEASE', 'LEAVE_CONSUMPTION']);
    const actions = req.workflow!.history.map((h: any) => h.action);
    assert.deepEqual(actions, ['submit', 'approve', 'approve', 'complete']);
  });

  test('overlapping leave is rejected with a clear error', async () => {
    await expectError(apply('rahul', day(1, 0), day(1, 1)), 'OVERLAPPING_REQUEST', 422);
  });
});

describe('Separation of duties', () => {
  test("HR Admin's own leave: manager step goes to HIS manager, HR step excludes him", async () => {
    const { request } = await apply('suresh', day(2), day(2));
    const t1 = await taskFor('vikram', request.id);
    assert.equal((await myTasks('suresh')).filter((t: any) => t.entity_id === request.id).length, 0);
    await act('vikram', t1, 'approve');
    await taskFor('anita', request.id);
    assert.equal((await myTasks('suresh')).filter((t: any) => t.entity_id === request.id).length, 0);
    const n = await admin.query(`SELECT count(*)::int n FROM workflow_tasks t JOIN workflow_instances i ON i.id = t.workflow_instance_id
                                  WHERE i.entity_id = $1 AND t.assigned_to = $2`, [request.id, ids.suresh]);
    assert.equal(n.rows[0].n, 0);
  });

  test('sole HR in tenant 2 applying: no eligible approver -> 422 and nothing persisted', async () => {
    await expectError(apply('meera', day(2), day(2), {}, T2), 'NO_ELIGIBLE_APPROVER', 422);
    const r = await admin.query(`SELECT count(*)::int n FROM leave_requests WHERE employee_id = $1`, [emp.meera]);
    assert.equal(r.rows[0].n, 0);
    const b = await admin.query(`SELECT pending FROM leave_balances WHERE employee_id = $1 AND leave_year = $2`, [emp.meera, Y]);
    assert.equal(Number(b.rows[0].pending), 0);
  });
});

describe('Balance holds under concurrency', () => {
  test('two concurrent requests cannot overdraw (10 + 10 days > 18)', async () => {
    const results = await Promise.allSettled([
      apply('priya', day(3), day(4, 4)),
      apply('priya', day(5), day(6, 4)),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(ok.length, 1);
    assert.equal(bad[0].reason.code, 'INSUFFICIENT_BALANCE');
    const b = await balance('priya');
    assert.ok(b.available >= 0);
  });

  test('reject needs a comment and releases the hold', async () => {
    const pending = await as(T1, 'priya', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'own', status: 'pending' }));
    const id = pending.items[0].id;
    const t = await taskFor('krishna', id);
    await expectError(act('krishna', t, 'reject'), 'COMMENT_REQUIRED', 422);
    await act('krishna', t, 'reject', 'Release freeze that month');
    const b = await balance('priya');
    assert.deepEqual([b.pending, b.used, b.available], [0, 0, 18]);
  });
});

describe('Return, resubmit, delegation', () => {
  let id: number;

  test('return keeps the hold; resubmit starts cycle 2', async () => {
    ({ request: { id } } = await apply('priya', day(7, 2), day(7, 3)));
    const t = await taskFor('krishna', id);
    await act('krishna', t, 'return', 'Please add handover details');
    let req = await as(T1, 'priya', (tx, a) => leave.getLeaveRequest(tx, a, id));
    assert.equal(req.status, 'returned');
    assert.equal((await balance('priya')).pending, 2);

    await expectError(act('krishna', t, 'approve'), 'TASK_ALREADY_ACTED', 409);
    req = await as(T1, 'priya', (tx, a) => leave.resubmitLeave(tx, a, id, { reason: 'Handover to Rahul' }));
    assert.equal(req.status, 'pending');
    assert.equal(req.workflow!.instance.cycle, 2);
  });

  test('delegate acts on behalf of the approver; audit records both', async () => {
    const now = new Date();
    await as(T1, 'krishna', (tx, a) => delegations.createDelegation(tx, a, {
      delegateUserId: ids.vikram, module: 'leave',
      from: new Date(now.getTime() - 60000).toISOString(),
      to: new Date(now.getTime() + 7 * 86400000).toISOString(),
    }));
    const t = await taskFor('vikram', id); // shows up in Vikram's inbox via delegation
    await act('vikram', t, 'approve', 'On behalf of Krishna');
    const log = await admin.query(
      `SELECT actor_user_id, on_behalf_of_user_id FROM workflow_action_logs WHERE workflow_task_id = $1`, [t]);
    assert.equal(Number(log.rows[0].actor_user_id), ids.vikram);
    assert.equal(Number(log.rows[0].on_behalf_of_user_id), ids.krishna);
  });

  test('delegating to the requester does not allow self-approval', async () => {
    const { request } = await apply('rahul', day(8, 2), day(8, 2));
    const now = new Date();
    await as(T1, 'krishna', (tx, a) => delegations.createDelegation(tx, a, {
      delegateUserId: ids.rahul, module: null,
      from: new Date(now.getTime() - 60000).toISOString(),
      to: new Date(now.getTime() + 86400000).toISOString(),
    }));
    const t = (await myTasks('krishna')).find((x: any) => x.entity_id === request.id)!.task_id;
    await expectError(act('rahul', t, 'approve'), 'SELF_APPROVAL', 403);
    // and it never appears in Rahul's inbox
    assert.equal((await myTasks('rahul')).filter((x: any) => x.entity_id === request.id).length, 0);
  });

  test('withdraw cancels open tasks and releases the hold', async () => {
    const own = await as(T1, 'rahul', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'own', status: 'pending' }));
    const target = own.items[0];
    const before = (await balance('rahul')).pending;
    const req = await as(T1, 'rahul', (tx, a) => leave.withdrawLeave(tx, a, target.id, 'Plans changed'));
    assert.equal(req.status, 'withdrawn');
    assert.equal((await balance('rahul')).pending, before - target.total_days);
    const open = await admin.query(
      `SELECT count(*)::int n FROM workflow_tasks t JOIN workflow_instances i ON i.id = t.workflow_instance_id
        WHERE i.entity_id = $1 AND t.status = 'pending'`, [target.id]);
    assert.equal(open.rows[0].n, 0);
  });
});

describe('RBAC hardening', () => {
  test('cannot grant a permission you do not hold', async () => {
    const roles = await as(T1, 'suresh', (tx) => rbac.listRoles(tx));
    const hr = roles.find((r: any) => r.name === 'HR Admin');
    await expectError(
      as(T1, 'suresh', (tx, a) => rbac.setRolePermissions(tx, a, hr.id, [...hr.permissions, 'payroll.process'])),
      'PRIVILEGE_ESCALATION', 403);
  });

  test('cannot assign yourself a more powerful role', async () => {
    const roles = await as(T1, 'suresh', (tx) => rbac.listRoles(tx));
    const admin_ = roles.find((r: any) => r.name === 'Tenant Admin');
    await expectError(
      as(T1, 'suresh', (tx, a) => rbac.assignRole(tx, a, { userId: ids.suresh, roleId: admin_.id })),
      'PRIVILEGE_ESCALATION', 403);
  });

  test('system roles are immutable', async () => {
    const roles = await as(T1, 'asha', (tx) => rbac.listRoles(tx));
    const admin_ = roles.find((r: any) => r.name === 'Tenant Admin');
    await expectError(as(T1, 'asha', (tx, a) => rbac.setRolePermissions(tx, a, admin_.id, [])), 'SYSTEM_ROLE', 403);
  });

  test('lockout protection: last holder of roles.manage cannot be removed', async () => {
    const roles = await as(T1, 'asha', (tx) => rbac.listRoles(tx));
    const hr = roles.find((r: any) => r.name === 'HR Admin');
    const withoutManage = hr.permissions.filter((p: string) => p !== 'roles.manage');
    await as(T1, 'asha', (tx, a) => rbac.setRolePermissions(tx, a, hr.id, withoutManage));
    const ashaRoles = await as(T1, 'asha', (tx) => rbac.listUserRoles(tx, ids.asha));
    const adminAssignment = ashaRoles.find((r: any) => r.role_name === 'Tenant Admin');
    await expectError(as(T1, 'asha', (tx, a) => rbac.revokeRole(tx, a, ids.asha, adminAssignment.id)), 'LOCKOUT', 409);
    await as(T1, 'asha', (tx, a) => rbac.setRolePermissions(tx, a, hr.id, hr.permissions)); // restore
  });

  test('revocation takes effect on the next request; new tasks escalate to the fallback role', async () => {
    const { request } = await apply('rahul', day(9, 3), day(9, 3));
    const t = await taskFor('krishna', request.id);
    const roles = await as(T1, 'asha', (tx) => rbac.listUserRoles(tx, ids.krishna));
    const mgr = roles.find((r: any) => r.role_name === 'Manager' && !r.revoked_at);
    await as(T1, 'asha', (tx, a) => rbac.revokeRole(tx, a, ids.krishna, mgr.id));

    await expectError(act('krishna', t, 'approve'), 'MISSING_PERMISSION', 403);

    const { request: r2 } = await apply('rahul', day(9, 4), day(9, 4));
    await taskFor('suresh', r2.id); // reporting manager ineligible -> fallback HR role
    const esc = await admin.query(
      `SELECT count(*)::int n FROM workflow_action_logs l JOIN workflow_instances i ON i.id = l.workflow_instance_id
        WHERE i.entity_id = $1 AND l.action = 'escalate'`, [r2.id]);
    assert.equal(esc.rows[0].n, 1);

    const mgrRole = (await as(T1, 'asha', (tx) => rbac.listRoles(tx))).find((r: any) => r.name === 'Manager');
    await as(T1, 'asha', (tx, a) => rbac.assignRole(tx, a, { userId: ids.krishna, roleId: mgrRole.id })); // re-grant works
    await act('krishna', t, 'approve');
  });

  test('reject and return need their own permissions, even through the generic task endpoints', async () => {
    const { request } = await apply('rahul', day(10), day(10));
    const t = await taskFor('krishna', request.id);
    const mgrRole = (await as(T1, 'asha', (tx) => rbac.listRoles(tx))).find((r: any) => r.name === 'Manager');
    const without = mgrRole.permissions.filter((p: string) => p !== 'leave.request.reject');
    await as(T1, 'asha', (tx, a) => rbac.setRolePermissions(tx, a, mgrRole.id, without));
    await expectError(act('krishna', t, 'reject', 'no'), 'MISSING_PERMISSION', 403);
    await as(T1, 'asha', (tx, a) => rbac.setRolePermissions(tx, a, mgrRole.id, mgrRole.permissions));
    await act('krishna', t, 'reject', 'Busy week');
  });

  test('every RBAC change is audited', async () => {
    const r = await admin.query(`SELECT action FROM rbac_audit_log ORDER BY id`);
    assert.ok(r.rows.map((x) => x.action).includes('user_role.revoke'));
    assert.ok(r.rows.map((x) => x.action).includes('role.permissions.set'));
  });
});

describe('Workflow configuration & versioning', () => {
  test('invalid condition fields are rejected at publish', async () => {
    const list = await as(T1, 'asha', (tx) => defs.listDefinitions(tx, 'leave'));
    const draft = await as(T1, 'asha', (tx, a) => defs.cloneToDraft(tx, a, list[0].id));
    const steps = draft.steps.map((s: any) => ({
      name: s.name, approverType: s.approver_type, approverRoleId: s.approver_role_id,
      requiredPermission: s.required_permission_code, onNoApprover: s.on_no_approver,
      fallbackRoleId: s.fallback_role_id, slaHours: s.sla_hours,
    }));
    steps[1].condition = { field: 'salary', op: 'gt', value: 1 };
    await as(T1, 'asha', (tx, a) => defs.updateDraft(tx, a, draft.id, { name: draft.name, steps }));
    const err: any = await expectError(as(T1, 'asha', (tx, a) => defs.publish(tx, a, draft.id)), 'INVALID_WORKFLOW', 422);
    assert.match(JSON.stringify(err.details), /unknown field \\"salary\\"/, JSON.stringify(err.details));

    // v2: HR approval only for leave longer than 2 days
    steps[1].condition = { field: 'totalDays', op: 'gt', value: 2 };
    await as(T1, 'asha', (tx, a) => defs.updateDraft(tx, a, draft.id, { name: draft.name, steps }));
    const pub = await as(T1, 'asha', (tx, a) => defs.publish(tx, a, draft.id));
    assert.equal(pub.status, 'published');
    assert.equal(pub.version, 2);
  });

  test('new requests use v2 (1-day leave skips HR); in-flight requests stay on v1', async () => {
    const { request } = await apply('priya', day(11), day(11));
    const t = await taskFor('krishna', request.id);
    const r = await act('krishna', t, 'approve');
    assert.equal(r.instance.status, 'approved');

    // Suresh's own leave from earlier is still on v1 and still needs HR.
    const suresh = await as(T1, 'suresh', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'own', status: 'pending' }));
    const ta = await taskFor('anita', suresh.items[0].id);
    const r2 = await act('anita', ta, 'approve');
    assert.equal(r2.instance.status, 'approved');
  });

  test('conditions can use leave type, employee category and department', async () => {
    const list = await as(T1, 'asha', (tx) => defs.listDefinitions(tx, 'leave'));
    const published = list.find((d: any) => d.status === 'published');
    const draft = await as(T1, 'asha', (tx, a) => defs.cloneToDraft(tx, a, published.id));
    const steps = draft.steps.map((s: any) => ({
      name: s.name, approverType: s.approver_type, approverRoleId: s.approver_role_id,
      requiredPermission: s.required_permission_code, onNoApprover: s.on_no_approver,
      fallbackRoleId: s.fallback_role_id, slaHours: s.sla_hours,
    }));
    // HR step only for Sick Leave by a full-time employee in Engineering.
    steps[1].condition = { all: [
      { field: 'leaveTypeCode', op: 'eq', value: 'SL' },
      { field: 'employmentType', op: 'eq', value: 'full_time' },
      { field: 'departmentName', op: 'eq', value: 'Engineering' },
    ] };
    await as(T1, 'asha', (tx, a) => defs.updateDraft(tx, a, draft.id, { name: draft.name, steps }));
    await as(T1, 'asha', (tx, a) => defs.publish(tx, a, draft.id));

    const el = await apply('priya', day(12), day(12));
    const elDone = await act('krishna', await taskFor('krishna', el.request.id), 'approve');
    assert.equal(elDone.instance.status, 'approved', 'Earned Leave skips the HR step');

    const sl = await apply('priya', day(13), day(13), { leaveTypeCode: 'SL' });
    const slNext = await act('krishna', await taskFor('krishna', sl.request.id), 'approve');
    assert.equal(slNext.instance.status, 'pending', 'Sick Leave still goes to HR');
    assert.equal(slNext.instance.currentStepOrder, 2);
  });

  test('published definitions and audit rows are immutable even for direct SQL as the app role', async () => {
    await expectError(withTenantTx(T1, (tx) => tx.query(`DELETE FROM workflow_steps`)), 'PG:23514');
    await expectError(withTenantTx(T1, (tx) => tx.query(`DELETE FROM workflow_action_logs`)), 'PG:42501');
    await expectError(withTenantTx(T1, (tx) => tx.query(`UPDATE leave_balances SET used = 0`)), 'PG:42501');
  });

  test('reporting cycles are rejected', async () => {
    await expectError(withTenantTx(T1, (tx) => tx.query(
      `INSERT INTO employee_reporting (tenant_id, employee_id, manager_id, effective_from) VALUES ($1, $2, $3, '2024-01-01')`,
      [T1, emp.vikram, emp.rahul])), 'PG:23514');
  });
});

describe('Data scope', () => {
  test('manager sees team (incl. indirect), employee sees only own, HR sees all', async () => {
    const team = await as(T1, 'suresh', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'team', limit: 100 }));
    const names = new Set(team.items.map((r: any) => r.employee_name));
    assert.ok(names.has('Rahul') && names.has('Priya')); // indirect via Krishna
    assert.ok(!names.has('Suresh'));
    const rahulTeam = await as(T1, 'rahul', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'team' }));
    assert.equal(rahulTeam.total, 0, 'someone with no reports and no tasks has no team requests');
    const priyaLeave = (await as(T1, 'priya', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'own' }))).items[0];
    await expectError(as(T1, 'rahul', (tx, a) => leave.getLeaveRequest(tx, a, priyaLeave.id)), 'NOT_FOUND', 404);
    const all = await as(T1, 'anita', (tx, a) => leave.listLeaveRequests(tx, a, { scope: 'all', limit: 100 }));
    assert.ok(all.total >= team.total);
  });

  test('idempotency key replays the original request', async () => {
    const key = '6f1c9a2e-8a43-4b7e-9d55-1f0d6c7b2a10';
    const a = await apply('rahul', day(14), day(14), { idempotencyKey: key });
    const b = await apply('rahul', day(14), day(14), { idempotencyKey: key });
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(a.request.id, b.request.id);
  });

  test('ledger and balance projection never drift', async () => {
    const r = await withTenantTx(T1, (tx) => tx.query(`SELECT * FROM v_leave_balance_drift`));
    assert.equal(r.rowCount, 0);
  });
});

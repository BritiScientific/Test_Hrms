/** Hierarchy rules of the organization chart, on plain rows (no database). */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrganizationChart, type ChartNode, type ChartRow } from '../src/modules/organization/organization-chart.service';

function row(id: number, managerId: number | null, extra: Partial<ChartRow> = {}): ChartRow {
  return {
    id, employee_code: `E${id}`, full_name: `Person ${id}`, job_title: `Title ${id}`,
    department_id: null, department_name: null, status: 'active', employment_type: 'full_time',
    work_location: null, date_of_joining: null, manager_id: managerId, manager_name: null, manager_title: null,
    manager_status: managerId === null ? null : 'active',
    upcoming_manager_id: null, upcoming_manager_name: null, upcoming_from: null,
    ...extra,
  };
}

const ids = (nodes: ChartNode[]) => nodes.map((n) => n.id);
function flatten(nodes: ChartNode[]): ChartNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
const sortedIds = (nodes: ChartNode[]) => ids(flatten(nodes)).sort((a, b) => a - b);

describe('hierarchy', () => {
  test('nests reports under their manager with direct and total counts', () => {
    const c = buildOrganizationChart([row(1, null), row(2, 1), row(3, 1), row(4, 2), row(5, 4)]);
    assert.deepEqual(ids(c.roots), [1]);
    assert.deepEqual(ids(c.roots[0].children), [2, 3]);
    assert.deepEqual(ids(c.roots[0].children[0].children), [4]);
    assert.deepEqual(ids(c.roots[0].children[0].children[0].children), [5]);
    assert.equal(c.roots[0].directReportCount, 2);
    assert.equal(c.roots[0].totalReportCount, 4);
    assert.equal(c.roots[0].children[0].totalReportCount, 2);
    assert.equal(c.summary.employees, 5);
  });

  test('supports several independent top-level employees', () => {
    const c = buildOrganizationChart([row(1, null), row(2, 1), row(3, null), row(4, 3)]);
    assert.deepEqual(ids(c.roots), [1, 3]);
  });

  test('a person with no manager and no reports is unassigned, not a root', () => {
    const c = buildOrganizationChart([row(1, null), row(2, 1), row(3, null)]);
    assert.deepEqual(ids(c.roots), [1]);
    assert.deepEqual(ids(c.unassigned), [3]);
    assert.equal(c.summary.unassigned, 1);
  });

  test('an empty organization is an empty chart', () => {
    const c = buildOrganizationChart([]);
    assert.deepEqual(c.roots, []);
    assert.deepEqual(c.unassigned, []);
    assert.equal(c.summary.employees, 0);
  });

  test('every employee appears exactly once', () => {
    const c = buildOrganizationChart([row(1, null), row(2, 1), row(3, 1), row(4, 3), row(5, null), row(6, 99)]);
    assert.deepEqual(sortedIds([...c.roots, ...c.unassigned]), [1, 2, 3, 4, 5, 6]);
  });

  test('handles a very long reporting chain without recursion limits', () => {
    const rows = Array.from({ length: 50_000 }, (_, i) => row(i + 1, i === 0 ? null : i));
    const c = buildOrganizationChart(rows);
    assert.equal(c.roots[0].totalReportCount, 49_999);
  });

  test('stays fast for a large organization', () => {
    // 5,000 people under one manager is the worst shape for building child lists.
    const rows = [row(1, null), ...Array.from({ length: 5_000 }, (_, i) => row(i + 2, 1))];
    const started = Date.now();
    const c = buildOrganizationChart(rows);
    assert.equal(c.roots[0].directReportCount, 5_000);
    assert.ok(Date.now() - started < 1_000, 'built in under a second');
  });
});

describe('invalid reporting data', () => {
  test('a two-person cycle is cut once, at the lowest id', () => {
    const c = buildOrganizationChart([row(1, 2), row(2, 1)]);
    assert.deepEqual(ids(c.roots), [1]);
    assert.equal(c.roots[0].issue, 'cycle');
    assert.deepEqual(ids(c.roots[0].children), [2]);
    assert.equal(c.roots[0].children[0].issue, null);
    assert.equal(c.summary.issues.cycle, 1);
  });

  test('people hanging off a cycle stay attached, and nobody is duplicated', () => {
    const c = buildOrganizationChart([row(1, 3), row(2, 1), row(3, 2), row(4, 2), row(5, 4)]);
    assert.deepEqual(ids(c.roots), [1]);
    assert.deepEqual(sortedIds(c.roots), [1, 2, 3, 4, 5]);
  });

  test('two separate cycles are each cut', () => {
    const c = buildOrganizationChart([row(1, 2), row(2, 1), row(3, 4), row(4, 3)]);
    assert.deepEqual(ids(c.roots), [1, 3]);
    assert.equal(c.summary.issues.cycle, 2);
  });

  test('a self-reference is ignored and flagged', () => {
    const c = buildOrganizationChart([row(1, 1)]);
    assert.deepEqual(ids(c.unassigned), [1]);
    assert.equal(c.unassigned[0].issue, 'cycle');
  });

  test('a manager outside the data does not lose the employee', () => {
    const c = buildOrganizationChart([row(1, 99), row(2, 98, { manager_status: 'exited' }), row(3, 2)]);
    assert.deepEqual(ids(c.unassigned), [1]);
    assert.equal(c.unassigned[0].issue, 'manager_missing');
    assert.deepEqual(ids(c.roots), [2]);
    assert.equal(c.roots[0].issue, 'manager_exited');
    assert.deepEqual(ids(c.roots[0].children), [3]);
  });

  test('filters on cyclic data still terminate', () => {
    // 1 -> 2 -> 3 -> 1 is cut at 1, which leaves 1 > 3 > 2.
    const rows = [row(1, 2), row(2, 3), row(3, 1)];
    assert.deepEqual(ids(flatten(buildOrganizationChart(rows, { managerId: 1 }).roots)), [1, 3, 2]);
    assert.deepEqual(ids(flatten(buildOrganizationChart(rows, { managerId: 2 }).roots)), [2]);
  });
});

describe('filters', () => {
  const rows = [
    row(1, null, { department_id: 10, department_name: 'Eng' }),
    row(2, 1, { department_id: 20, department_name: 'HR' }),
    row(3, 2, { department_id: 10, department_name: 'Eng', job_title: 'Platform Lead' }),
    row(4, 3, { department_id: 10, department_name: 'Eng', status: 'on_notice' }),
    row(5, 1, { department_id: 20, department_name: 'HR' }),
    row(6, null, { department_id: 20, department_name: 'HR' }),
  ];

  test('department: keeps the managers in between as context, with real counts', () => {
    const c = buildOrganizationChart(rows, { departmentId: 10 });
    assert.equal(c.summary.employees, 3);
    assert.deepEqual(ids(c.roots), [1]);
    const hr = c.roots[0].children[0];
    assert.equal(hr.id, 2);
    assert.equal(hr.matched, false);
    assert.equal(hr.children[0].matched, true);
    assert.equal(c.roots[0].directReportCount, 2, 'counts are not reduced by the filter');
    assert.deepEqual(ids(c.roots[0].children), [2], 'non-matching siblings are hidden');
    assert.deepEqual(c.unassigned, []);
  });

  test('manager: only that branch, even if the manager is deep in the tree', () => {
    const c = buildOrganizationChart(rows, { managerId: 2 });
    assert.deepEqual(ids(c.roots), [2]);
    assert.deepEqual(ids(flatten(c.roots)), [2, 3, 4]);
    assert.deepEqual(c.unassigned, []);
  });

  test('manager + department combine', () => {
    const c = buildOrganizationChart(rows, { managerId: 1, departmentId: 20 });
    assert.deepEqual(ids(flatten(c.roots)), [1, 2, 5]);
    assert.equal(c.roots[0].matched, false);
  });

  test('a selected manager with no reports is shown as a root', () => {
    const c = buildOrganizationChart(rows, { managerId: 5 });
    assert.deepEqual(ids(c.roots), [5]);
  });

  test('an unknown manager gives an empty chart', () => {
    const c = buildOrganizationChart(rows, { managerId: 404 });
    assert.deepEqual(c.roots, []);
    assert.deepEqual(c.unassigned, []);
    assert.equal(c.summary.employees, 0);
  });

  test('search covers name, employee number and job title, ignoring case', () => {
    assert.deepEqual(ids(buildOrganizationChart(rows, { search: 'person 6' }).unassigned), [6]);
    assert.equal(buildOrganizationChart(rows, { search: 'e5' }).summary.employees, 1);
    const byTitle = buildOrganizationChart(rows, { search: 'platform' });
    assert.equal(byTitle.summary.employees, 1);
    assert.deepEqual(ids(flatten(byTitle.roots)), [1, 2, 3]);
  });

  test('search treats wildcard characters literally', () => {
    assert.equal(buildOrganizationChart(rows, { search: '%' }).summary.employees, 0);
  });

  test('status: active hides people on notice but keeps them as context for their team', () => {
    const c = buildOrganizationChart([row(1, null, { status: 'on_notice' }), row(2, 1)], { status: 'active' });
    assert.equal(c.summary.employees, 1);
    assert.equal(c.roots[0].id, 1);
    assert.equal(c.roots[0].matched, false);
  });

  test('manager options ignore the active filters', () => {
    const c = buildOrganizationChart(rows, { departmentId: 10 });
    assert.deepEqual(c.managers.map((m) => m.id), [1, 2, 3]);
    assert.equal(c.managers[0].directReportCount, 2);
  });
});

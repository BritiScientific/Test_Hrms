import type { Tx } from '../../config/db';

/**
 * Organization chart: a read model over employees + employee_reporting, so it
 * follows every reporting-manager change with nothing to keep in sync.
 *
 * A fixed number of queries regardless of tenant size (no N+1); the hierarchy is
 * built in memory with loops over parent links, so bad data can't recurse forever.
 * Only directory-level fields leave this module: no date of birth, personal
 * email, phone, address or emergency contact.
 */

export const CHART_STATUSES = ['current', 'active', 'on_notice', 'exited', 'all'] as const;
export type ChartStatus = (typeof CHART_STATUSES)[number];

export interface ChartQuery {
  departmentId?: number;
  managerId?: number;
  search?: string;
  status?: ChartStatus;
}

/** Why a top-level employee is there although a reporting line exists. */
export type ChartIssue = 'cycle' | 'manager_exited' | 'manager_missing';

export interface ChartRow {
  id: number;
  employee_code: string;
  full_name: string;
  job_title: string | null;
  department_id: number | null;
  department_name: string | null;
  status: string;
  employment_type: string;
  work_location: string | null;
  date_of_joining: string | null;
  manager_id: number | null;
  manager_name: string | null;
  manager_title: string | null;
  manager_status: string | null;
  upcoming_manager_id: number | null;
  upcoming_manager_name: string | null;
  upcoming_from: string | null;
}

export interface ChartNode {
  id: number;
  employeeCode: string;
  fullName: string;
  jobTitle: string | null;
  department: { id: number; name: string } | null;
  status: string;
  employmentType: string;
  workLocation: string | null;
  dateOfJoining: string | null;
  /** Always null today: employees have no photo storage yet, so clients show initials. */
  photoUrl: string | null;
  manager: { id: number; name: string; jobTitle: string | null; status: string | null } | null;
  /** A line that starts later (e.g. someone joining next month); not part of today's hierarchy. */
  upcomingManager: { id: number; name: string; effectiveFrom: string } | null;
  directReportCount: number;
  totalReportCount: number;
  /** False = shown only to connect a matching employee to their manager. */
  matched: boolean;
  issue: ChartIssue | null;
  children: ChartNode[];
}

const LOAD = `
  WITH today AS (SELECT tenant_today() AS d)
  SELECT e.id, e.employee_code, e.full_name, e.job_title, e.department_id, d.name AS department_name,
         e.status, e.employment_type, e.work_location, e.date_of_joining,
         cur.manager_id, m.full_name AS manager_name, m.job_title AS manager_title, m.status AS manager_status,
         nxt.manager_id AS upcoming_manager_id, um.full_name AS upcoming_manager_name, nxt.effective_from AS upcoming_from
    FROM employees e
    CROSS JOIN today
    LEFT JOIN departments d ON d.tenant_id = e.tenant_id AND d.id = e.department_id
    -- ex_reporting_no_overlap guarantees at most one line in force on a given day.
    LEFT JOIN employee_reporting cur
           ON cur.tenant_id = e.tenant_id AND cur.employee_id = e.id
          AND cur.effective_from <= today.d AND (cur.effective_to IS NULL OR cur.effective_to >= today.d)
    LEFT JOIN employees m ON m.tenant_id = e.tenant_id AND m.id = cur.manager_id
    LEFT JOIN LATERAL (
      SELECT er.manager_id, er.effective_from FROM employee_reporting er
       WHERE er.tenant_id = e.tenant_id AND er.employee_id = e.id AND er.effective_from > today.d
       ORDER BY er.effective_from LIMIT 1) nxt ON cur.id IS NULL
    LEFT JOIN employees um ON um.tenant_id = e.tenant_id AND um.id = nxt.manager_id
   WHERE ($1::boolean OR e.status <> 'exited')
   ORDER BY lower(e.full_name), e.id`;

export async function getOrganizationChart(tx: Tx, query: ChartQuery) {
  const includeExited = query.status === 'exited' || query.status === 'all';
  const rows = await tx.query<ChartRow>(LOAD, [includeExited]);
  const departments = await tx.query<{ id: number; name: string }>(
    `SELECT id, name FROM departments WHERE is_active ORDER BY name`,
  );
  const asOf = await tx.query<{ d: string }>(`SELECT tenant_today() AS d`);
  const { managers, ...chart } = buildOrganizationChart(rows.rows, query);
  return { asOf: asOf.rows[0].d, ...chart, filterOptions: { departments: departments.rows, managers } };
}

const statusMatches = (status: string, filter: ChartStatus) =>
  filter === 'all' ? true : filter === 'current' ? status !== 'exited' : status === filter;

/**
 * `rows` is everyone the chart may draw, sorted for display; `query` picks the
 * matching employees. Filtering never fakes the structure: the managers between
 * a match and the top stay in the result (matched: false), and report counts
 * are always the real ones, not the filtered ones.
 */
export function buildOrganizationChart(rows: ChartRow[], query: ChartQuery = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parent = new Map<number, number>();
  const issues = new Map<number, ChartIssue>();

  for (const r of rows) {
    if (r.manager_id === null) continue;
    if (r.manager_id === r.id) issues.set(r.id, 'cycle');
    else if (byId.has(r.manager_id)) parent.set(r.id, r.manager_id);
    else issues.set(r.id, r.manager_status === 'exited' ? 'manager_exited' : 'manager_missing');
  }
  breakCycles(rows, parent, issues);

  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    const p = parent.get(r.id);
    if (p === undefined) continue;
    const kids = childrenOf.get(p);
    if (kids) kids.push(r.id);
    else childrenOf.set(p, [r.id]);
  }

  // Top-down order from the top-level employees; reversed, it gives team sizes bottom-up.
  const order = rows.filter((r) => !parent.has(r.id)).map((r) => r.id);
  for (let i = 0; i < order.length; i++) order.push(...(childrenOf.get(order[i]) ?? []));
  const totals = new Map<number, number>();
  for (const id of [...order].reverse()) {
    const kids = childrenOf.get(id) ?? [];
    totals.set(id, kids.reduce((sum, k) => sum + 1 + (totals.get(k) ?? 0), 0));
  }

  // A manager filter scopes to that person's own branch.
  const scopeRoot = query.managerId;
  let inScope: Set<number> | null = null;
  if (scopeRoot !== undefined) {
    const branch = byId.has(scopeRoot) ? [scopeRoot] : [];
    for (let i = 0; i < branch.length; i++) branch.push(...(childrenOf.get(branch[i]) ?? []));
    inScope = new Set(branch);
  }

  const filter = query.status ?? 'current';
  const term = query.search?.trim().toLowerCase();
  const matched = new Set(rows.filter((r) => {
    if (inScope && !inScope.has(r.id)) return false;
    if (!statusMatches(r.status, filter)) return false;
    if (query.departmentId !== undefined && r.department_id !== query.departmentId) return false;
    return !term || [r.full_name, r.employee_code, r.job_title].some((v) => v?.toLowerCase().includes(term));
  }).map((r) => r.id));

  // Matches plus the managers connecting them to the top (or to the selected manager).
  const included = new Set(matched);
  for (const id of matched) {
    for (let cur = id; cur !== scopeRoot && parent.has(cur); ) {
      cur = parent.get(cur)!;
      if (included.has(cur)) break;
      included.add(cur);
    }
  }

  const nodes = new Map<number, ChartNode>();
  for (const r of rows) {
    if (!included.has(r.id)) continue;
    nodes.set(r.id, toNode(r, childrenOf.get(r.id)?.length ?? 0, totals.get(r.id) ?? 0, matched.has(r.id), issues.get(r.id) ?? null));
  }

  const roots: ChartNode[] = [];
  const unassigned: ChartNode[] = [];
  for (const node of nodes.values()) {
    const p = parent.get(node.id);
    if (node.id !== scopeRoot && p !== undefined && nodes.has(p)) nodes.get(p)!.children.push(node);
    else if (node.directReportCount > 0 || node.id === scopeRoot) roots.push(node);
    else unassigned.push(node);
  }

  const shown = [...nodes.values()];
  return {
    summary: {
      employees: matched.size,
      roots: roots.length,
      unassigned: unassigned.length,
      issues: {
        cycle: shown.filter((n) => n.issue === 'cycle').length,
        managerExited: shown.filter((n) => n.issue === 'manager_exited').length,
        managerMissing: shown.filter((n) => n.issue === 'manager_missing').length,
      },
    },
    roots,
    unassigned,
    // Independent of the filters, so a filter's own option never disappears after picking it.
    managers: rows.filter((r) => childrenOf.has(r.id)).map((r) => ({
      id: r.id,
      name: r.full_name,
      jobTitle: r.job_title,
      directReportCount: childrenOf.get(r.id)!.length,
    })),
  };
}

/**
 * The database rejects cycles on write, but the chart must still terminate and
 * show each person once if one exists (e.g. restored or hand-edited data). Each
 * cycle is cut at its lowest id so the result is stable; that employee becomes
 * top-level and is flagged for HR to correct.
 */
function breakCycles(rows: ChartRow[], parent: Map<number, number>, issues: Map<number, ChartIssue>) {
  const done = new Set<number>();
  for (const r of rows) {
    const path: number[] = [];
    const onPath = new Set<number>();
    let cur: number | undefined = r.id;
    while (cur !== undefined && !done.has(cur) && !onPath.has(cur)) {
      path.push(cur);
      onPath.add(cur);
      cur = parent.get(cur);
    }
    if (cur !== undefined && onPath.has(cur)) {
      const cut = Math.min(...path.slice(path.indexOf(cur)));
      parent.delete(cut);
      issues.set(cut, 'cycle');
    }
    for (const id of path) done.add(id);
  }
}

function toNode(r: ChartRow, directReportCount: number, totalReportCount: number, matched: boolean, issue: ChartIssue | null): ChartNode {
  return {
    id: r.id,
    employeeCode: r.employee_code,
    fullName: r.full_name,
    jobTitle: r.job_title,
    department: r.department_id !== null ? { id: r.department_id, name: r.department_name ?? '' } : null,
    status: r.status,
    employmentType: r.employment_type,
    workLocation: r.work_location,
    dateOfJoining: r.date_of_joining,
    photoUrl: null,
    manager: r.manager_id !== null
      ? { id: r.manager_id, name: r.manager_name ?? '', jobTitle: r.manager_title, status: r.manager_status }
      : null,
    upcomingManager: r.upcoming_manager_id !== null
      ? { id: r.upcoming_manager_id, name: r.upcoming_manager_name ?? '', effectiveFrom: r.upcoming_from ?? '' }
      : null,
    directReportCount,
    totalReportCount,
    matched,
    issue,
    children: [],
  };
}

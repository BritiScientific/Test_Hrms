import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Network, RefreshCw, SearchX, UserPlus } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { OrgChartStatus } from '@/types/api';
import { ancestorsOf, defaultExpanded, findMatches, indexChart } from './chart/chart-layout';
import { EmployeeDetailsPanel } from './chart/EmployeeDetailsPanel';
import { OrganizationChartCanvas, type FocusRequest } from './chart/OrganizationChartCanvas';
import { OrganizationChartFilters } from './chart/OrganizationChartFilters';
import { UnassignedEmployees } from './chart/UnassignedEmployees';
import { useOrgChart } from './hooks';

const NO_IDS: ReadonlySet<number> = new Set();

export default function OrganizationChartPage() {
  usePageTitle('Organization Chart');
  const { can } = useAuth();

  const [departmentId, setDepartmentId] = useState('');
  const [managerId, setManagerId] = useState('');
  const [status, setStatus] = useState<OrgChartStatus>('current');
  const [search, setSearch] = useState('');
  const term = useDebounced(search);

  const query = useMemo(() => ({
    departmentId: departmentId ? Number(departmentId) : undefined,
    managerId: managerId ? Number(managerId) : undefined,
    status,
  }), [departmentId, managerId, status]);
  const viewKey = JSON.stringify(query);

  const q = useOrgChart(query);
  const chart = q.data;
  const index = useMemo(() => indexChart(chart), [chart]);

  // Each new view opens with its default branches; a plain refresh keeps what the user opened.
  const [view, setView] = useState({ key: '', expanded: new Set<number>() as ReadonlySet<number> });
  if (chart && !q.isPlaceholderData && view.key !== viewKey) {
    setView({ key: viewKey, expanded: defaultExpanded(chart, index) });
  }
  const setExpanded = useCallback((update: (cur: Set<number>) => Set<number>) => {
    setView((v) => ({ ...v, expanded: update(new Set(v.expanded)) }));
  }, []);

  const toggle = useCallback((id: number) => {
    setExpanded((s) => {
      if (!s.delete(id)) s.add(id);
      return s;
    });
  }, [setExpanded]);
  const expandAll = useCallback(() => setExpanded(() => new Set(index.managers.map((m) => m.id))), [index, setExpanded]);
  const collapseAll = useCallback(() => setExpanded(() => new Set()), [setExpanded]);

  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const locate = useCallback((id: number) => {
    setExpanded((s) => {
      for (const a of ancestorsOf(id, index)) s.add(a);
      return s;
    });
    if (!index.unassignedIds.has(id)) setFocusRequest((f) => ({ id, seq: (f?.seq ?? 0) + 1 }));
  }, [index, setExpanded]);

  // Search runs over the loaded chart so the hierarchy stays on screen with results
  // highlighted; only the current result's branch opens, so broad terms stay cheap.
  const matches = useMemo(() => findMatches(index, term), [index, term]);
  const matchIds = useMemo(() => (matches.length ? new Set(matches) : NO_IDS), [matches]);
  const [activePosition, setActivePosition] = useState(0);
  useEffect(() => setActivePosition(0), [term, viewKey]);
  const safePosition = matches.length ? Math.min(activePosition, matches.length - 1) : 0;
  const activeMatchId = matches.length ? matches[safePosition] : null;
  const step = (delta: number) => setActivePosition((p) => (p + delta + matches.length) % matches.length);

  const locateRef = useRef(locate);
  locateRef.current = locate;
  useEffect(() => {
    if (activeMatchId !== null) locateRef.current(activeMatchId);
  }, [activeMatchId]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const select = useCallback((id: number) => setSelectedId(id), []);
  const selected = selectedId !== null ? index.byId.get(selectedId) ?? null : null;

  // A chosen manager can stop being one (their last report moved, or they left).
  const managerOptions = chart?.filterOptions.managers;
  useEffect(() => {
    if (managerId && managerOptions && !q.isPlaceholderData && !managerOptions.some((m) => String(m.id) === managerId)) {
      setManagerId('');
    }
  }, [managerId, managerOptions, q.isPlaceholderData]);

  const clearFilters = () => {
    setDepartmentId('');
    setManagerId('');
    setStatus('current');
    setSearch('');
  };
  const filtered = !!departmentId || !!managerId || status !== 'current';

  const count = chart?.summary.employees;
  const issues = chart?.summary.issues;
  const issueCount = issues ? issues.cycle + issues.managerExited + issues.managerMissing : 0;

  return (
    <div>
      <PageHeader
        title="Organization Chart"
        description="Generated from each employee’s current reporting manager. To change the structure, edit the manager on the employee’s record."
        actions={
          <>
            {count !== undefined && <Badge tone="primary" className="tabular">{count} {count === 1 ? 'employee' : 'employees'}</Badge>}
            <Button
              variant="outline"
              onClick={() => q.refetch()}
              disabled={q.isFetching}
              icon={<RefreshCw className={q.isFetching ? 'size-4 animate-spin' : 'size-4'} aria-hidden />}
            >
              Refresh
            </Button>
          </>
        }
      />

      <div className="space-y-4">
        <Card className="p-3 sm:p-4">
          <OrganizationChartFilters
            search={search}
            onSearch={setSearch}
            matchCount={term.trim() && chart ? matches.length : null}
            activeIndex={safePosition}
            onStep={step}
            departmentId={departmentId}
            onDepartment={setDepartmentId}
            managerId={managerId}
            onManager={setManagerId}
            status={status}
            onStatus={setStatus}
            options={chart?.filterOptions}
            onClear={clearFilters}
          />
        </Card>

        {q.isPending && <Card className="p-4"><LoadingBlock rows={8} label="Loading organization chart" /></Card>}
        {q.isError && !chart && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
        {q.isError && chart && (
          <InlineAlert title="Couldn’t refresh the chart">Showing the last loaded data. {(q.error as Error).message}</InlineAlert>
        )}

        {issueCount > 0 && issues && (
          <InlineAlert tone="warning" title="Some reporting lines need attention">
            {issues.managerExited > 0 && <>{issues.managerExited} {issues.managerExited === 1 ? 'person reports' : 'people report'} to a manager who has left. </>}
            {issues.managerMissing > 0 && <>{issues.managerMissing} {issues.managerMissing === 1 ? 'person reports' : 'people report'} to a manager who can’t be found. </>}
            {issues.cycle > 0 && <>{issues.cycle} circular reporting {issues.cycle === 1 ? 'line was' : 'lines were'} cut to draw the chart. </>}
            They are marked on the chart.
          </InlineAlert>
        )}

        {chart && chart.roots.length === 0 && chart.unassigned.length === 0 && (
          <Card>
            {filtered ? (
              <EmptyState icon={<SearchX />} title="No employees match" description="Try clearing the filters." action={<Button size="sm" variant="outline" onClick={clearFilters}>Clear filters</Button>} />
            ) : (
              <EmptyState
                icon={<Network />}
                title="No employees yet"
                description="The chart is built from employee records and their reporting managers."
                action={can('employee.create') && <ButtonLink size="sm" to="/employees?new=1" icon={<UserPlus className="size-4" aria-hidden />}>Add employee</ButtonLink>}
              />
            )}
          </Card>
        )}

        {chart && chart.roots.length > 0 && (
          <OrganizationChartCanvas
            roots={chart.roots}
            expanded={view.expanded}
            onToggle={toggle}
            onSelect={select}
            onExpandAll={expandAll}
            onCollapseAll={collapseAll}
            matchIds={matchIds}
            activeMatchId={activeMatchId}
            focusRequest={focusRequest}
            viewKey={view.key}
          />
        )}

        {chart && chart.roots.length === 0 && chart.unassigned.length > 0 && (
          <InlineAlert tone="info" title="No reporting lines to draw">
            None of these employees has a team. Assign reporting managers on their employee records to build the chart.
          </InlineAlert>
        )}

        {chart && chart.unassigned.length > 0 && (
          <UnassignedEmployees employees={chart.unassigned} onSelect={select} matchIds={matchIds} activeMatchId={activeMatchId} />
        )}
      </div>

      <EmployeeDetailsPanel
        employee={selected}
        inChart={(id) => index.byId.has(id)}
        onClose={() => setSelectedId(null)}
        onSelect={select}
        onLocate={selected && index.unassignedIds.has(selected.id) ? undefined : (id) => {
          setSelectedId(null);
          locate(id);
        }}
        onViewHierarchy={(id) => {
          setSelectedId(null);
          setManagerId(String(id));
        }}
        hierarchyActive={selected !== null && managerId === String(selected.id)}
      />
    </div>
  );
}

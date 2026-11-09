import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { BadgeCheck } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { CompOffClaim, LeaveRequestRow } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { leaveKey, useLookups } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { EMPTY_FILTERS, RequestFilters, filterQuery, type RequestFilterValues } from '../components/RequestFilters';
import { ClaimProgress, CompOffStatusBadge, DataTable, LeaveStatusBadge, Pager, QueryState, type Column } from '../components/shared';
import { dateRange, days } from '../leave-format';

const PAGE = 25;

export default function AllRequestsPage() {
  usePageTitle('All Leave Requests');
  const { canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const canClaims = canAny('leave.request.view_all', 'leave.request.manage');
  const tab = params.get('tab') === 'comp-off' && canClaims ? 'comp-off' : 'requests';
  const claimsCount = useQuery({
    queryKey: leaveKey('claims', 'pending-count'),
    queryFn: () => leaveApi.claims({ status: 'pending', limit: 1 }),
    enabled: canClaims,
  });
  const tabs = [
    { key: 'requests' as const, label: 'Leave requests' },
    ...(canClaims ? [{ key: 'comp-off' as const, label: 'Comp off claims', count: claimsCount.data?.total }] : []),
  ];

  return (
    <div>
      <PageHeader title="All Leave Requests" description="Every leave request in your organization" />
      <Card>
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Request sections" tabs={tabs} active={tab}
            onChange={(k) => { const n = new URLSearchParams(params); n.set('tab', k); setParams(n, { replace: true }); }} />
        </div>
        <TabPanel active={tab}>{tab === 'requests' ? <RequestsTab /> : <ClaimsTab />}</TabPanel>
      </Card>
    </div>
  );
}

function RequestsTab() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const lookups = useLookups();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<RequestFilterValues>({ ...EMPTY_FILTERS, status: params.get('status') ?? '' });
  const [departmentId, setDepartmentId] = useState('');
  const [offset, setOffset] = useState(0);
  const [openId, setOpenId] = useState<number | null>(null);
  const debounced = useDebounced(filters.search);
  const query = useMemo(() => ({
    ...filterQuery(filters), search: debounced || undefined, departmentId: departmentId ? Number(departmentId) : undefined,
  }), [filters, debounced, departmentId]);
  useEffect(() => setOffset(0), [query]);
  const q = useQuery({
    queryKey: leaveKey('all-requests', query, offset),
    queryFn: () => leaveApi.allRequests({ ...query, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<LeaveRequestRow>[] = [
    { key: 'employee', header: 'Employee', bare: true, render: (r) => <span><span className="block font-medium text-ink">{r.employeeName}</span><span className="block text-xs text-muted">{r.employeeCode}</span></span> },
    { key: 'dept', header: 'Department', render: (r) => r.departmentName ?? <span className="text-muted">—</span> },
    { key: 'type', header: 'Leave type', render: (r) => r.leaveTypeName },
    { key: 'dates', header: 'Dates', className: 'whitespace-nowrap', render: (r) => dateRange(r, prefs) },
    { key: 'days', header: 'Days', className: 'tabular', render: (r) => days(r.totalDays) },
    { key: 'status', header: 'Status', render: (r) => <LeaveStatusBadge status={r.status} /> },
    { key: 'submitted', header: 'Submitted', className: 'whitespace-nowrap text-muted', render: (r) => formatDate(r.createdAt, prefs) },
  ];
  return (
    <>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <RequestFilters value={filters} onChange={setFilters} searchPlaceholder="Search employee, code or reason" leaveTypes={lookups.data?.leaveTypes}>
        <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Filter by department">
          <option value="">All departments</option>
          {lookups.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
      </RequestFilters>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No requests match" emptyText="Try clearing the filters.">
        {(d) => (
          <>
            <DataTable caption="All leave requests" columns={columns} rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} minWidth="60rem" />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </>
  );
}

/** Every claim in the organization. Decisions are made by the approvers the comp off workflow assigns. */
function ClaimsTab() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const [status, setStatus] = useState('pending');
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [status]);
  const q = useQuery({
    queryKey: leaveKey('claims', status, offset),
    queryFn: () => leaveApi.claims({ status: status || undefined, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<CompOffClaim>[] = [
    { key: 'employee', header: 'Employee', bare: true, render: (c) => <span className="font-medium text-ink">{c.employeeName}</span> },
    { key: 'date', header: 'Worked on', className: 'whitespace-nowrap', render: (c) => <>{formatDate(c.workDate, prefs)}<span className="block text-xs text-muted">{c.workDayType.replace('_', ' ')}</span></> },
    { key: 'hours', header: 'Hours', className: 'tabular', render: (c) => days(c.hoursWorked) },
    { key: 'earned', header: 'Earns', className: 'tabular', render: (c) => `${days(c.earnedDays)} d` },
    { key: 'reason', header: 'Work done', className: 'max-w-72', render: (c) => c.reason },
    { key: 'status', header: 'Status', render: (c) => <CompOffStatusBadge status={c.status} /> },
    {
      key: 'progress', header: 'Progress', className: 'max-w-72',
      render: (c) => <>{c.decidedByName && c.status !== 'pending' && <span className="block text-xs text-slate-700">{c.decidedByName}</span>}<ClaimProgress claim={c} prefs={prefs} /></>,
    },
  ];
  return (
    <>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">Claims are approved through the comp off approval workflow. Approvers act from Team Leave Requests & Approvals.</p>
        <Select className="w-56!" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="pending">Awaiting approval</option>
          <option value="returned">Returned</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="withdrawn">Withdrawn</option>
          <option value="">All</option>
        </Select>
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<BadgeCheck />} emptyTitle="No claims here">
        {(d) => (
          <>
            <DataTable caption="Comp off claims" columns={columns} rows={d.items} rowKey={(c) => c.id} minWidth="60rem" />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </>
  );
}

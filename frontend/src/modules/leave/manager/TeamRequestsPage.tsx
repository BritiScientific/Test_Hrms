import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Check, CheckCheck, CornerUpLeft, History, Inbox, ListChecks, X } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { ApprovalHistoryRow, LeaveRequestRow, LeaveStatus, PendingApproval } from '@/types/leave';
import { formatDate, formatDateTime } from '@/utils/format';
import { leaveKey, useLeaveAction, useLookups } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { EMPTY_FILTERS, RequestFilters, filterQuery, type RequestFilterValues } from '../components/RequestFilters';
import { DataTable, LeaveStatusBadge, Pager, QueryState, ReasonDialog, type Column } from '../components/shared';
import { dateRange, days } from '../leave-format';

const PAGE = 20;
type TabKey = 'pending' | 'all' | 'history';

export default function TeamRequestsPage() {
  usePageTitle('Team Leave Requests & Approvals');
  const { can, canAny } = useAuth();
  const [params, setParams] = useSearchParams();
  const canPending = canAny('leave.request.approve', 'leave.request.reject', 'leave.request.return');
  const canAll = can('leave.request.view_team');
  const canHistory = can('leave.approval_history.view_team');
  const pendingQ = useQuery({ queryKey: leaveKey('pending-approvals'), queryFn: leaveApi.pendingApprovals, enabled: canPending });

  const tabs = [
    ...(canPending ? [{ key: 'pending' as TabKey, label: 'Pending Approvals', count: pendingQ.data?.length, icon: <Inbox className="size-4" aria-hidden /> }] : []),
    ...(canAll ? [{ key: 'all' as TabKey, label: 'All Team Requests', icon: <ListChecks className="size-4" aria-hidden /> }] : []),
    ...(canHistory ? [{ key: 'history' as TabKey, label: 'Approval History', icon: <History className="size-4" aria-hidden /> }] : []),
  ];
  const raw = params.get('tab') as TabKey | null;
  const tab = tabs.some((t) => t.key === raw) ? raw! : tabs[0]?.key ?? 'pending';
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="Team Leave Requests & Approvals" />
      <Card>
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Team leave sections" tabs={tabs} active={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
        </div>
        <TabPanel active={tab}>
          {tab === 'pending' && <PendingTab query={pendingQ} onOpen={setOpenId} />}
          {tab === 'all' && <AllTab onOpen={setOpenId} />}
          {tab === 'history' && <HistoryTab onOpen={setOpenId} />}
        </TabPanel>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- pending tab --

type Decision = { task: PendingApproval; action: 'approve' | 'reject' | 'return' };

function PendingTab({ query, onOpen }: { query: ReturnType<typeof useQuery<PendingApproval[]>>; onOpen: (id: number) => void }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const [decision, setDecision] = useState<Decision | null>(null);
  const act = useLeaveAction(
    ({ task, action, comments }: Decision & { comments: string }) => leaveApi.actOnTask(task.taskId, action, comments),
    { success: 'Decision saved', onDone: () => setDecision(null) },
  );

  const columns: Column<PendingApproval>[] = [
    {
      key: 'employee', header: 'Employee', bare: true,
      render: (t) => (
        <span>
          <span className="block font-medium text-ink">{t.summary.employeeName}</span>
          <span className="block text-xs text-muted">{t.summary.departmentName ?? t.summary.employeeCode}</span>
          {t.viaDelegation && <Badge tone="violet" className="mt-1">Delegated to you</Badge>}
        </span>
      ),
    },
    {
      key: 'type', header: 'Request',
      render: (t) => (t.module === 'comp_off'
        ? <><Badge tone="violet">Comp off claim</Badge><span className="mt-1 block text-xs text-muted">{t.summary.leaveType}</span></>
        : t.summary.leaveType),
    },
    {
      key: 'dates', header: 'Dates', className: 'whitespace-nowrap',
      render: (t) => (t.module === 'comp_off'
        ? <>Worked {formatDate(t.summary.startDate, prefs)}<span className="block text-xs text-muted">{days(t.summary.hoursWorked)} hours · earns {days(t.summary.totalDays)} d</span></>
        : <>{dateRange(t.summary, prefs)}<span className="block text-xs text-muted">{days(t.summary.totalDays)} {t.summary.totalDays === 1 ? 'day' : 'days'}</span></>),
    },
    { key: 'reason', header: 'Reason', className: 'max-w-64', render: (t) => <span className="line-clamp-2 text-slate-700">{t.summary.reason}</span> },
    {
      key: 'submitted', header: 'Submitted', className: 'whitespace-nowrap text-muted',
      render: (t) => <>{formatDate(t.summary.submittedAt, prefs)}{t.overdue && <Badge tone="danger" className="ml-1">Overdue</Badge>}</>,
    },
    { key: 'step', header: 'Stage', render: (t) => t.stepName },
    {
      key: 'actions', header: 'Actions', bare: true,
      render: (t) => (
        <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          {can('leave.request.approve') && <Button size="sm" icon={<Check className="size-3.5" />} onClick={() => setDecision({ task: t, action: 'approve' })}>Approve</Button>}
          {t.allowReject && can('leave.request.reject') && <Button size="sm" variant="outline" icon={<X className="size-3.5" />} onClick={() => setDecision({ task: t, action: 'reject' })}>Reject</Button>}
          {t.allowReturn && can('leave.request.return') && <Button size="sm" variant="outline" icon={<CornerUpLeft className="size-3.5" />} onClick={() => setDecision({ task: t, action: 'return' })}>Request information</Button>}
        </div>
      ),
    },
  ];

  return (
    <>
      <QueryState query={query} isEmpty={(d) => d.length === 0} emptyIcon={<CheckCheck />} emptyTitle="You’re all caught up" emptyText="Leave requests and comp off claims waiting for your decision will appear here.">
        {(d) => (
          <DataTable caption="Pending approvals" columns={columns} rows={d} rowKey={(t) => t.taskId} minWidth="68rem"
            onRowClick={(t) => { if (t.module === 'leave') onOpen(t.entityId); }} />
        )}
      </QueryState>
      {decision && (
        <ReasonDialog open
          title={decision.action === 'return' ? 'Ask for more information'
            : `${decision.action === 'approve' ? 'Approve' : 'Reject'} ${decision.task.summary.employeeName}’s ${decision.task.module === 'comp_off' ? 'comp off claim' : 'leave'}`}
          description={decision.task.module === 'comp_off'
            ? `Worked ${formatDate(decision.task.summary.startDate, prefs)} for ${days(decision.task.summary.hoursWorked)} hours. Earns ${days(decision.task.summary.totalDays)} d of ${decision.task.summary.leaveType}.`
            : `${decision.task.summary.leaveType}, ${dateRange(decision.task.summary, prefs)}, ${days(decision.task.summary.totalDays)} d`}
          label={decision.action === 'approve' ? 'Comment' : decision.action === 'reject' ? 'Reason for rejecting' : 'What do you need to know?'}
          confirmLabel={decision.action === 'approve' ? 'Approve' : decision.action === 'reject' ? 'Reject' : 'Send back'}
          tone={decision.action === 'reject' ? 'destructive' : 'primary'}
          optional={decision.action === 'approve'} loading={act.isPending}
          onClose={() => setDecision(null)}
          onConfirm={(comments) => act.mutate({ ...decision, comments })} />
      )}
    </>
  );
}

// -------------------------------------------------------------------- all tab --

function AllTab({ onOpen }: { onOpen: (id: number) => void }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const lookups = useLookups();
  const members = useQuery({ queryKey: leaveKey('team-members'), queryFn: leaveApi.teamMembers, staleTime: 60_000 });
  const [filters, setFilters] = useState<RequestFilterValues>(EMPTY_FILTERS);
  const [employeeId, setEmployeeId] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(filters.search);
  const query = useMemo(() => ({
    ...filterQuery(filters), search: debounced || undefined, employeeId: employeeId ? Number(employeeId) : undefined,
  }), [filters, debounced, employeeId]);
  useEffect(() => setOffset(0), [query]);
  const q = useQuery({
    queryKey: leaveKey('team-requests', query, offset),
    queryFn: () => leaveApi.teamRequests({ ...query, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<LeaveRequestRow>[] = [
    { key: 'employee', header: 'Employee', bare: true, render: (r) => <span><span className="block font-medium text-ink">{r.employeeName}</span><span className="block text-xs text-muted">{r.departmentName ?? r.employeeCode}</span></span> },
    { key: 'type', header: 'Leave type', render: (r) => r.leaveTypeName },
    { key: 'dates', header: 'Dates', className: 'whitespace-nowrap', render: (r) => dateRange(r, prefs) },
    { key: 'days', header: 'Days', className: 'tabular', render: (r) => days(r.totalDays) },
    { key: 'status', header: 'Status', render: (r) => <LeaveStatusBadge status={r.status} /> },
    { key: 'submitted', header: 'Submitted', className: 'whitespace-nowrap text-muted', render: (r) => formatDate(r.createdAt, prefs) },
  ];
  return (
    <>
      <RequestFilters value={filters} onChange={setFilters} searchPlaceholder="Search name or reason" leaveTypes={lookups.data?.leaveTypes}>
        <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Filter by employee">
          <option value="">Everyone on my team</option>
          {members.data?.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
        </Select>
      </RequestFilters>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No requests match" emptyText="Requests from your team will appear here.">
        {(d) => (
          <>
            <DataTable caption="Team leave requests" columns={columns} rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => onOpen(r.id)} />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </>
  );
}

// ---------------------------------------------------------------- history tab --

const ACTION_BADGE: Record<string, { label: string; tone: BadgeTone }> = {
  approve: { label: 'Approved', tone: 'success' },
  reject: { label: 'Rejected', tone: 'danger' },
  return: { label: 'Returned', tone: 'violet' },
};

function HistoryTab({ onOpen }: { onOpen: (id: number) => void }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const [action, setAction] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search);
  useEffect(() => setOffset(0), [action, debounced, from, to]);
  const q = useQuery({
    queryKey: leaveKey('approval-history', action, debounced, from, to, offset),
    queryFn: () => leaveApi.approvalHistory({ action: action || undefined, search: debounced || undefined, from: from || undefined, to: to || undefined, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<ApprovalHistoryRow>[] = [
    { key: 'employee', header: 'Employee', bare: true, render: (h) => <span className="font-medium text-ink">{h.employeeName}</span> },
    {
      key: 'type', header: 'Request',
      render: (h) => (h.kind === 'comp_off'
        ? <><Badge tone="violet">Comp off claim</Badge><span className="mt-1 block whitespace-nowrap text-xs text-muted">Worked {formatDate(h.startDate, prefs)} · earns {days(h.totalDays)} d</span></>
        : <>{h.leaveTypeName}<span className="block whitespace-nowrap text-xs text-muted">{dateRange(h, prefs)} · {days(h.totalDays)} d</span></>),
    },
    { key: 'action', header: 'Decision', render: (h) => <Badge tone={ACTION_BADGE[h.action].tone}>{ACTION_BADGE[h.action].label}</Badge> },
    { key: 'stage', header: 'Stage', render: (h) => h.stepName ?? '—' },
    { key: 'comments', header: 'Comments', className: 'max-w-64', render: (h) => <span className="text-slate-700">{h.comments ?? '—'}{h.onBehalfOfName && <span className="block text-xs text-muted">On behalf of {h.onBehalfOfName}</span>}</span> },
    { key: 'at', header: 'When', className: 'whitespace-nowrap text-muted', render: (h) => formatDateTime(h.at, prefs) },
    // Comp off claim statuses are a subset of leave statuses, so the same badge labels them.
    { key: 'now', header: 'Request now', render: (h) => <LeaveStatusBadge status={h.requestStatus as LeaveStatus} /> },
  ];
  return (
    <>
      <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee" aria-label="Search by employee" />
        <Select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by decision">
          <option value="">All decisions</option>
          <option value="approve">Approved</option>
          <option value="reject">Rejected</option>
          <option value="return">Returned</option>
        </Select>
        <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From date" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To date" />
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<History />} emptyTitle="No decisions yet" emptyText="Requests you approve, reject or return will be listed here.">
        {(d) => (
          <>
            <DataTable caption="My approval history" columns={columns} rows={d.items} rowKey={(h) => h.id} onRowClick={(h) => { if (h.kind === 'leave') onOpen(h.requestId); }} minWidth="64rem" />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </>
  );
}

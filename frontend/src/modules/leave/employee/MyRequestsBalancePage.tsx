import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { CalendarPlus, ClipboardList, Clock, Plus, Receipt } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { BalanceRow, CompOffClaim, LedgerRow, LeaveRequestRow } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { errorMessage, leaveKey, useLeaveAction } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { EMPTY_FILTERS, RequestFilters, filterQuery, type RequestFilterValues } from '../components/RequestFilters';
import {
  ClaimProgress, CompOffStatusBadge, DataTable, LeaveStatusBadge, Pager, QueryState, ReasonDialog, type Column,
} from '../components/shared';
import { TXN_LABEL, dateRange, days, tenantToday } from '../leave-format';

const PAGE = 20;

export default function MyRequestsBalancePage() {
  usePageTitle('My Leave Requests & Balance');
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canBalance = can('leave.balance.view_self');
  const canRequests = can('leave.request.view_self');
  const fallback = canBalance ? 'balance' : 'requests';
  const raw = params.get('tab');
  const tab = raw === 'balance' && canBalance ? 'balance' : raw === 'requests' && canRequests ? 'requests' : fallback;
  const tabs = [
    ...(canBalance ? [{ key: 'balance' as const, label: 'Leave Balance' }] : []),
    ...(canRequests ? [{ key: 'requests' as const, label: 'My Requests' }] : []),
  ];

  return (
    <div>
      <PageHeader title="My Leave Requests & Balance"
        actions={can('leave.request.create_self') && <ButtonLink to="/leave/apply" icon={<CalendarPlus className="size-4" />}>Apply for leave</ButtonLink>} />
      <Card>
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Leave sections" tabs={tabs} active={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
        </div>
        <TabPanel active={tab}>{tab === 'balance' ? <BalanceTab /> : <RequestsTab />}</TabPanel>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- balance tab --

function BalanceTab() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const thisYear = Number(tenantToday(prefs.timezone).slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const q = useQuery({ queryKey: leaveKey('my-balances', year), queryFn: () => leaveApi.myBalances(year) });

  const columns: Column<BalanceRow>[] = [
    {
      key: 'type', header: 'Leave type', bare: true,
      render: (b) => <span className="font-medium text-ink">{b.leaveTypeName}{!b.isPaid && <Badge tone="neutral" className="ml-2">Unpaid</Badge>}</span>,
    },
    { key: 'annual', header: 'Annual entitlement', className: 'tabular', render: (b) => days(b.annualEntitlement) },
    { key: 'opening', header: 'Opening', className: 'tabular', render: (b) => days(b.opening) },
    { key: 'accrued', header: 'Accrued', className: 'tabular', render: (b) => days(b.accrued + b.adjusted + b.compOff) },
    { key: 'carried', header: 'Carried forward', className: 'tabular', render: (b) => days(b.carriedForward) },
    { key: 'used', header: 'Used', className: 'tabular', render: (b) => days(b.used) },
    { key: 'pending', header: 'Pending', className: 'tabular', render: (b) => days(b.pending) },
    { key: 'available', header: 'Available', className: 'tabular font-semibold', render: (b) => (b.isPaid ? days(b.available) : '—') },
    {
      key: 'expiry', header: 'Expiry',
      render: (b) => (b.nextExpiryOn
        ? <span className="whitespace-nowrap text-xs">{days(b.expiringDays)} d on {formatDate(b.nextExpiryOn, prefs)}</span>
        : <span className="text-muted">—</span>),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between gap-3 p-4">
        <h2 className="text-base font-semibold">Balance</h2>
        <Select className="w-28!" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Leave year">
          {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No balances for this year"
        emptyText="Balances appear once HR has set up your leave policy and leave has been credited.">
        {(d) => <DataTable caption="Leave balances" columns={columns} rows={d.items} rowKey={(b) => b.leaveTypeId} minWidth="60rem" />}
      </QueryState>
      <Transactions year={year} types={q.data?.items ?? []} />
      <CompOffSection />
    </div>
  );
}

function Transactions({ year, types }: { year: number; types: BalanceRow[] }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset(0), [year, leaveTypeId]);
  const q = useQuery({
    queryKey: leaveKey('my-transactions', year, leaveTypeId, offset),
    queryFn: () => leaveApi.myTransactions({ year, leaveTypeId: leaveTypeId || undefined, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', className: 'whitespace-nowrap', render: (t) => formatDate(t.effectiveDate, prefs) },
    { key: 'type', header: 'Leave type', render: (t) => t.leaveTypeName },
    { key: 'txn', header: 'Transaction', render: (t) => TXN_LABEL[t.txnType] ?? t.txnType },
    {
      key: 'days', header: 'Days', className: 'tabular',
      render: (t) => <span className={t.delta > 0 ? 'text-green-700' : 'text-slate-700'}>{t.delta > 0 ? '+' : '−'}{days(t.days)}</span>,
    },
    { key: 'after', header: 'Available after', className: 'tabular', render: (t) => days(t.availableAfter) },
    { key: 'note', header: 'Note', render: (t) => <span className="text-xs text-muted">{t.note ?? '—'}{t.expiresOn && ` · expires ${formatDate(t.expiresOn, prefs)}`}</span> },
  ];
  return (
    <section className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <h2 className="text-base font-semibold">Balance transaction history</h2>
        <Select className="w-52!" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} aria-label="Filter transactions by leave type">
          <option value="">All leave types</option>
          {types.map((t) => <option key={t.leaveTypeId} value={t.leaveTypeId}>{t.leaveTypeName}</option>)}
        </Select>
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<Receipt />} emptyTitle="No transactions this year">
        {(d) => (
          <>
            <DataTable caption="Balance transactions" columns={columns} rows={d.items} rowKey={(t) => t.id} />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </section>
  );
}

function CompOffSection() {
  const me = useMe();
  const { can } = useAuth();
  const prefs = me.tenant.preferences;
  const types = useQuery({ queryKey: leaveKey('comp-off-types'), queryFn: leaveApi.claimableTypes, enabled: can('leave.request.create_self') });
  const claims = useQuery({ queryKey: leaveKey('my-claims'), queryFn: () => leaveApi.myClaims({ limit: 20 }), enabled: can('leave.request.view_self') });
  const [open, setOpen] = useState(false);
  const [acting, setActing] = useState<{ claim: CompOffClaim; kind: 'withdraw' | 'resubmit' } | null>(null);
  const act = useLeaveAction(
    ({ claim, kind, text }: { claim: CompOffClaim; kind: 'withdraw' | 'resubmit'; text: string }) =>
      (kind === 'withdraw' ? leaveApi.withdrawClaim(claim.id) : leaveApi.resubmitClaim(claim.id, text)),
    { success: 'Claim updated', onDone: () => setActing(null) },
  );
  if (!types.data?.length && !claims.data?.total) return null;

  const columns: Column<CompOffClaim>[] = [
    { key: 'date', header: 'Worked on', className: 'whitespace-nowrap', render: (c) => formatDate(c.workDate, prefs) },
    { key: 'hours', header: 'Hours', className: 'tabular', render: (c) => days(c.hoursWorked) },
    { key: 'earned', header: 'Earns', className: 'tabular', render: (c) => `${days(c.earnedDays)} d` },
    { key: 'reason', header: 'Reason', className: 'max-w-64', render: (c) => c.reason },
    { key: 'status', header: 'Status', render: (c) => <CompOffStatusBadge status={c.status} /> },
    { key: 'progress', header: 'Progress', className: 'max-w-64', render: (c) => <ClaimProgress claim={c} prefs={prefs} /> },
    ...(can('leave.request.cancel_self') || can('leave.request.create_self') ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (c: CompOffClaim) => (
        <div className="flex flex-wrap gap-1.5">
          {c.status === 'returned' && can('leave.request.create_self') && (
            <Button size="sm" onClick={() => setActing({ claim: c, kind: 'resubmit' })}>Answer</Button>
          )}
          {['pending', 'returned'].includes(c.status) && can('leave.request.cancel_self') && (
            <Button size="sm" variant="ghost" onClick={() => setActing({ claim: c, kind: 'withdraw' })}>Withdraw</Button>
          )}
        </div>
      ),
    }] : []),
  ];
  return (
    <section className="border-t border-line">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <h2 className="text-base font-semibold">Compensatory off</h2>
          <p className="text-sm text-muted">Claim days you worked on a weekly off or holiday. Credited once the claim is approved.</p>
        </div>
        {!!types.data?.length && can('leave.request.create_self') && (
          <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={() => setOpen(true)}>Claim comp off</Button>
        )}
      </div>
      {claims.data && claims.data.items.length > 0 && <DataTable caption="Comp off claims" columns={columns} rows={claims.data.items} rowKey={(c) => c.id} minWidth="56rem" />}
      {types.data && open && <ClaimDialog types={types.data} onClose={() => setOpen(false)} />}
      {acting && (
        <ReasonDialog open
          title={acting.kind === 'withdraw' ? 'Withdraw this claim' : 'Answer and resubmit'}
          description={acting.kind === 'withdraw'
            ? 'Approvers will no longer see it. Nothing has been credited, so nothing changes in your balance.'
            : acting.claim.decisionNote ? `Your approver asked: “${acting.claim.decisionNote}”. Approval starts again from the first step.` : 'Approval starts again from the first step.'}
          label={acting.kind === 'withdraw' ? 'Reason' : 'Updated description of the work'}
          optional={acting.kind === 'withdraw'}
          confirmLabel={acting.kind === 'withdraw' ? 'Withdraw' : 'Resubmit'}
          tone={acting.kind === 'withdraw' ? 'destructive' : 'primary'}
          loading={act.isPending}
          onClose={() => setActing(null)}
          onConfirm={(text) => act.mutate({ ...acting, text })} />
      )}
    </section>
  );
}

function ClaimDialog({ types, onClose }: { types: Awaited<ReturnType<typeof leaveApi.claimableTypes>>; onClose: () => void }) {
  const [leaveTypeId, setLeaveTypeId] = useState(String(types[0].leaveTypeId));
  const [workDate, setWorkDate] = useState('');
  const [hoursWorked, setHours] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rule = types.find((t) => String(t.leaveTypeId) === leaveTypeId);
  const save = useLeaveAction(() => leaveApi.createClaim({ leaveTypeId: Number(leaveTypeId), workDate, hoursWorked: Number(hoursWorked), reason }), {
    success: 'Claim submitted', onDone: onClose,
  });
  const submit = () => {
    if (!workDate || !hoursWorked || reason.trim().length < 3) return setError('Fill in the date, the hours and a description of the work.');
    setError(null);
    save.mutate(undefined, { onError: (e) => setError(errorMessage(e)) });
  };
  return (
    <Dialog open onClose={onClose} title="Claim comp off" size="sm"
      description={rule ? `Needs at least ${days(rule.minimumWorkHours)} hours. Earns ${days(rule.earnedDays)} day${rule.approvalRequired ? ' once approved' : ''}.` : undefined}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={save.isPending}>Submit claim</Button></>}>
      <div className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        {types.length > 1 && (
          <Field label="Leave type">{({ id }) => (
            <Select id={id} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
              {types.map((t) => <option key={t.leaveTypeId} value={t.leaveTypeId}>{t.leaveTypeName}</option>)}
            </Select>
          )}</Field>
        )}
        <Field label="Date worked" required>{({ id }) => <Input id={id} data-autofocus type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />}</Field>
        <Field label="Hours worked" required>{({ id }) => <Input id={id} type="number" min="0.5" max="24" step="0.5" value={hoursWorked} onChange={(e) => setHours(e.target.value)} />}</Field>
        <Field label="What was the work?" required>{({ id }) => <Textarea id={id} value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

// --------------------------------------------------------------- requests tab --

function RequestsTab() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState<RequestFilterValues>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(filters.search);
  const query = useMemo(() => ({ ...filterQuery(filters), search: debounced || undefined }), [filters, debounced]);
  useEffect(() => setOffset(0), [query]);

  const openParam = Number(params.get('open'));
  const [openId, setOpenId] = useState<number | null>(Number.isSafeInteger(openParam) && openParam > 0 ? openParam : null);
  const closeDetail = () => {
    setOpenId(null);
    if (params.get('open')) { params.delete('open'); setParams(params, { replace: true }); }
  };

  const types = useQuery({ queryKey: leaveKey('my-balances', 'types'), queryFn: () => leaveApi.myBalances(Number(tenantToday(prefs.timezone).slice(0, 4))) });
  const q = useQuery({
    queryKey: leaveKey('my-requests', query, offset),
    queryFn: () => leaveApi.myRequests({ ...query, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const filtered = !!(query.search || query.status || query.leaveTypeId || query.from || query.to);

  const columns: Column<LeaveRequestRow>[] = [
    { key: 'type', header: 'Leave type', bare: true, render: (r) => <span className="font-medium text-ink">{r.leaveTypeName}</span> },
    { key: 'dates', header: 'Dates', className: 'whitespace-nowrap', render: (r) => dateRange(r, prefs) },
    { key: 'days', header: 'Days', className: 'tabular', render: (r) => days(r.totalDays) },
    { key: 'status', header: 'Status', render: (r) => <LeaveStatusBadge status={r.status} /> },
    { key: 'submitted', header: 'Submitted', className: 'whitespace-nowrap text-muted', render: (r) => formatDate(r.createdAt, prefs) },
    { key: 'reason', header: 'Reason', className: 'max-w-64 truncate text-muted', render: (r) => r.reason },
  ];

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={closeDetail} />
      <RequestFilters value={filters} onChange={setFilters} searchPlaceholder="Search leave type or reason"
        leaveTypes={types.data?.items.map((t) => ({ id: t.leaveTypeId, name: t.leaveTypeName }))} />
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={filtered ? <Clock /> : <ClipboardList />}
        emptyTitle={filtered ? 'No requests match' : 'No requests yet'}
        emptyText={filtered ? 'Try clearing the filters.' : 'Requests you submit will appear here.'}>
        {(d) => (
          <>
            <DataTable caption="My leave requests" columns={columns} rows={d.items} rowKey={(r) => r.id} onRowClick={(r) => setOpenId(r.id)} />
            <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
          </>
        )}
      </QueryState>
    </div>
  );
}

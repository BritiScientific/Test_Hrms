import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Search, Users } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { AssignmentHistoryRow, BalanceRow, EmployeeAssignmentRow } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { errorMessage, leaveKey, useInvalidateLeave, useLeaveAction, useLookups } from '../hooks';
import { DataTable, Pager, QueryState, type Column } from '../components/shared';
import { days, tenantToday } from '../leave-format';

const PAGE = 25;
const SOURCE: Record<string, string> = { assigned: 'Assigned', location: 'By location', default: 'Default' };

export default function EmployeeAssignmentsPage() {
  usePageTitle('Employee Leave Assignments');
  const lookups = useLookups();
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<EmployeeAssignmentRow | null>(null);
  const debounced = useDebounced(search);
  useEffect(() => setOffset(0), [debounced, departmentId]);
  const q = useQuery({
    queryKey: leaveKey('config', 'employee-assignments', debounced, departmentId, offset),
    queryFn: () => leaveApi.employeeAssignments({ search: debounced || undefined, departmentId: departmentId || undefined, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const columns: Column<EmployeeAssignmentRow>[] = [
    { key: 'employee', header: 'Employee', bare: true, render: (e) => <span><span className="block font-medium text-ink">{e.fullName}</span><span className="block text-xs text-muted">{e.employeeCode}</span></span> },
    { key: 'dept', header: 'Department', render: (e) => e.departmentName ?? <span className="text-muted">—</span> },
    { key: 'location', header: 'Location', render: (e) => e.workLocation ?? <span className="text-muted">—</span> },
    {
      key: 'policy', header: 'Leave policy',
      render: (e) => (e.policyName
        ? <>{e.policyName}{e.policyIsDefault && <Badge tone="neutral" className="ml-2">Default</Badge>}</>
        : <Badge tone="warning">No policy</Badge>),
    },
    {
      key: 'calendar', header: 'Holiday calendar',
      render: (e) => (e.calendarName
        ? <>{e.calendarName}{e.calendarSource && <Badge tone="neutral" className="ml-2">{SOURCE[e.calendarSource]}</Badge>}</>
        : <span className="text-muted">None</span>),
    },
  ];
  return (
    <div>
      <PageHeader title="Employee Leave Assignments" description="Which policy and holiday calendar each employee is on today. Select someone to change them, or to adjust their balance." />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-[1fr_16rem]">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" placeholder="Search name or code" aria-label="Search employees" />
          </div>
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Filter by department">
            <option value="">All departments</option>
            {lookups.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </div>
        <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<Users />} emptyTitle="No employees match">
          {(d) => (
            <>
              <DataTable caption="Employee leave assignments" columns={columns} rows={d.items} rowKey={(e) => e.id} onRowClick={setSelected} />
              <Pager total={d.total} limit={PAGE} offset={offset} onChange={setOffset} />
            </>
          )}
        </QueryState>
      </Card>
      {selected && <EmployeeDialog employee={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EmployeeDialog({ employee, onClose }: { employee: EmployeeAssignmentRow; onClose: () => void }) {
  const { can, canAny } = useAuth();
  const tabs = [
    { key: 'policy' as const, label: 'Leave policy' },
    { key: 'calendar' as const, label: 'Holiday calendar' },
    ...(canAny('leave.balance.adjust', 'leave.request.view_all') ? [{ key: 'balance' as const, label: 'Balance' }] : []),
  ];
  const [tab, setTab] = useState<(typeof tabs)[number]['key']>('policy');
  return (
    <Dialog open onClose={onClose} title={employee.fullName} description={[employee.employeeCode, employee.departmentName].filter(Boolean).join(' · ')} size="lg">
      <Tabs label="Employee leave settings" idBase="emp" tabs={tabs} active={tab} onChange={setTab} />
      <TabPanel idBase="emp" active={tab} className="pt-4">
        {tab === 'policy' && <Assignments employeeId={employee.id} kind="policy" canAssign={can('leave.policy.assign')} />}
        {tab === 'calendar' && <Assignments employeeId={employee.id} kind="calendar" canAssign={can('leave.policy.assign')} />}
        {tab === 'balance' && <Balances employeeId={employee.id} canAdjust={can('leave.balance.adjust')} />}
      </TabPanel>
    </Dialog>
  );
}

function Assignments({ employeeId, kind, canAssign }: { employeeId: number; kind: 'policy' | 'calendar'; canAssign: boolean }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const today = tenantToday(prefs.timezone);
  const lookups = useLookups();
  const invalidate = useInvalidateLeave();
  const isPolicy = kind === 'policy';
  const q = useQuery({
    queryKey: leaveKey('config', `${kind}-assignments`, employeeId),
    queryFn: () => (isPolicy ? leaveApi.policyAssignments(employeeId) : leaveApi.calendarAssignments(employeeId)),
  });
  const options = isPolicy
    ? (lookups.data?.policies ?? []).filter((p) => p.status === 'active').map((p) => ({ id: p.id, label: p.name }))
    : (lookups.data?.calendars ?? []).filter((c) => c.status === 'active').map((c) => ({ id: c.id, label: `${c.name} (${c.calendarYear})` }));
  const [target, setTarget] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<AssignmentHistoryRow | null>(null);
  const remove = useLeaveAction((a: AssignmentHistoryRow) => (isPolicy ? leaveApi.deletePolicyAssignment(a.id) : leaveApi.deleteCalendarAssignment(a.id)), {
    success: 'Assignment removed', onDone: () => setRemoving(null),
  });
  const end = useLeaveAction((a: AssignmentHistoryRow) => (isPolicy ? leaveApi.endPolicyAssignment(a.id, today) : leaveApi.endCalendarAssignment(a.id, today)), { success: 'Assignment ended' });

  const assign = async () => {
    if (!target || !from) return setError(`Choose a ${isPolicy ? 'policy' : 'calendar'} and a start date.`);
    setBusy(true);
    setError(null);
    try {
      await (isPolicy
        ? leaveApi.assignPolicy({ employeeIds: [employeeId], policyId: Number(target), effectiveFrom: from, effectiveTo: to || null, assignmentReason: reason || null })
        : leaveApi.assignCalendar({ employeeIds: [employeeId], calendarId: Number(target), effectiveFrom: from, effectiveTo: to || null }));
      await invalidate();
      setTarget(''); setTo(''); setReason('');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const columns: Column<AssignmentHistoryRow>[] = [
    { key: 'name', header: isPolicy ? 'Policy' : 'Calendar', bare: true, render: (a) => <span className="font-medium text-ink">{a.policyName ?? `${a.calendarName} (${a.calendarYear})`}</span> },
    { key: 'dates', header: 'Effective', className: 'whitespace-nowrap', render: (a) => `${formatDate(a.effectiveFrom, prefs)} – ${a.effectiveTo ? formatDate(a.effectiveTo, prefs) : 'open'}` },
    { key: 'by', header: 'Assigned by', render: (a) => <>{a.assignedByName ?? '—'}{a.assignmentReason && <span className="block text-xs text-muted">{a.assignmentReason}</span>}</> },
    ...(canAssign ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (a: AssignmentHistoryRow) => (
        a.effectiveFrom > today
          ? <Button size="sm" variant="ghost" onClick={() => setRemoving(a)}>Remove</Button>
          : !a.effectiveTo || a.effectiveTo >= today
            ? <Button size="sm" variant="ghost" onClick={() => end.mutate(a)}>End today</Button>
            : <span className="text-xs text-muted">Past</span>
      ),
    }] : []),
  ];

  return (
    <div className="space-y-4">
      {canAssign && (
        <div className="rounded-xl border border-line bg-slate-50/60 p-4">
          <p className="mb-3 text-sm font-medium">New assignment</p>
          {error && <div className="mb-3"><InlineAlert>{error}</InlineAlert></div>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={isPolicy ? 'Policy' : 'Calendar'} required className="sm:col-span-2">{({ id }) => (
              <Select id={id} value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Choose…</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </Select>
            )}</Field>
            <Field label="Effective from" required hint="An open-ended assignment ends the day before">{({ id, describedBy }) => <Input id={id} type="date" aria-describedby={describedBy} value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="Effective to" hint="Blank means open-ended">{({ id, describedBy }) => <Input id={id} type="date" aria-describedby={describedBy} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
            {isPolicy && <Field label="Reason" className="sm:col-span-2">{({ id }) => <Input id={id} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="For example: moved to a permanent role" />}</Field>}
          </div>
          <Button className="mt-3" size="sm" onClick={assign} loading={busy}>Assign</Button>
        </div>
      )}
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No assignments" emptyText={isPolicy ? 'This employee follows the default policy.' : 'This employee follows their location or the default calendar.'}>
        {(d) => <DataTable caption="Assignment history" columns={columns} rows={d} rowKey={(a) => a.id} minWidth="34rem" />}
      </QueryState>
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} loading={remove.isPending}
        title="Remove this future assignment?" confirmLabel="Remove" tone="destructive" description="It hasn’t started, so nothing has been based on it yet." />
    </div>
  );
}

function Balances({ employeeId, canAdjust }: { employeeId: number; canAdjust: boolean }) {
  const me = useMe();
  const thisYear = Number(tenantToday(me.tenant.preferences.timezone).slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [adjusting, setAdjusting] = useState<{ row: BalanceRow; kind: 'credit' | 'debit' | 'encash' } | null>(null);
  const q = useQuery({ queryKey: leaveKey('employee-balances', employeeId, year), queryFn: () => leaveApi.employeeBalances(employeeId, year) });
  const columns: Column<BalanceRow>[] = [
    { key: 'type', header: 'Leave type', bare: true, render: (b) => <span className="font-medium text-ink">{b.leaveTypeName}</span> },
    { key: 'credited', header: 'Credited', className: 'tabular', render: (b) => days(b.opening + b.accrued + b.carriedForward + b.adjusted + b.compOff) },
    { key: 'used', header: 'Used', className: 'tabular', render: (b) => days(b.used) },
    { key: 'pending', header: 'Pending', className: 'tabular', render: (b) => days(b.pending) },
    { key: 'available', header: 'Available', className: 'tabular font-semibold', render: (b) => days(b.available) },
    ...(canAdjust ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (b: BalanceRow) => (
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="outline" onClick={() => setAdjusting({ row: b, kind: 'credit' })}>Credit</Button>
          <Button size="sm" variant="outline" onClick={() => setAdjusting({ row: b, kind: 'debit' })}>Debit</Button>
          {b.allowEncashment && <Button size="sm" variant="ghost" onClick={() => setAdjusting({ row: b, kind: 'encash' })}>Encash</Button>}
        </div>
      ),
    }] : []),
  ];
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Select className="w-28!" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Leave year">
          {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2].map((y) => <option key={y} value={y}>{y}</option>)}
        </Select>
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyTitle="No balances for this year">
        {(d) => <DataTable caption="Employee balances" columns={columns} rows={d.items} rowKey={(b) => b.leaveTypeId} minWidth="38rem" />}
      </QueryState>
      {adjusting && <AdjustDialog employeeId={employeeId} year={year} {...adjusting} onClose={() => setAdjusting(null)} />}
    </div>
  );
}

function AdjustDialog({ employeeId, year, row, kind, onClose }: { employeeId: number; year: number; row: BalanceRow; kind: 'credit' | 'debit' | 'encash'; onClose: () => void }) {
  const invalidate = useInvalidateLeave();
  const key = useRef(crypto.randomUUID());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = kind === 'credit' ? 'Credit' : kind === 'debit' ? 'Debit' : 'Encash';
  const submit = async () => {
    const n = Number(amount);
    if (!(n > 0)) return setError('Enter the number of days.');
    if (note.trim().length < 3) return setError('Give a reason. It is kept in the ledger and the audit log.');
    setBusy(true);
    setError(null);
    const body = { employeeId, leaveTypeId: row.leaveTypeId, year, days: n, note: note.trim() };
    try {
      await (kind === 'encash'
        ? leaveApi.encashBalance(body, key.current)
        : leaveApi.adjustBalance({ ...body, direction: kind }, key.current));
      await invalidate();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      key.current = crypto.randomUUID();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`${label} ${row.leaveTypeName}`} description={`${days(row.available)} available in ${year}. This adds a ledger transaction and an audit entry.`}
      footer={<><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={busy}>{label}</Button></>}>
      <div className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label="Days" required>{({ id }) => <Input id={id} data-autofocus type="number" min="0.5" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Reason" required>{({ id }) => <Input id={id} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      </div>
    </Dialog>
  );
}

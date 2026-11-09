import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Archive, CheckCircle2, Pencil, Play, Plus } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Field, Select } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { AccrualRuleConfig, AccrualRunSummary, CarryRuleConfig, CarryRunSummary, EntitlementConfig } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { errorMessage, leaveKey, useInvalidateLeave, useLeaveAction } from '../hooks';
import { FormDialog, type FormField } from '../components/FormDialog';
import { DataTable, QueryState, RuleStatusBadge, type Column } from '../components/shared';
import { FREQUENCY_OPTIONS, days, labelOf, tenantToday } from '../leave-format';

type TabKey = 'accrual' | 'carry' | 'expiry' | 'encashment';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'accrual', label: 'Accrual Rules' },
  { key: 'carry', label: 'Carry Forward' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'encashment', label: 'Encashment' },
];

const entitlementOptions = (ents: EntitlementConfig[]) =>
  ents.map((e) => ({ value: e.id, label: `${e.policyName} · ${e.leaveTypeName}` }));

export default function AccrualCarryForwardPage() {
  usePageTitle('Accrual & Carry Forward');
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as TabKey | null;
  const tab = TABS.some((t) => t.key === raw) ? raw! : 'accrual';
  return (
    <div>
      <PageHeader title="Accrual & Carry Forward"
        description="How leave is credited, and what happens to unused days at the end of a leave year. Rules start as drafts. Activating a rule never rewrites past transactions." />
      <Card>
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Rule types" tabs={TABS} active={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
        </div>
        <TabPanel active={tab}>
          {tab === 'accrual' && <AccrualTab />}
          {tab === 'carry' && <CarryTab view="carry" />}
          {tab === 'expiry' && <CarryTab view="expiry" />}
          {tab === 'encashment' && <CarryTab view="encashment" />}
        </TabPanel>
      </Card>
    </div>
  );
}

function RowActions<T extends { status: string }>({ row, onEdit, onActivate, onArchive }: { row: T; onEdit: () => void; onActivate: () => void; onArchive: () => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {row.status === 'draft' && <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={onEdit}>Edit</Button>}
      {row.status === 'draft' && <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={onActivate}>Activate</Button>}
      {row.status !== 'archived' && <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={onArchive}>Archive</Button>}
    </div>
  );
}

// --------------------------------------------------------------------- accrual --

function AccrualTab() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const q = useQuery({ queryKey: leaveKey('config', 'accrual-rules'), queryFn: leaveApi.accrualRules });
  const ents = useQuery({ queryKey: leaveKey('config', 'entitlements', 'all'), queryFn: () => leaveApi.entitlements() });
  const [form, setForm] = useState<AccrualRuleConfig | 'new' | null>(null);
  const [activating, setActivating] = useState<AccrualRuleConfig | null>(null);
  const [archiving, setArchiving] = useState<AccrualRuleConfig | null>(null);
  const archive = useLeaveAction((r: AccrualRuleConfig) => leaveApi.archiveAccrualRule(r.id), { success: 'Rule archived', onDone: () => setArchiving(null) });

  const fields = (editing: boolean): FormField[] => [
    { name: 'policyEntitlementId', label: 'Leave policy and type', kind: 'select', required: true, disabled: editing, wide: true, options: entitlementOptions(ents.data ?? []) },
    { name: 'accrualFrequency', label: 'Accrual method', kind: 'select', required: true, options: FREQUENCY_OPTIONS },
    { name: 'accrualAmount', label: 'Days credited each time', kind: 'number', required: true, showIf: (v) => v.accrualFrequency !== 'manual', hint: 'Example: 18 days a year, credited monthly, is 1.5' },
    { name: 'creditTiming', label: 'Credit at', kind: 'select', required: true, showIf: (v) => ['annual', 'monthly', 'quarterly'].includes(v.accrualFrequency), options: [{ value: 'period_start', label: 'Start of the period' }, { value: 'period_end', label: 'End of the period' }] },
    { name: 'accrualStartRule', label: 'New joiners start', kind: 'select', required: true, showIf: (v) => ['annual', 'monthly', 'quarterly'].includes(v.accrualFrequency), options: [{ value: 'joining_date', label: 'In the period they join' }, { value: 'next_period', label: 'In the next full period' }] },
    { name: 'maximumBalance', label: 'Maximum balance (days)', kind: 'number', hint: 'Credits stop at this balance. Blank means no limit.' },
    { name: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
    { name: 'effectiveTo', label: 'Effective to', kind: 'date' },
    { name: 'prorationEnabled', label: 'Prorate the joining period', kind: 'checkbox', hint: 'Someone who joins mid-period gets a share of the credit', showIf: (v) => ['annual', 'monthly', 'quarterly'].includes(v.accrualFrequency) },
  ];

  const columns: Column<AccrualRuleConfig>[] = [
    { key: 'what', header: 'Policy and type', bare: true, render: (r) => <span><span className="block font-medium text-ink">{r.leaveTypeName}</span><span className="block text-xs text-muted">{r.policyName}</span></span> },
    { key: 'freq', header: 'Method', render: (r) => labelOf(FREQUENCY_OPTIONS, r.accrualFrequency) },
    { key: 'amount', header: 'Credit', className: 'tabular', render: (r) => (r.accrualFrequency === 'manual' ? '—' : `${days(r.accrualAmount)} d`) },
    { key: 'cap', header: 'Maximum balance', className: 'tabular', render: (r) => (r.maximumBalance ? `${days(r.maximumBalance)} d` : '—') },
    { key: 'prorate', header: 'Proration', render: (r) => (r.prorationEnabled ? 'Yes' : 'No') },
    { key: 'effective', header: 'Effective', className: 'whitespace-nowrap', render: (r) => `${formatDate(r.effectiveFrom, prefs)}${r.effectiveTo ? ` – ${formatDate(r.effectiveTo, prefs)}` : ' onward'}` },
    { key: 'status', header: 'Status', render: (r) => <RuleStatusBadge status={r.status} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (r: AccrualRuleConfig) => <RowActions row={r} onEdit={() => setForm(r)} onActivate={() => setActivating(r)} onArchive={() => setArchiving(r)} />,
    }] : []),
  ];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line p-4">
        {can('leave.balance.adjust') && <RunAccrual />}
        {canManage && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setForm('new')}>New accrual rule</Button>}
      </div>
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No accrual rules yet" emptyText="Without a rule, leave is only credited manually.">
        {(d) => <DataTable caption="Accrual rules" columns={columns} rows={d} rowKey={(r) => r.id} minWidth="68rem" />}
      </QueryState>
      {form && (
        <FormDialog open title={form === 'new' ? 'New accrual rule' : 'Edit draft rule'} fields={fields(form !== 'new')}
          initial={form === 'new'
            ? { accrualFrequency: 'monthly', creditTiming: 'period_start', accrualStartRule: 'joining_date', effectiveFrom: tenantToday(prefs.timezone) }
            : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => (form === 'new' ? leaveApi.createAccrualRule(b) : leaveApi.updateAccrualRule(form.id, b))} />
      )}
      {activating && <ActivateAccrual rule={activating} onClose={() => setActivating(null)} />}
      <ConfirmDialog open={!!archiving} onClose={() => setArchiving(null)} onConfirm={() => archiving && archive.mutate(archiving)} loading={archive.isPending}
        title="Archive this rule?" confirmLabel="Archive" tone="destructive"
        description="It stops crediting from now on. Days already credited stay in the balances." />
    </div>
  );
}

function ActivateAccrual({ rule, onClose }: { rule: AccrualRuleConfig; onClose: () => void }) {
  const impact = useQuery({ queryKey: leaveKey('config', 'accrual-impact', rule.id), queryFn: () => leaveApi.accrualImpact(rule.id) });
  const activate = useLeaveAction(() => leaveApi.activateAccrualRule(rule.id), { success: 'Rule activated', onDone: onClose });
  return (
    <Dialog open onClose={onClose} title={`Activate ${rule.leaveTypeName} accrual?`} size="sm"
      footer={<><Button variant="outline" onClick={onClose}>Back</Button><Button onClick={() => activate.mutate(undefined)} loading={activate.isPending} disabled={impact.isPending}>Activate</Button></>}>
      <QueryState query={impact} loadingRows={3}>
        {(i) => (
          <div className="space-y-3 text-sm">
            <InlineAlert tone="warning" title="This changes employee balances">
              {i.employeesOnPolicy} employees are on {rule.policyName}. The next accrual run would credit up to {days(i.daysDueNow)} days in total for this year’s periods that are already due.
            </InlineAlert>
            <p className="text-muted">{i.note} Past transactions don’t change. If this rule overlaps another active rule, activation is refused.</p>
          </div>
        )}
      </QueryState>
    </Dialog>
  );
}

/** Preview first, then confirm: nothing is written until the second step. */
function RunAccrual() {
  const { notify } = useToast();
  const invalidate = useInvalidateLeave();
  const [preview, setPreview] = useState<AccrualRunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await leaveApi.runAccrual(dryRun);
      if (dryRun) setPreview(r);
      else {
        await invalidate();
        setPreview(null);
        notify({ tone: 'success', title: 'Accrual complete', description: `${days(r.creditedDays)} days credited to ${r.employees} employees.` });
      }
    } catch (e) {
      notify({ tone: 'error', title: 'Accrual failed', description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" icon={<Play className="size-3.5" />} loading={busy && !preview} onClick={() => run(true)}>Run accrual</Button>
      {preview && (
        <Dialog open onClose={() => setPreview(null)} title="Run accrual" size="lg" description={`Periods due up to ${preview.asOf}. Safe to repeat: each period is credited once.`}
          footer={<><Button variant="outline" onClick={() => setPreview(null)}>Close</Button><Button onClick={() => run(false)} loading={busy} disabled={preview.periods === 0}>Credit {days(preview.creditedDays)} days</Button></>}>
          <p className="mb-3 text-sm">
            {preview.periods === 0 ? 'Nothing is due: every period up to today has already been credited.' : `${preview.periods} credits for ${preview.employees} employees.`}
            {preview.cappedDays > 0 && ` ${days(preview.cappedDays)} days won’t be credited because of maximum-balance limits.`}
          </p>
          {preview.items.length > 0 && (
            <ul className="divide-y divide-line text-sm">
              {preview.items.slice(0, 50).map((i) => (
                <li key={`${i.employeeId}-${i.leaveTypeName}-${i.periodKey}`} className="flex justify-between gap-3 py-1.5">
                  <span className="min-w-0 truncate">{i.employeeName} · {i.leaveTypeName}</span>
                  <span className="shrink-0 text-muted tabular">{i.periodKey} · {days(i.days)} d</span>
                </li>
              ))}
              {preview.items.length > 50 && <li className="py-1.5 text-xs text-muted">and more</li>}
            </ul>
          )}
        </Dialog>
      )}
    </>
  );
}

// ------------------------------------------------- carry forward, expiry, encashment --

function CarryTab({ view }: { view: 'carry' | 'expiry' | 'encashment' }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const q = useQuery({ queryKey: leaveKey('config', 'carry-rules'), queryFn: leaveApi.carryRules });
  const ents = useQuery({ queryKey: leaveKey('config', 'entitlements', 'all'), queryFn: () => leaveApi.entitlements() });
  const [form, setForm] = useState<CarryRuleConfig | 'new' | null>(null);
  const [archiving, setArchiving] = useState<CarryRuleConfig | null>(null);
  const activate = useLeaveAction((r: CarryRuleConfig) => leaveApi.activateCarryRule(r.id), { success: 'Rule activated' });
  const archive = useLeaveAction((r: CarryRuleConfig) => leaveApi.archiveCarryRule(r.id), { success: 'Rule archived', onDone: () => setArchiving(null) });

  const fields = (editing: boolean): FormField[] => [
    { name: 'policyEntitlementId', label: 'Leave policy and type', kind: 'select', required: true, disabled: editing, wide: true, hint: 'The entitlement must allow carry-forward before the rule can be activated.', options: entitlementOptions(ents.data ?? []) },
    { name: 'maximumCarryForward', label: 'Most days carried', kind: 'number', hint: 'The excess lapses at year end. Blank means no limit.' },
    { name: 'maximumBalance', label: 'Maximum total balance', kind: 'number', hint: 'Includes what the new year already holds' },
    { name: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
    { name: 'effectiveTo', label: 'Effective to', kind: 'date' },
    { name: 'isEnabled', label: 'Carry forward is on', kind: 'checkbox' },
    { name: 'expiryEnabled', label: 'Carried days expire', kind: 'checkbox' },
    { name: 'expiryDateRule', label: 'Expires', kind: 'select', required: true, showIf: (v) => !!v.expiryEnabled, options: [{ value: 'months_after_carry', label: 'A number of months into the new year' }, { value: 'end_of_next_year', label: 'At the end of the new year' }] },
    { name: 'expiryAfterMonths', label: 'Months into the new year', kind: 'number', step: '1', required: true, showIf: (v) => !!v.expiryEnabled && v.expiryDateRule !== 'end_of_next_year' },
    { name: 'encashmentAllowed', label: 'Carried days are eligible for encashment', kind: 'checkbox' },
  ];

  const base: Column<CarryRuleConfig>[] = [
    { key: 'what', header: 'Policy and type', bare: true, render: (r) => <span><span className="block font-medium text-ink">{r.leaveTypeName}</span><span className="block text-xs text-muted">{r.policyName}</span></span> },
  ];
  const specific: Record<typeof view, Column<CarryRuleConfig>[]> = {
    carry: [
      { key: 'max', header: 'Most days carried', className: 'tabular', render: (r) => (r.maximumCarryForward != null ? days(r.maximumCarryForward) : 'No limit') },
      { key: 'total', header: 'Maximum total', className: 'tabular', render: (r) => (r.maximumBalance ? days(r.maximumBalance) : 'No limit') },
      { key: 'allowed', header: 'Policy allows it', render: (r) => (r.allowCarryForward ? 'Yes' : <Badge tone="warning">Not allowed</Badge>) },
    ],
    expiry: [
      { key: 'on', header: 'Expires', render: (r) => (r.expiryEnabled ? 'Yes' : 'Never') },
      { key: 'when', header: 'When', render: (r) => (!r.expiryEnabled ? '—' : r.expiryDateRule === 'end_of_next_year' ? 'End of the new year' : `${r.expiryAfterMonths} months into the new year`) },
    ],
    encashment: [
      { key: 'rule', header: 'Carried days eligible', render: (r) => (r.encashmentAllowed ? 'Yes' : 'No') },
      { key: 'policy', header: 'Policy allows encashment', render: (r) => (r.allowEncashment ? 'Yes' : <Badge tone="neutral">No</Badge>) },
    ],
  };
  const columns: Column<CarryRuleConfig>[] = [
    ...base,
    ...specific[view],
    { key: 'effective', header: 'Effective', className: 'whitespace-nowrap', render: (r) => `${formatDate(r.effectiveFrom, prefs)}${r.effectiveTo ? ` – ${formatDate(r.effectiveTo, prefs)}` : ' onward'}` },
    { key: 'status', header: 'Status', render: (r) => <RuleStatusBadge status={r.status} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (r: CarryRuleConfig) => <RowActions row={r} onEdit={() => setForm(r)} onActivate={() => activate.mutate(r)} onArchive={() => setArchiving(r)} />,
    }] : []),
  ];

  return (
    <div>
      {view === 'encashment' && (
        <div className="border-b border-line p-4">
          <InlineAlert tone="info">
            HR records an encashment from <strong>Employee Leave Assignments</strong>, which debits the balance. The payment itself isn’t handled here, because there’s no payroll module yet.
          </InlineAlert>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line p-4">
        {view === 'carry' && can('leave.balance.adjust') && <RunCarryForward />}
        {view === 'expiry' && can('leave.balance.adjust') && <RunExpiry />}
        {canManage && <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setForm('new')}>New rule</Button>}
      </div>
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No carry-forward rules yet" emptyText="Without a rule, unused days stay in their own year and don’t move forward.">
        {(d) => <DataTable caption="Carry-forward rules" columns={columns} rows={d} rowKey={(r) => r.id} minWidth="60rem" />}
      </QueryState>
      {form && (
        <FormDialog open title={form === 'new' ? 'New carry-forward rule' : 'Edit draft rule'} fields={fields(form !== 'new')}
          initial={form === 'new' ? { isEnabled: true, expiryDateRule: 'months_after_carry', effectiveFrom: tenantToday(prefs.timezone) } : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => {
            if (!b.expiryEnabled) b.expiryAfterMonths = null;
            if (b.expiryDateRule == null) b.expiryDateRule = 'months_after_carry';
            return form === 'new' ? leaveApi.createCarryRule(b) : leaveApi.updateCarryRule(form.id, b);
          }} />
      )}
      <ConfirmDialog open={!!archiving} onClose={() => setArchiving(null)} onConfirm={() => archiving && archive.mutate(archiving)} loading={archive.isPending}
        title="Archive this rule?" confirmLabel="Archive" tone="destructive" description="Years already closed aren’t affected." />
    </div>
  );
}

function RunCarryForward() {
  const me = useMe();
  const { notify } = useToast();
  const invalidate = useInvalidateLeave();
  const thisYear = Number(tenantToday(me.tenant.preferences.timezone).slice(0, 4));
  const [open, setOpen] = useState(false);
  const [fromYear, setFromYear] = useState(thisYear - 1);
  const [preview, setPreview] = useState<CarryRunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await leaveApi.runCarryForward(fromYear, dryRun);
      if (dryRun) setPreview(r);
      else {
        await invalidate();
        setOpen(false);
        setPreview(null);
        notify({ tone: 'success', title: `${fromYear} closed`, description: `${days(r.totalCarried)} days carried, ${days(r.totalLapsed)} lapsed.` });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" icon={<Play className="size-3.5" />} onClick={() => { setOpen(true); setPreview(null); setError(null); }}>Close a leave year</Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Close a leave year" size="lg" description="Carries unused days into the next year under the active rules, and lapses the rest. Safe to repeat."
          footer={
            <>
              <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
              <Button variant="outline" onClick={() => run(true)} loading={busy && !preview}>Preview</Button>
              {preview && <Button onClick={() => run(false)} loading={busy} disabled={!preview.lines.length}>Carry {days(preview.totalCarried)} days</Button>}
            </>
          }>
          <div className="space-y-3">
            {error && <InlineAlert>{error}</InlineAlert>}
            <Field label="Leave year to close">{({ id }) => (
              <Select id={id} value={fromYear} onChange={(e) => { setFromYear(Number(e.target.value)); setPreview(null); }}>
                {[thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            )}</Field>
            {preview && (
              <>
                <p className="text-sm">{days(preview.totalCarried)} days carried to {preview.toYear}, {days(preview.totalLapsed)} lapse.{preview.skippedAlreadyClosed > 0 && ` ${preview.skippedAlreadyClosed} balances were already closed.`}</p>
                {preview.balancesWithPending > 0 && (
                  <InlineAlert tone="warning">{preview.balancesWithPending} balances still have requests waiting for a decision. If those are rejected later, the days return to {fromYear}, not to {preview.toYear}.</InlineAlert>
                )}
                <ul className="divide-y divide-line text-sm">
                  {preview.lines.slice(0, 50).map((l) => (
                    <li key={`${l.employeeId}-${l.leaveTypeName}`} className="flex justify-between gap-3 py-1.5">
                      <span className="min-w-0 truncate">{l.employeeName} · {l.leaveTypeName}</span>
                      <span className="shrink-0 text-muted tabular">{days(l.carried)} carried, {days(l.lapsed)} lapse</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}

function RunExpiry() {
  const { notify } = useToast();
  const invalidate = useInvalidateLeave();
  const [preview, setPreview] = useState<{ asOf: string; creditsExpired: number; expiredDays: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await leaveApi.runExpiry(dryRun);
      if (dryRun) setPreview(r);
      else {
        await invalidate();
        setPreview(null);
        notify({ tone: 'success', title: 'Expiry complete', description: `${days(r.expiredDays)} days expired.` });
      }
    } catch (e) {
      notify({ tone: 'error', title: 'Expiry failed', description: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="outline" icon={<Play className="size-3.5" />} loading={busy && !preview} onClick={() => run(true)}>Run expiry</Button>
      {preview && (
        <Dialog open onClose={() => setPreview(null)} title="Run expiry" size="sm"
          footer={<><Button variant="outline" onClick={() => setPreview(null)}>Close</Button><Button variant="destructive" onClick={() => run(false)} loading={busy} disabled={preview.creditsExpired === 0}>Expire {days(preview.expiredDays)} days</Button></>}>
          <p className="text-sm">
            {preview.creditsExpired === 0
              ? 'Nothing has expired as of today.'
              : `${preview.creditsExpired} carried or comp off credits have passed their expiry date. Only the unused part of each one expires.`}
          </p>
        </Dialog>
      )}
    </>
  );
}

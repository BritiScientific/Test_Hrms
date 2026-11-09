import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Archive, CheckCircle2, Pencil, Plus, ScrollText, Star, Trash2 } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { EntitlementConfig, PolicyConfig } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { leaveKey, useLeaveAction, useLookups } from '../hooks';
import { FormDialog, type FormField } from '../components/FormDialog';
import { DataTable, QueryState, RuleStatusBadge, type Column } from '../components/shared';
import { days, tenantToday } from '../leave-format';

const policyFields = (editing: boolean): FormField[] => [
  { name: 'code', label: 'Code', required: !editing, disabled: editing, placeholder: 'PERMANENT' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Permanent Employee Policy' },
  { name: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true },
  { name: 'effectiveTo', label: 'Effective to', kind: 'date', hint: 'Blank means open-ended' },
  { name: 'description', label: 'Description', kind: 'textarea' },
];

export default function LeavePoliciesPage() {
  usePageTitle('Leave Policies');
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const q = useQuery({ queryKey: leaveKey('config', 'policies'), queryFn: leaveApi.policies });
  const [form, setForm] = useState<PolicyConfig | 'new' | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [activating, setActivating] = useState<PolicyConfig | null>(null);
  const [archiving, setArchiving] = useState<PolicyConfig | null>(null);
  const setDefault = useLeaveAction((p: PolicyConfig) => leaveApi.updatePolicy(p.id, { isDefault: !p.isDefault }), { success: 'Default policy updated' });
  const archive = useLeaveAction((p: PolicyConfig) => leaveApi.archivePolicy(p.id), { success: 'Policy archived', onDone: () => setArchiving(null) });
  const current = q.data?.find((p) => p.id === selected) ?? null;

  const columns: Column<PolicyConfig>[] = [
    {
      key: 'name', header: 'Policy', bare: true,
      render: (p) => (
        <span>
          <span className="block font-medium text-ink">{p.name}{p.isDefault && <Badge tone="primary" className="ml-2">Default</Badge>}</span>
          <span className="block font-mono text-xs text-muted">{p.code}</span>
        </span>
      ),
    },
    { key: 'effective', header: 'Effective', className: 'whitespace-nowrap', render: (p) => `${formatDate(p.effectiveFrom, prefs)}${p.effectiveTo ? ` – ${formatDate(p.effectiveTo, prefs)}` : ' onward'}` },
    { key: 'types', header: 'Leave types', className: 'tabular', render: (p) => p.entitlementCount },
    { key: 'employees', header: 'Assigned now', className: 'tabular', render: (p) => p.employeeCount },
    { key: 'status', header: 'Status', render: (p) => <RuleStatusBadge status={p.status} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (p: PolicyConfig) => (
        <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          {p.status !== 'archived' && <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(p)}>Edit</Button>}
          {p.status === 'draft' && <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={() => setActivating(p)}>Activate</Button>}
          {p.status === 'active' && <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => setDefault.mutate(p)}>{p.isDefault ? 'Remove default' : 'Make default'}</Button>}
          {p.status !== 'archived' && <Button size="sm" variant="ghost" icon={<Archive className="size-3.5" />} onClick={() => setArchiving(p)}>Archive</Button>}
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader title="Leave Policies" description="A policy says which leave an employee gets. Employees follow the policy assigned to them, or the default policy."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New policy</Button>} />
      <Card>
        <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={<ScrollText />} emptyTitle="No policies yet" emptyText="Create a policy, add leave types to it, then activate it.">
          {(d) => <DataTable caption="Leave policies" columns={columns} rows={d} rowKey={(p) => p.id} onRowClick={(p) => setSelected(p.id)} minWidth="60rem" />}
        </QueryState>
      </Card>
      {current && <Entitlements policy={current} canManage={canManage} />}
      {!current && q.data && q.data.length > 0 && <p className="mt-3 text-sm text-muted">Select a policy to see and change its leave types.</p>}

      {form && (
        <FormDialog open title={form === 'new' ? 'New leave policy' : `Edit ${form.name}`} fields={policyFields(form !== 'new')}
          description={form === 'new' ? 'New policies start as drafts. Nobody is affected until you activate it.' : undefined}
          initial={form === 'new' ? { effectiveFrom: tenantToday(prefs.timezone) } : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => (form === 'new' ? leaveApi.createPolicy(b) : leaveApi.updatePolicy(form.id, b))} />
      )}
      {activating && <ActivatePolicy policy={activating} onClose={() => setActivating(null)} />}
      <ConfirmDialog open={!!archiving} onClose={() => setArchiving(null)} onConfirm={() => archiving && archive.mutate(archiving)} loading={archive.isPending}
        title={`Archive ${archiving?.name}?`} confirmLabel="Archive" tone="destructive"
        description="It can no longer be assigned. Past requests keep pointing to it. A policy that employees are still assigned to cannot be archived." />
    </div>
  );
}

function ActivatePolicy({ policy, onClose }: { policy: PolicyConfig; onClose: () => void }) {
  const check = useQuery({ queryKey: leaveKey('config', 'policy-check', policy.id), queryFn: () => leaveApi.policyCheck(policy.id) });
  const activate = useLeaveAction(() => leaveApi.activatePolicy(policy.id), { success: 'Policy activated', onDone: onClose });
  const blocked = !!check.data?.errors.length;
  return (
    <Dialog open onClose={onClose} title={`Activate ${policy.name}?`} size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Back</Button>
          <Button onClick={() => activate.mutate(undefined)} disabled={blocked || check.isPending} loading={activate.isPending}>Activate</Button>
        </>
      }>
      <QueryState query={check} loadingRows={3}>
        {(c) => (
          <div className="space-y-3 text-sm">
            {c.errors.map((e) => <InlineAlert key={e}>{e}</InlineAlert>)}
            {c.warnings.map((w) => <InlineAlert key={w} tone="warning">{w}</InlineAlert>)}
            {!c.errors.length && <p className="text-muted">Employees assigned to this policy can then apply for its leave types. Past balances and transactions don’t change.</p>}
          </div>
        )}
      </QueryState>
    </Dialog>
  );
}

function Entitlements({ policy, canManage }: { policy: PolicyConfig; canManage: boolean }) {
  const lookups = useLookups();
  const q = useQuery({ queryKey: leaveKey('config', 'entitlements', policy.id), queryFn: () => leaveApi.entitlements(policy.id) });
  const [form, setForm] = useState<EntitlementConfig | 'new' | null>(null);
  const [removing, setRemoving] = useState<EntitlementConfig | null>(null);
  const remove = useLeaveAction((e: EntitlementConfig) => leaveApi.deleteEntitlement(e.id), { success: 'Leave type removed', onDone: () => setRemoving(null) });
  const used = new Set(q.data?.map((e) => e.leaveTypeId));
  const available = (lookups.data?.leaveTypes ?? []).filter((t) => t.isActive && !used.has(t.id));

  const fields = (editing: boolean): FormField[] => [
    ...(editing ? [] : [{ name: 'leaveTypeId', label: 'Leave type', kind: 'select' as const, required: true, options: available.map((t) => ({ value: t.id, label: t.name })) }]),
    { name: 'annualEntitlement', label: 'Annual entitlement (days)', kind: 'number', required: true, hint: 'What the employee gets in a year. Crediting is set up under Accrual & Carry Forward.' },
    { name: 'maxConsecutiveDays', label: 'Maximum consecutive days', kind: 'number', hint: 'Blank follows the leave type' },
    { name: 'allowHalfDayChoice', label: 'Half days', kind: 'select', hint: 'Can only restrict what the leave type allows', options: [{ value: 'yes', label: 'Allowed' }, { value: 'no', label: 'Not allowed' }] },
    { name: 'allowNegativeBalance', label: 'Balance may go negative', kind: 'checkbox', hint: 'Usually only for unpaid leave' },
    { name: 'allowCarryForward', label: 'Unused days can carry forward', kind: 'checkbox' },
    { name: 'allowEncashment', label: 'Unused days can be encashed', kind: 'checkbox' },
  ];
  const submitBody = (b: Record<string, any>) => {
    const { allowHalfDayChoice, ...rest } = b;
    return { ...rest, allowHalfDay: allowHalfDayChoice === 'yes' ? true : allowHalfDayChoice === 'no' ? false : null };
  };

  const columns: Column<EntitlementConfig>[] = [
    { key: 'type', header: 'Leave type', bare: true, render: (e) => <span className="font-medium text-ink">{e.leaveTypeName}</span> },
    { key: 'annual', header: 'Per year', className: 'tabular', render: (e) => `${days(e.annualEntitlement)} d` },
    {
      key: 'credit', header: 'Crediting',
      render: (e) => (e.hasActiveAccrual || e.annualEntitlement === 0 ? (e.annualEntitlement === 0 ? '—' : 'Automatic') : <Badge tone="warning">No accrual rule</Badge>),
    },
    {
      key: 'allow', header: 'Allowed', className: 'text-xs text-slate-600',
      render: (e) => [e.allowNegativeBalance && 'Negative balance', e.allowCarryForward && 'Carry forward', e.allowEncashment && 'Encashment',
        e.allowHalfDay === false && 'No half days', e.maxConsecutiveDays && `Max ${days(e.maxConsecutiveDays)} d`].filter(Boolean).join(' · ') || '—',
    },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (e: EntitlementConfig) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(e)}>Edit</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(e)}>Remove</Button>
        </div>
      ),
    }] : []),
  ];

  return (
    <Card className="mt-5">
      <CardHeader title={`Leave types in ${policy.name}`} description="What employees on this policy are entitled to"
        actions={canManage && policy.status !== 'archived' && <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setForm('new')} disabled={!available.length}>Add leave type</Button>} />
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No leave types in this policy yet" emptyText="Add at least one before activating it.">
        {(d) => <DataTable caption="Entitlements" columns={columns} rows={d} rowKey={(e) => e.id} />}
      </QueryState>
      {form && (
        <FormDialog open title={form === 'new' ? 'Add leave type to the policy' : `Edit ${form.leaveTypeName}`} fields={fields(form !== 'new')}
          initial={form === 'new' ? { annualEntitlement: 0, policyId: policy.id } : {
            ...(form as unknown as Record<string, unknown>),
            allowHalfDayChoice: form.allowHalfDay === null ? '' : form.allowHalfDay ? 'yes' : 'no',
          }}
          onClose={() => setForm(null)}
          onSubmit={(b) => (form === 'new'
            ? leaveApi.createEntitlement({ ...submitBody(b), policyId: policy.id })
            : leaveApi.updateEntitlement(form.id, submitBody(b)))} />
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} loading={remove.isPending}
        title={`Remove ${removing?.leaveTypeName} from this policy?`} confirmLabel="Remove" tone="destructive"
        description="This isn’t possible once requests have been made under it, or while it has accrual or carry-forward rules." />
    </Card>
  );
}

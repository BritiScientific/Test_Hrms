import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pencil, Plus, Power, Tags } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { CompOffRuleConfig, LeaveTypeConfig } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { useMe } from '@/app/providers/AuthProvider';
import { leaveKey, useLeaveAction } from '../hooks';
import { FormDialog, type FormField } from '../components/FormDialog';
import { DataTable, QueryState, type Column } from '../components/shared';
import { CATEGORY_OPTIONS, days, labelOf, tenantToday } from '../leave-format';

const typeFields = (editing: boolean): FormField[] => [
  { name: 'code', label: 'Code', required: !editing, disabled: editing, placeholder: 'CL', hint: editing ? 'A code cannot change once created.' : 'Short, like CL or EL' },
  { name: 'name', label: 'Name', required: true, placeholder: 'Casual Leave' },
  { name: 'category', label: 'Category', kind: 'select', required: true, options: CATEGORY_OPTIONS },
  { name: 'minNoticeDays', label: 'Minimum notice (days)', kind: 'number', step: '1', hint: 'How far ahead it must be requested' },
  { name: 'maxConsecutiveDays', label: 'Maximum consecutive days', kind: 'number', hint: 'Blank means no limit. A policy can override this.' },
  { name: 'description', label: 'Description', kind: 'textarea' },
  { name: 'isPaid', label: 'Paid leave', kind: 'checkbox', hint: 'Untick for Loss of Pay and similar' },
  { name: 'allowHalfDay', label: 'Half days allowed', kind: 'checkbox' },
  { name: 'requiresAttachment', label: 'Supporting document required', kind: 'checkbox' },
  { name: 'requiresContactDetails', label: 'Contact details during leave required', kind: 'checkbox' },
  { name: 'includeNonWorkingDays', label: 'Charge weekly offs and holidays', kind: 'checkbox', hint: 'For leave counted in calendar days, such as maternity leave' },
  { name: 'allowBackdated', label: 'Past dates allowed', kind: 'checkbox' },
  { name: 'maxBackdatedDays', label: 'How many days back', kind: 'number', step: '1', hint: 'Blank means no limit', showIf: (v) => !!v.allowBackdated },
];

export default function LeaveTypesPage() {
  usePageTitle('Leave Types');
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const q = useQuery({ queryKey: leaveKey('config', 'types'), queryFn: leaveApi.types });
  const [form, setForm] = useState<LeaveTypeConfig | 'new' | null>(null);
  const [toggling, setToggling] = useState<LeaveTypeConfig | null>(null);
  const toggle = useLeaveAction((t: LeaveTypeConfig) => leaveApi.updateType(t.id, { isActive: !t.isActive }), {
    success: 'Leave type updated', onDone: () => setToggling(null),
  });

  const columns: Column<LeaveTypeConfig>[] = [
    { key: 'name', header: 'Leave type', bare: true, render: (t) => <span><span className="block font-medium text-ink">{t.name}</span><span className="block font-mono text-xs text-muted">{t.code}</span></span> },
    { key: 'category', header: 'Category', render: (t) => labelOf(CATEGORY_OPTIONS, t.category) },
    { key: 'paid', header: 'Pay', render: (t) => (t.isPaid ? 'Paid' : <Badge tone="neutral">Unpaid</Badge>) },
    {
      key: 'rules', header: 'Rules', className: 'text-xs text-slate-600',
      render: (t) => [
        t.allowHalfDay && 'Half days',
        t.minNoticeDays > 0 && `${t.minNoticeDays} d notice`,
        t.maxConsecutiveDays && `Max ${days(t.maxConsecutiveDays)} d`,
        t.allowBackdated && 'Backdating',
        t.requiresAttachment && 'Document',
        t.includeNonWorkingDays && 'Calendar days',
      ].filter(Boolean).join(' · ') || '—',
    },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge active={t.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (t: LeaveTypeConfig) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(t)}>Edit</Button>
          <Button size="sm" variant="ghost" icon={<Power className="size-3.5" />} onClick={() => setToggling(t)}>{t.isActive ? 'Deactivate' : 'Activate'}</Button>
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader title="Leave Types" description="The categories of leave your organization offers. A leave type is deactivated, never deleted, so past requests keep their meaning."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New leave type</Button>} />
      <Card>
        <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={<Tags />} emptyTitle="No leave types yet" emptyText="Add the kinds of leave your organization offers, then include them in a policy."
          emptyAction={canManage && <Button size="sm" onClick={() => setForm('new')}>New leave type</Button>}>
          {(d) => <DataTable caption="Leave types" columns={columns} rows={d} rowKey={(t) => t.id} minWidth="56rem" />}
        </QueryState>
      </Card>
      <CompOffRules />
      {form && (
        <FormDialog open title={form === 'new' ? 'New leave type' : `Edit ${form.name}`} fields={typeFields(form !== 'new')}
          initial={form === 'new' ? { category: 'other', isPaid: true, allowHalfDay: true, minNoticeDays: 0 } : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => {
            if (!b.allowBackdated) b.maxBackdatedDays = null;
            return form === 'new' ? leaveApi.createType(b) : leaveApi.updateType(form.id, b);
          }} />
      )}
      <ConfirmDialog open={!!toggling} onClose={() => setToggling(null)} onConfirm={() => toggling && toggle.mutate(toggling)} loading={toggle.isPending}
        title={toggling?.isActive ? `Deactivate ${toggling?.name}?` : `Activate ${toggling?.name}?`}
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Activate'} tone={toggling?.isActive ? 'destructive' : 'primary'}
        description={toggling?.isActive ? 'Employees can no longer apply for it. Existing requests and balances are kept.' : 'Employees covered by a policy that includes it can apply for it again.'} />
    </div>
  );
}

const compOffFields = (types: LeaveTypeConfig[], editing: boolean, today: string): FormField[] => [
  { name: 'leaveTypeId', label: 'Credited to', kind: 'select', required: true, disabled: editing, options: types.filter((t) => t.isActive).map((t) => ({ value: t.id, label: t.name })) },
  { name: 'eligibleWorkDayType', label: 'Worked on', kind: 'select', required: true, options: [
    { value: 'non_working', label: 'Weekly off or holiday' }, { value: 'weekly_off', label: 'Weekly off' },
    { value: 'holiday', label: 'Holiday' }, { value: 'any', label: 'Any day' },
  ] },
  { name: 'minimumWorkHours', label: 'Minimum hours worked', kind: 'number', required: true },
  { name: 'earnedDays', label: 'Days earned', kind: 'number', required: true },
  { name: 'maximumBalance', label: 'Maximum balance (days)', kind: 'number', hint: 'Blank means no limit' },
  { name: 'effectiveFrom', label: 'Effective from', kind: 'date', required: true, hint: `For example ${today}` },
  { name: 'effectiveTo', label: 'Effective to', kind: 'date' },
  { name: 'approvalRequired', label: 'Claims need approval before crediting', kind: 'checkbox', hint: 'Approved through the comp off workflow under Approval Workflows. Untick only if the claim itself is proof enough.' },
  { name: 'expiryEnabled', label: 'Credited days expire', kind: 'checkbox' },
  { name: 'expiryAfterDays', label: 'Days after the worked day', kind: 'number', step: '1', required: true, showIf: (v) => !!v.expiryEnabled },
];

function CompOffRules() {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const q = useQuery({ queryKey: leaveKey('config', 'comp-off'), queryFn: leaveApi.compOffRules });
  const types = useQuery({ queryKey: leaveKey('config', 'types'), queryFn: leaveApi.types });
  const [form, setForm] = useState<CompOffRuleConfig | 'new' | null>(null);
  const toggle = useLeaveAction((r: CompOffRuleConfig) => leaveApi.updateCompOffRule(r.id, { isActive: !r.isActive }), { success: 'Rule updated' });
  const compOffTypes = (types.data ?? []).filter((t) => t.category === 'comp_off');
  const today = tenantToday(prefs.timezone);

  const columns: Column<CompOffRuleConfig>[] = [
    { key: 'type', header: 'Credited to', bare: true, render: (r) => <span className="font-medium text-ink">{r.leaveTypeName}</span> },
    { key: 'earn', header: 'Earns', render: (r) => `${days(r.earnedDays)} d for ${days(r.minimumWorkHours)}+ hours` },
    { key: 'day', header: 'Worked on', render: (r) => labelOf([
      { value: 'non_working', label: 'Weekly off or holiday' }, { value: 'weekly_off', label: 'Weekly off' },
      { value: 'holiday', label: 'Holiday' }, { value: 'any', label: 'Any day' }], r.eligibleWorkDayType) },
    { key: 'expiry', header: 'Expiry', render: (r) => (r.expiryEnabled ? `${r.expiryAfterDays} days` : 'Never') },
    { key: 'from', header: 'Effective', className: 'whitespace-nowrap', render: (r) => `${formatDate(r.effectiveFrom, prefs)}${r.effectiveTo ? ` – ${formatDate(r.effectiveTo, prefs)}` : ''}` },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge active={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (r: CompOffRuleConfig) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => setForm(r)}>Edit</Button>
          <Button size="sm" variant="ghost" onClick={() => toggle.mutate(r)}>{r.isActive ? 'Deactivate' : 'Activate'}</Button>
        </div>
      ),
    }] : []),
  ];

  return (
    <Card className="mt-5">
      <CardHeader title="Compensatory off rules" description="How working on a non-working day earns leave"
        actions={canManage && <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setForm('new')} disabled={!compOffTypes.length}>New rule</Button>} />
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No comp off rules"
        emptyText={compOffTypes.length ? 'Add a rule so employees can claim comp off.' : 'First create a leave type with the Compensatory off category.'}>
        {(d) => <DataTable caption="Comp off rules" columns={columns} rows={d} rowKey={(r) => r.id} minWidth="56rem" />}
      </QueryState>
      {form && (
        <FormDialog open title={form === 'new' ? 'New comp off rule' : 'Edit comp off rule'} fields={compOffFields(compOffTypes, form !== 'new', today)}
          initial={form === 'new'
            ? { eligibleWorkDayType: 'non_working', minimumWorkHours: 8, earnedDays: 1, approvalRequired: true, effectiveFrom: today, leaveTypeId: compOffTypes[0]?.id }
            : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => {
            if (!b.expiryEnabled) b.expiryAfterDays = null;
            return form === 'new' ? leaveApi.createCompOffRule(b) : leaveApi.updateCompOffRule(form.id, b);
          }} />
      )}
    </Card>
  );
}

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Select } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { CalendarConfig, HolidayConfig } from '@/types/leave';
import { DAY_NAMES, formatDate } from '@/utils/format';
import { leaveKey, useLeaveAction, useLookups } from '../hooks';
import { FormDialog, type FormField } from '../components/FormDialog';
import { DataTable, QueryState, RuleStatusBadge, type Column } from '../components/shared';
import { HOLIDAY_TYPES, labelOf, tenantToday } from '../leave-format';

export default function HolidayCalendarsPage() {
  usePageTitle('Holiday Calendars');
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canManage = can('leave.configuration.manage');
  const lookups = useLookups();
  const thisYear = Number(tenantToday(prefs.timezone).slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const q = useQuery({ queryKey: leaveKey('config', 'calendars', year), queryFn: () => leaveApi.calendars(year) });
  const [form, setForm] = useState<CalendarConfig | 'new' | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const current = q.data?.find((c) => c.id === selected) ?? null;
  const setStatus = useLeaveAction(({ c, patch }: { c: CalendarConfig; patch: Record<string, unknown> }) => leaveApi.updateCalendar(c.id, patch), { success: 'Calendar updated' });

  const fields = (editing: boolean): FormField[] => [
    { name: 'code', label: 'Code', required: !editing, disabled: editing, placeholder: 'INDIA' },
    { name: 'name', label: 'Name', required: true, placeholder: 'India Holidays' },
    { name: 'calendarYear', label: 'Year', kind: 'number', step: '1', required: !editing, disabled: editing },
    {
      name: 'location', label: 'Work location', hint: 'Employees whose work location matches follow this calendar. Blank means no location.',
      placeholder: lookups.data?.locations[0] ?? 'Bengaluru',
    },
    { name: 'effectiveFrom', label: 'Effective from', kind: 'date', hint: 'Blank starts on 1 January' },
    { name: 'effectiveTo', label: 'Effective to', kind: 'date' },
    { name: 'description', label: 'Description', kind: 'textarea' },
  ];

  const columns: Column<CalendarConfig>[] = [
    {
      key: 'name', header: 'Calendar', bare: true,
      render: (c) => (
        <span>
          <span className="block font-medium text-ink">{c.name}{c.isDefault && <Badge tone="primary" className="ml-2">Default</Badge>}</span>
          <span className="block font-mono text-xs text-muted">{c.code}</span>
        </span>
      ),
    },
    { key: 'location', header: 'Location', render: (c) => c.location ?? <span className="text-muted">—</span> },
    { key: 'holidays', header: 'Holidays', className: 'tabular', render: (c) => c.holidayCount },
    { key: 'employees', header: 'Assigned now', className: 'tabular', render: (c) => c.employeeCount },
    { key: 'status', header: 'Status', render: (c) => <RuleStatusBadge status={c.status} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (c: CalendarConfig) => (
        <div className="flex flex-wrap gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(c)}>Edit</Button>
          {c.status === 'draft' && <Button size="sm" icon={<CheckCircle2 className="size-3.5" />} onClick={() => setStatus.mutate({ c, patch: { status: 'active' } })}>Activate</Button>}
          {c.status === 'active' && <Button size="sm" variant="ghost" icon={<Star className="size-3.5" />} onClick={() => setStatus.mutate({ c, patch: { isDefault: !c.isDefault } })}>{c.isDefault ? 'Remove default' : 'Make default'}</Button>}
          {c.status === 'active' && !c.isDefault && <Button size="sm" variant="ghost" onClick={() => setStatus.mutate({ c, patch: { status: 'archived' } })}>Archive</Button>}
        </div>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader title="Holiday Calendars" description="For each date, an employee follows the calendar assigned to them, then one for their work location, then the default for that year."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New calendar</Button>} />
      <Card>
        <div className="flex justify-end border-b border-line p-4">
          <Select className="w-28!" value={year} onChange={(e) => { setYear(Number(e.target.value)); setSelected(null); }} aria-label="Year">
            {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}
          </Select>
        </div>
        <QueryState query={q} isEmpty={(d) => d.length === 0} emptyIcon={<CalendarDays />} emptyTitle={`No calendars for ${year}`}
          emptyText="Without an active calendar, no dates count as holidays when leave is calculated.">
          {(d) => <DataTable caption="Holiday calendars" columns={columns} rows={d} rowKey={(c) => c.id} onRowClick={(c) => setSelected(c.id)} minWidth="56rem" />}
        </QueryState>
      </Card>
      {current ? <Holidays calendar={current} canManage={canManage} /> : q.data && q.data.length > 0 && <p className="mt-3 text-sm text-muted">Select a calendar to see and change its holidays.</p>}
      {form && (
        <FormDialog open title={form === 'new' ? 'New holiday calendar' : `Edit ${form.name}`} fields={fields(form !== 'new')}
          description={form === 'new' ? 'New calendars start as drafts. Add the holidays, then activate.' : undefined}
          initial={form === 'new' ? { calendarYear: year } : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => {
            if (form === 'new') {
              return leaveApi.createCalendar({ ...b, effectiveFrom: b.effectiveFrom ?? undefined });
            }
            const { calendarYear: _y, ...patch } = b;
            return leaveApi.updateCalendar(form.id, { ...patch, effectiveFrom: patch.effectiveFrom ?? undefined });
          }} />
      )}
    </div>
  );
}

function Holidays({ calendar, canManage }: { calendar: CalendarConfig; canManage: boolean }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const q = useQuery({ queryKey: leaveKey('config', 'holidays', calendar.id), queryFn: () => leaveApi.holidays(calendar.id) });
  const [form, setForm] = useState<HolidayConfig | 'new' | null>(null);
  const [removing, setRemoving] = useState<HolidayConfig | null>(null);
  const remove = useLeaveAction((h: HolidayConfig) => leaveApi.deleteHoliday(h.id), { success: 'Holiday removed', onDone: () => setRemoving(null) });

  const fields: FormField[] = [
    { name: 'name', label: 'Name', required: true, placeholder: 'Republic Day' },
    { name: 'holidayDate', label: 'Date', kind: 'date', required: true, hint: `Must be in ${calendar.calendarYear}` },
    { name: 'holidayType', label: 'Type', kind: 'select', required: true, options: HOLIDAY_TYPES },
    { name: 'description', label: 'Description' },
    { name: 'isOptional', label: 'Optional holiday', kind: 'checkbox', hint: 'Optional holidays are still charged when an employee takes leave on them.', showIf: (v) => v.holidayType !== 'optional' },
  ];
  const columns: Column<HolidayConfig>[] = [
    {
      key: 'date', header: 'Date', className: 'whitespace-nowrap',
      render: (h) => <>{formatDate(h.holidayDate, prefs)}<span className="block text-xs text-muted">{DAY_NAMES[new Date(`${h.holidayDate}T00:00:00Z`).getUTCDay()]}</span></>,
    },
    { key: 'name', header: 'Holiday', bare: true, render: (h) => <span className="font-medium text-ink">{h.name}</span> },
    { key: 'type', header: 'Type', render: (h) => labelOf(HOLIDAY_TYPES, h.holidayType) },
    { key: 'optional', header: 'Charged if on leave', render: (h) => (h.isOptional ? <Badge tone="violet">Yes, optional</Badge> : 'No') },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true,
      render: (h: HolidayConfig) => (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(h)}>Edit</Button>
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setRemoving(h)}>Remove</Button>
        </div>
      ),
    }] : []),
  ];
  return (
    <Card className="mt-5">
      <CardHeader title={`Holidays in ${calendar.name}`} description="Changes apply to new requests. Submitted requests keep the days they were charged."
        actions={canManage && <Button size="sm" variant="outline" icon={<Plus className="size-3.5" />} onClick={() => setForm('new')}>Add holiday</Button>} />
      <QueryState query={q} isEmpty={(d) => d.length === 0} emptyTitle="No holidays yet">
        {(d) => <DataTable caption="Holidays" columns={columns} rows={d} rowKey={(h) => h.id} />}
      </QueryState>
      {form && (
        <FormDialog open title={form === 'new' ? 'Add holiday' : `Edit ${form.name}`} fields={fields}
          initial={form === 'new' ? { holidayType: 'national' } : (form as unknown as Record<string, unknown>)}
          onClose={() => setForm(null)}
          onSubmit={(b) => (form === 'new' ? leaveApi.createHoliday({ ...b, calendarId: calendar.id }) : leaveApi.updateHoliday(form.id, b))} />
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={() => removing && remove.mutate(removing)} loading={remove.isPending}
        title={`Remove ${removing?.name}?`} confirmLabel="Remove" tone="destructive"
        description="New requests will charge this date. Submitted requests don’t change." />
    </Card>
  );
}

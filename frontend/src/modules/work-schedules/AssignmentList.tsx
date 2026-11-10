import { useEffect, useMemo, useState } from 'react';
import { CalendarX2, ChevronDown, Download, Filter, Pencil, Plus, Power, Search, X } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { useDebounced } from '@/hooks/useDebounced';
import { DataTable, Pager, QueryState, type Column } from '@/modules/leave/components/shared';
import { formatDate } from '@/utils/format';
import { assignmentApi } from './api';
import {
  AssignDialog, BulkEndDialog, CancelAssignmentDialog, EditAssignmentDialog, EndAssignmentDialog,
} from './AssignmentDialogs';
import { useAssignmentList, usePatternOptions } from './hooks';
import type { AssignTab } from './tabs';
import { EMPTY_FILTERS, PHASE_LABEL, type Assignment, type AssignmentFilters } from './types';

const PAGE = 25;

/**
 * One list for both kinds of assignment; the tab supplies the API path and
 * labels. Rows offer Edit, and End (started) or Cancel (not started). There
 * is no Delete anywhere: history is kept.
 */
export function AssignmentList({ tab, canManage }: { tab: AssignTab; canManage: boolean }) {
  const prefs = useMe().tenant.preferences;
  const client = useMemo(() => assignmentApi(tab.path), [tab.path]);
  const [filters, setFilters] = useState<AssignmentFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(1);
  const search = useDebounced(filters.search, 300);
  const effective = useMemo(() => ({ ...filters, search }), [filters, search]);
  const q = useAssignmentList(tab.path, client, effective, page, PAGE);
  const patterns = usePatternOptions(tab.key, showFilters);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Assignment | null>(null);
  const [ending, setEnding] = useState<Assignment | null>(null);
  const [cancelling, setCancelling] = useState<Assignment | null>(null);
  const [bulkEnding, setBulkEnding] = useState(false);

  useEffect(() => setPage(1), [search, filters.status, filters.patternId, filters.from, filters.to]);
  const set = <K extends keyof AssignmentFilters>(k: K, v: AssignmentFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const filtered = !!search || filters.status !== 'all' || !!filters.patternId || !!filters.from || !!filters.to;
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const items = q.data?.items ?? [];
  const selectable = items.filter((a) => a.status === 'active');
  const pageAll = selectable.length > 0 && selectable.every((a) => selected.has(a.id));

  const columns: Column<Assignment>[] = [
    ...(canManage ? [{
      key: 'select', header: 'Select', bare: true, className: 'w-px',
      render: (a: Assignment) => a.status === 'active'
        ? <Checkbox checked={selected.has(a.id)} onChange={() => toggle(a.id)} aria-label={`Select ${a.employee.name}`} />
        : null,
    }] : []),
    {
      key: 'employee', header: 'Employee', bare: true,
      render: (a) => (
        <div className="flex items-center gap-3">
          <Avatar name={a.employee.name} size="sm" />
          <div className="min-w-0"><p className="font-medium text-ink">{a.employee.name}</p><p className="text-xs text-muted">{a.employee.code}</p></div>
        </div>
      ),
    },
    {
      key: 'pattern', header: tab.patternLabel,
      render: (a) => <div><p>{a.pattern.name}</p><p className="text-xs text-muted">{a.sequenceSummary}</p></div>,
    },
    { key: 'rotate', header: 'Rotate', render: (a) => a.rotateLabel },
    {
      key: 'start', header: 'Start date',
      render: (a) => (
        <span className="whitespace-nowrap">{formatDate(a.startDate, prefs)}
          {a.endDate && <span className="block text-xs text-muted">to {formatDate(a.endDate, prefs)}</span>}</span>
      ),
    },
    { key: 'current', header: 'Current', render: (a) => a.current?.name ?? <span className="text-muted">{a.phase === 'upcoming' ? `Starts ${formatDate(a.startDate, prefs)}` : '—'}</span> },
    { key: 'switch', header: 'Next switch', render: (a) => a.nextSwitch ? formatDate(a.nextSwitch, prefs) : <span className="text-muted">—</span> },
    { key: 'next', header: 'Next', render: (a) => a.next?.name ?? <span className="text-muted">—</span> },
    {
      key: 'status', header: 'Status',
      render: (a) => <Badge tone={PHASE_LABEL[a.phase].tone}>{PHASE_LABEL[a.phase].label}</Badge>,
    },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true, className: 'w-px whitespace-nowrap',
      render: (a: Assignment) => (a.phase === 'upcoming' || a.phase === 'current') && a.status === 'active' ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} aria-label={`Edit ${a.employee.name}`} onClick={() => setEditing(a)}>Edit</Button>
          {a.phase === 'upcoming'
            ? <Button size="sm" variant="outline" icon={<X className="size-3.5" />} aria-label={`Cancel ${a.employee.name}'s assignment`} onClick={() => setCancelling(a)}>Cancel</Button>
            : <Button size="sm" variant="outline" icon={<Power className="size-3.5" />} aria-label={`End ${a.employee.name}'s rotation`} onClick={() => setEnding(a)}>End</Button>}
        </div>
      ) : null,
    }] : []),
  ];

  const exportCsv = () => {
    const a = document.createElement('a');
    a.href = client.exportUrl(effective);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  return (
    <>
      <div className="space-y-3 border-b border-line p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <Field label="Search by employee name or code" hideLabel className="flex-1">
            {({ id }) => (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <Input id={id} type="search" placeholder="Search by name or code" className="pl-9" value={filters.search} onChange={(e) => set('search', e.target.value)} />
              </div>
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" icon={<Filter className="size-4" />} aria-expanded={showFilters} onClick={() => setShowFilters((v) => !v)}>
              Filter{filtered ? ' •' : ''}
            </Button>
            <Menu label="Actions" items={[
              { key: 'export', label: 'Export to CSV', icon: <Download className="size-4" />, onSelect: exportCsv },
              ...(canManage ? [{
                key: 'bulk-end', label: selected.size ? `End ${selected.size} selected` : 'End selected (choose rows first)',
                icon: <CalendarX2 className="size-4" />, disabled: selected.size === 0, onSelect: () => setBulkEnding(true),
              }] : []),
            ]} trigger={(p) => (
              <Button variant="outline" {...p} icon={<ChevronDown className="size-4" />}>Actions</Button>
            )} />
            {canManage && <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Assign</Button>}
          </div>
        </div>

        {showFilters && (
          <div className="grid gap-3 rounded-lg border border-line bg-slate-50/60 p-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Status">
              {({ id }) => (
                <Select id={id} value={filters.status} onChange={(e) => set('status', e.target.value as AssignmentFilters['status'])}>
                  <option value="all">All</option><option value="active">Active</option><option value="ended">Ended</option><option value="cancelled">Cancelled</option>
                </Select>
              )}
            </Field>
            <Field label={tab.patternLabel}>
              {({ id }) => (
                <Select id={id} value={filters.patternId} onChange={(e) => set('patternId', e.target.value)}>
                  <option value="">All</option>
                  {patterns.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Active from">{({ id }) => <Input id={id} type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} />}</Field>
            <Field label="Active until">{({ id }) => <Input id={id} type="date" value={filters.to} onChange={(e) => set('to', e.target.value)} />}</Field>
            <div className="sm:col-span-2 lg:col-span-4">
              <Button size="sm" variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!filtered}>Clear filters</Button>
            </div>
          </div>
        )}

        {canManage && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-3 text-sm" role="status">
            <span className="tabular">{selected.size} selected</span>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
          </div>
        )}
      </div>

      <QueryState
        query={q}
        isEmpty={(d) => d.items.length === 0}
        emptyTitle={filtered ? 'No assignments match' : 'No assignments yet'}
        emptyText={filtered ? 'Try another search or filter.' : canManage ? `Assign a ${tab.patternLabel.toLowerCase()} to employees to get started.` : undefined}
        emptyAction={!filtered && canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Assign</Button> : undefined}
      >
        {(d) => (
          <>
            {canManage && selectable.length > 0 && (
              <label className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs text-muted md:hidden">
                <Checkbox checked={pageAll} onChange={() => setSelected((s) => { const n = new Set(s); for (const a of selectable) { if (pageAll) n.delete(a.id); else n.add(a.id); } return n; })} aria-label="Select all on this page" />
                Select all on this page
              </label>
            )}
            <DataTable caption={`${tab.label}`} columns={columns} rows={d.items} rowKey={(a) => a.id} minWidth="64rem" />
            <Pager total={d.total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(o) => setPage(Math.floor(o / PAGE) + 1)} />
          </>
        )}
      </QueryState>

      {creating && <AssignDialog tab={tab} client={client} onClose={() => setCreating(false)} />}
      {editing && <EditAssignmentDialog tab={tab} client={client} assignment={editing} onClose={() => setEditing(null)} />}
      {ending && <EndAssignmentDialog client={client} assignment={ending} onClose={() => setEnding(null)} />}
      {cancelling && <CancelAssignmentDialog client={client} assignment={cancelling} onClose={() => setCancelling(null)} />}
      {bulkEnding && <BulkEndDialog client={client} ids={[...selected]} onClose={() => setBulkEnding(false)} onDone={() => setSelected(new Set())} />}
    </>
  );
}

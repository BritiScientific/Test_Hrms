import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Filter, Search, X } from 'lucide-react';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { pickerApi } from './api';
import { usePickerList, usePickerOptions } from './hooks';
import { EMPTY_PICKER, type PickerEmployee, type PickerFilters } from './types';

const PAGE = 10;

/** Selected employees, by id. The name is null for ones chosen through "select all matching". */
export type Selection = Map<number, string | null>;

/**
 * Two-pane picker: filters and results on the left, the selection on the
 * right. The selection survives paging and filter changes. "Already assigned"
 * is a hint only; the server enforces the one-rotation-at-a-time rule.
 */
export function EmployeePickerDialog({ open, kind, initial, onClose, onConfirm }: {
  open: boolean;
  kind: 'rotating-shift' | 'rotating-work-type';
  initial: Selection;
  onClose: () => void;
  onConfirm: (selection: Selection) => void;
}) {
  const [filters, setFilters] = useState<PickerFilters>(EMPTY_PICKER);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection>(new Map(initial));
  const [showFilters, setShowFilters] = useState(false);
  const [selectAllBusy, setSelectAllBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const search = useDebounced(filters.search, 300);
  const effective = { ...filters, search };
  const options = usePickerOptions(open);
  const q = usePickerList(kind, effective, page, PAGE, open);

  useEffect(() => { if (open) { setSelection(new Map(initial)); setFilters(EMPTY_PICKER); setPage(1); setNote(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setPage(1), [search, filters.departmentId, filters.jobTitle, filters.employeeTypeId, filters.roleId, filters.managerId, filters.joinedFrom, filters.joinedTo, filters.assignment]);

  const set = <K extends keyof PickerFilters>(k: K, v: PickerFilters[K]) => setFilters((f) => ({ ...f, [k]: v }));
  const toggle = (e: PickerEmployee) => setSelection((s) => {
    const next = new Map(s);
    if (next.has(e.id)) next.delete(e.id); else next.set(e.id, e.name);
    return next;
  });
  const items = q.data?.items ?? [];
  const pageAllSelected = items.length > 0 && items.every((e) => selection.has(e.id));
  const togglePage = () => setSelection((s) => {
    const next = new Map(s);
    for (const e of items) { if (pageAllSelected) next.delete(e.id); else next.set(e.id, e.name); }
    return next;
  });

  const selectAllMatching = async () => {
    setSelectAllBusy(true);
    setNote(null);
    try {
      const r = await pickerApi.allIds(kind, effective);
      setSelection((s) => {
        const next = new Map(s);
        for (const id of r.ids) if (!next.has(id)) next.set(id, null);
        return next;
      });
      if (r.truncated) setNote(`Only the first ${r.ids.length} of ${r.total} matching employees were selected.`);
    } finally {
      setSelectAllBusy(false);
    }
  };

  const opts = options.data;
  const select = (label: string, value: string, onChange: (v: string) => void, children: React.ReactNode) => (
    <Field label={label} hideLabel>
      {({ id: fid }) => (
        <Select id={fid} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">{label}</option>{children}
        </Select>
      )}
    </Field>
  );
  const names = [...selection.entries()];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Select employees"
      description="Choose who to assign. Your selection is kept while you search and change pages."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onConfirm(selection)} disabled={selection.size === 0}>
            Select {selection.size > 0 ? `${selection.size} employee${selection.size === 1 ? '' : 's'}` : ''}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0 space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input aria-label="Search by name or employee code" type="search" placeholder="Search name or code" className="pl-9"
                value={filters.search} onChange={(e) => set('search', e.target.value)} data-autofocus />
            </div>
            <Button variant="outline" className="sm:hidden" icon={<Filter className="size-4" />} aria-expanded={showFilters}
              onClick={() => setShowFilters((v) => !v)}>Filters</Button>
          </div>

          <div className={`grid gap-2 sm:grid-cols-2 ${showFilters ? '' : 'hidden sm:grid'}`}>
            {select('Department', filters.departmentId, (v) => set('departmentId', v),
              opts?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>))}
            {select('Job position', filters.jobTitle, (v) => set('jobTitle', v),
              opts?.jobTitles.map((t) => <option key={t} value={t}>{t}</option>))}
            {select('Employee type', filters.employeeTypeId, (v) => set('employeeTypeId', v),
              opts?.employeeTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>))}
            {select('Job role', filters.roleId, (v) => set('roleId', v),
              opts?.roles.map((t) => <option key={t.id} value={t.id}>{t.name}</option>))}
            {select('Reporting manager', filters.managerId, (v) => set('managerId', v),
              opts?.managers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>))}
            {select('Assignment status', filters.assignment, (v) => set('assignment', v as PickerFilters['assignment']),
              <><option value="unassigned">Not assigned</option><option value="assigned">Assigned</option></>)}
            <Field label="Joined from" hideLabel>
              {({ id }) => <Input id={id} type="date" aria-label="Joined from" value={filters.joinedFrom} onChange={(e) => set('joinedFrom', e.target.value)} />}
            </Field>
            <Field label="Joined to" hideLabel>
              {({ id }) => <Input id={id} type="date" aria-label="Joined to" value={filters.joinedTo} onChange={(e) => set('joinedTo', e.target.value)} />}
            </Field>
          </div>

          {q.isPending && <LoadingBlock rows={5} />}
          {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
          {q.data && items.length === 0 && <EmptyState title="No employees match" description="Try clearing a filter." />}
          {items.length > 0 && (
            <div className="rounded-lg border border-line">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-slate-50/70 px-3 py-2 text-xs">
                <label className="flex items-center gap-2">
                  <Checkbox checked={pageAllSelected} onChange={togglePage} aria-label="Select all employees on this page" />
                  <span className="text-muted">This page</span>
                </label>
                <Button size="sm" variant="ghost" loading={selectAllBusy} onClick={selectAllMatching}>
                  Select all {q.data!.total} matching
                </Button>
              </div>
              <ul className="divide-y divide-line" aria-label="Employees">
                {items.map((e) => (
                  <li key={e.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
                      <Checkbox checked={selection.has(e.id)} onChange={() => toggle(e)} aria-label={`Select ${e.name}`} />
                      <Avatar name={e.name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">{e.name}</span>
                        <span className="block truncate text-xs text-muted">{e.code}{e.jobTitle && ` · ${e.jobTitle}`}{e.department && ` · ${e.department}`}</span>
                      </span>
                      {e.assigned && <Badge tone="warning">Already assigned</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-xs text-muted">
                <span className="tabular">{(page - 1) * PAGE + 1}–{Math.min(page * PAGE, q.data!.total)} of {q.data!.total}</span>
                <div className="flex gap-1">
                  <Button size="icon" variant="ghost" aria-label="Previous page" disabled={page === 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="size-4" aria-hidden /></Button>
                  <Button size="icon" variant="ghost" aria-label="Next page" disabled={page * PAGE >= q.data!.total} onClick={() => setPage((p) => p + 1)}><ChevronRight className="size-4" aria-hidden /></Button>
                </div>
              </div>
            </div>
          )}
          {note && <p role="status" className="text-xs text-amber-800">{note}</p>}
        </div>

        <aside className="min-w-0 rounded-lg border border-line bg-slate-50/50 p-3" aria-label="Selected employees">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium text-ink">Selected <span className="tabular text-muted">({selection.size})</span></h3>
            {selection.size > 0 && <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())}>Clear</Button>}
          </div>
          {selection.size === 0 ? <p className="text-xs text-muted">Nobody selected yet.</p> : (
            <ul className="max-h-72 space-y-1 overflow-y-auto">
              {names.slice(0, 50).map(([id, name]) => (
                <li key={id} className="flex items-center justify-between gap-1 rounded bg-surface px-2 py-1 text-xs">
                  <span className="truncate">{name ?? `Employee #${id}`}</span>
                  <button type="button" aria-label={`Remove ${name ?? `employee ${id}`}`} className="text-slate-500 hover:text-ink"
                    onClick={() => setSelection((s) => { const n = new Map(s); n.delete(id); return n; })}><X className="size-3.5" aria-hidden /></button>
                </li>
              ))}
              {names.length > 50 && <li className="px-2 text-xs text-muted">…and {names.length - 50} more</li>}
            </ul>
          )}
        </aside>
      </div>
    </Dialog>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Pencil, Plus, Power, PowerOff, Search } from 'lucide-react';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { DataTable, Pager, QueryState, type Column } from '@/modules/leave/components/shared';
import type { ResourceApi } from '../api';
import { useConfigList } from '../hooks';
import type { BaseRecord, StatusFilter } from '../types';
import { StatusToggleDialog } from './StatusToggleDialog';

export const PAGE_SIZE = 25;

/**
 * The list every tab shares: debounced search, All/Active/Inactive filter,
 * table (cards on phones), pagination, and loading/empty/error states.
 * Rows offer Edit and Activate/Deactivate. There is no Delete anywhere.
 */
export function ConfigListView<T extends BaseRecord>({
  resource, client, label, columns, canManage, renderForm, emptyIcon, minWidth = '52rem',
}: {
  /** Query-key segment, e.g. "shifts". */
  resource: string;
  client: ResourceApi<T>;
  /** Singular, e.g. "Shift". */
  label: string;
  /** Tab-specific columns; Name comes first, Status and Actions are appended here. */
  columns: Column<T>[];
  canManage: boolean;
  /** The create/edit form for a record (null = new). */
  renderForm: (record: T | null, close: () => void) => ReactNode;
  emptyIcon: ReactNode;
  minWidth?: string;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim(), 300);
  const query = useMemo(
    () => ({ search: debounced || undefined, status, page, limit: PAGE_SIZE, sort: 'name' }),
    [debounced, status, page],
  );
  useEffect(() => setPage(1), [debounced, status]);
  const q = useConfigList(resource, client, query);

  const [form, setForm] = useState<T | 'new' | null>(null);
  const [toggling, setToggling] = useState<T | null>(null);
  const lower = label.toLowerCase();
  const filtered = !!debounced || status !== 'all';

  const allColumns: Column<T>[] = [
    ...columns,
    { key: 'status', header: 'Status', render: (r) => <StatusBadge active={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions',
      header: 'Actions',
      bare: true,
      className: 'w-px whitespace-nowrap',
      render: (r: T) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(r)}
            aria-label={`Edit ${r.name}`}>
            Edit
          </Button>
          <Button size="sm" variant="outline"
            icon={r.isActive ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
            onClick={() => setToggling(r)}
            aria-label={`${r.isActive ? 'Deactivate' : 'Activate'} ${r.name}`}>
            {r.isActive ? 'Deactivate' : 'Activate'}
          </Button>
        </div>
      ),
    }] : []),
  ];

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-end">
        <Field label={`Search ${lower}s`} hideLabel className="flex-1">
          {({ id }) => (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input id={id} type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or description" className="pl-9" />
            </div>
          )}
        </Field>
        <Field label="Status" hideLabel className="sm:w-40">
          {({ id }) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          )}
        </Field>
        {canManage && (
          <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New {lower}</Button>
        )}
      </div>

      <div>
        <QueryState
          query={q}
          isEmpty={(d) => d.items.length === 0}
          emptyIcon={emptyIcon}
          emptyTitle={filtered ? `No ${lower}s match` : `No ${lower}s yet`}
          emptyText={filtered ? 'Try another search or status.' : canManage ? `Create the first ${lower} to get started.` : undefined}
          emptyAction={!filtered && canManage
            ? <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New {lower}</Button>
            : undefined}
        >
          {(d) => (
            <>
              <DataTable caption={`${label}s`} columns={allColumns} rows={d.items} rowKey={(r) => r.id} minWidth={minWidth} />
              <Pager total={d.total} limit={PAGE_SIZE} offset={(page - 1) * PAGE_SIZE}
                onChange={(offset) => setPage(Math.floor(offset / PAGE_SIZE) + 1)} />
            </>
          )}
        </QueryState>
      </div>

      {form && renderForm(form === 'new' ? null : form, () => setForm(null))}
      <StatusToggleDialog record={toggling} label={label} client={client} onClose={() => setToggling(null)} />
    </>
  );
}

/** Name column with the description underneath. */
export function nameColumn<T extends BaseRecord>(header = 'Name'): Column<T> {
  return {
    key: 'name',
    header,
    bare: true,
    render: (r) => (
      <div className="min-w-0">
        <p className="font-medium text-ink">{r.name}</p>
        {r.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.description}</p>}
      </div>
    ),
  };
}

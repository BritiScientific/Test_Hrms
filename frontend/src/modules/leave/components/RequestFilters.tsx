import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Input, Select } from '@/components/ui/Field';
import { STATUS_LABEL } from '../leave-format';

export interface RequestFilterValues {
  search: string;
  status: string;
  leaveTypeId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: RequestFilterValues = { search: '', status: '', leaveTypeId: '', from: '', to: '' };

export function RequestFilters({ value, onChange, leaveTypes, searchLabel = 'Search requests', searchPlaceholder = 'Search', children }: {
  value: RequestFilterValues;
  onChange: (v: RequestFilterValues) => void;
  leaveTypes?: { id: number; name: string }[];
  searchLabel?: string;
  searchPlaceholder?: string;
  children?: ReactNode;
}) {
  const set = (patch: Partial<RequestFilterValues>) => onChange({ ...value, ...patch });
  return (
    <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      <div className="relative min-w-0 sm:col-span-2 lg:col-span-3 xl:col-span-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input type="search" value={value.search} onChange={(e) => set({ search: e.target.value })} className="pl-9"
          placeholder={searchPlaceholder} aria-label={searchLabel} />
      </div>
      <Select value={value.status} onChange={(e) => set({ status: e.target.value })} aria-label="Filter by status">
        <option value="">All statuses</option>
        {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </Select>
      <Select value={value.leaveTypeId} onChange={(e) => set({ leaveTypeId: e.target.value })} aria-label="Filter by leave type">
        <option value="">All leave types</option>
        {leaveTypes?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
      <Input type="date" value={value.from} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
      <Input type="date" value={value.to} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
      {children}
    </div>
  );
}

export const filterQuery = (f: RequestFilterValues) => ({
  search: f.search || undefined,
  status: f.status || undefined,
  leaveTypeId: f.leaveTypeId ? Number(f.leaveTypeId) : undefined,
  from: f.from || undefined,
  to: f.to || undefined,
});

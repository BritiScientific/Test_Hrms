import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Combobox } from '@/components/ui/Combobox';
import { Field, Input, Select } from '@/components/ui/Field';
import type { OrganizationChart, OrgChartStatus } from '@/types/api';

export const STATUS_OPTIONS: { value: OrgChartStatus; label: string }[] = [
  { value: 'current', label: 'Current staff' },
  { value: 'active', label: 'Active only' },
  { value: 'on_notice', label: 'On notice' },
  { value: 'exited', label: 'Exited' },
  { value: 'all', label: 'Everyone' },
];

export function OrganizationChartFilters({
  search, onSearch, matchCount, activeIndex, onStep,
  departmentId, onDepartment, managerId, onManager, status, onStatus, options, onClear,
}: {
  search: string;
  onSearch: (v: string) => void;
  matchCount: number | null;
  activeIndex: number;
  onStep: (delta: number) => void;
  departmentId: string;
  onDepartment: (v: string) => void;
  managerId: string;
  onManager: (v: string) => void;
  status: OrgChartStatus;
  onStatus: (v: OrgChartStatus) => void;
  options: OrganizationChart['filterOptions'] | undefined;
  onClear: () => void;
}) {
  const managerOptions = [
    { value: '', label: 'All managers' },
    ...(options?.managers ?? []).map((m) => ({ value: String(m.id), label: m.name, hint: m.jobTitle ?? undefined })),
  ];
  const filtered = search || departmentId || managerId || status !== 'current';

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
      <div className="min-w-0 flex-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matchCount) {
                e.preventDefault();
                onStep(e.shiftKey ? -1 : 1);
              }
            }}
            className="pl-9"
            placeholder="Search name, employee number or job title"
            aria-label="Search employees"
          />
        </div>
        {matchCount !== null && (
          <div className="mt-1.5 flex items-center gap-1 text-xs text-muted">
            <span role="status" className="tabular">
              {matchCount === 0 ? 'No matches' : `${activeIndex + 1} of ${matchCount} ${matchCount === 1 ? 'match' : 'matches'}`}
            </span>
            {matchCount > 1 && (
              <>
                <Button variant="ghost" size="sm" className="h-6 w-6 px-0" aria-label="Previous match" onClick={() => onStep(-1)}>
                  <ChevronUp className="size-3.5" aria-hidden />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 w-6 px-0" aria-label="Next match" onClick={() => onStep(1)}>
                  <ChevronDown className="size-3.5" aria-hidden />
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 xs:grid-cols-3 lg:w-[36rem]">
        <Select value={departmentId} onChange={(e) => onDepartment(e.target.value)} aria-label="Filter by department">
          <option value="">All departments</option>
          {options?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Field label="Filter by reporting manager" hideLabel>
          {({ id }) => (
            <Combobox id={id} value={managerId} onChange={onManager} options={managerOptions} placeholder="Search managers…" />
          )}
        </Field>
        <Select value={status} onChange={(e) => onStatus(e.target.value as OrgChartStatus)} aria-label="Filter by employment status">
          {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>

      {filtered && (
        <Button variant="ghost" onClick={onClear} icon={<X className="size-4" aria-hidden />}>Clear</Button>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import { MONTH_NAMES, formatDate } from '@/utils/format';
import { leaveKey, useLookups } from '../hooks';
import { CalendarGrid, buildDays, monthGrid, weekDays } from '../components/MonthCalendar';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { QueryState } from '../components/shared';
import { tenantToday } from '../leave-format';

const shift = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export default function AdminCalendarPage() {
  usePageTitle('Leave Calendar');
  const me = useMe();
  const prefs = me.tenant.preferences;
  const today = tenantToday(prefs.timezone);
  const lookups = useLookups();
  const [view, setView] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(today);
  const [departmentId, setDepartmentId] = useState('');
  const [location, setLocation] = useState('');
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const [openId, setOpenId] = useState<number | null>(null);

  const year = Number(anchor.slice(0, 4));
  const month = Number(anchor.slice(5, 7));
  const dates = useMemo(() => (view === 'month' ? monthGrid(year, month, 1) : weekDays(anchor, 1)), [view, year, month, anchor]);
  const q = useQuery({
    queryKey: leaveKey('admin-calendar', dates[0], dates[dates.length - 1], departmentId, location, debounced),
    queryFn: () => leaveApi.adminCalendar({
      from: dates[0], to: dates[dates.length - 1], departmentId: departmentId || undefined, location: location || undefined, search: debounced || undefined,
    }),
    placeholderData: keepPreviousData,
  });
  const gridDays = useMemo(() => buildDays(dates, {
    month: view === 'month' ? month : undefined, today, weeklyOffs: q.data?.weeklyOffs ?? [], holidays: q.data?.holidays ?? [], leaves: q.data?.leaves ?? [],
  }), [dates, view, month, today, q.data]);

  const move = (dir: number) => {
    if (view === 'week') return setAnchor(shift(anchor, dir * 7));
    const d = new Date(Date.UTC(year, month - 1 + dir, 1));
    setAnchor(d.toISOString().slice(0, 10));
  };
  const title = view === 'month' ? `${MONTH_NAMES[month - 1]} ${year}` : `${formatDate(dates[0], prefs)} – ${formatDate(dates[6], prefs)}`;

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="Leave Calendar" description="Approved leave and holidays across the organization" />
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search employee" aria-label="Filter by employee" />
          <Select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Filter by department">
            <option value="">All departments</option>
            {lookups.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
          <Select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Filter by location">
            <option value="">All locations</option>
            {lookups.data?.locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </Select>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" aria-label={`Previous ${view}`} onClick={() => move(-1)}><ChevronLeft className="size-4" aria-hidden /></Button>
            <h2 className="min-w-40 text-center text-base font-semibold" aria-live="polite">{title}</h2>
            <Button variant="ghost" size="icon" aria-label={`Next ${view}`} onClick={() => move(1)}><ChevronRight className="size-4" aria-hidden /></Button>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setAnchor(today)}>Today</Button>
            <div role="group" aria-label="Calendar view" className="inline-flex overflow-hidden rounded-lg border border-line">
              {(['month', 'week'] as const).map((v) => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => setView(v)}
                  className={`px-3 py-1.5 text-sm capitalize ${view === v ? 'bg-primary-soft font-medium text-primary-dark' : 'text-slate-600 hover:bg-slate-50'}`}>{v}</button>
              ))}
            </div>
          </div>
        </div>
        <QueryState query={q} loadingRows={10}>
          {() => (
            <CalendarGrid days={gridDays} tall={view === 'week'} onSelectLeave={setOpenId}
              leaveLabel={(l) => `${l.employeeName} · ${l.departmentName ?? l.leaveTypeName}`} />
          )}
        </QueryState>
      </Card>
    </div>
  );
}

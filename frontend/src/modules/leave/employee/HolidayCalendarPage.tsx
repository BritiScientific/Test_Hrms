import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, PartyPopper } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { EmptyState, PageHeader } from '@/components/feedback/States';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import { MONTH_NAMES, formatDate } from '@/utils/format';
import { leaveKey } from '../hooks';
import { CalendarGrid, buildDays, monthGrid } from '../components/MonthCalendar';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { QueryState } from '../components/shared';
import { HOLIDAY_TYPES, labelOf, tenantToday } from '../leave-format';

const TYPE_TONE: Record<string, BadgeTone> = { national: 'primary', state: 'primary', festival: 'warning', optional: 'violet', organization: 'neutral' };

export default function HolidayCalendarPage() {
  usePageTitle('Holiday Calendar');
  const me = useMe();
  const prefs = me.tenant.preferences;
  const today = tenantToday(prefs.timezone);
  const [year, setYear] = useState(Number(today.slice(0, 4)));
  const [month, setMonth] = useState(Number(today.slice(5, 7)));
  const [openId, setOpenId] = useState<number | null>(null);

  // A whole year at once: month and year navigation stay instant, and the list below needs it anyway.
  const q = useQuery({ queryKey: leaveKey('my-calendar', year), queryFn: () => leaveApi.myCalendar(`${year}-01-01`, `${year}-12-31`) });
  const grid = useMemo(() => monthGrid(year, month, 1), [year, month]);
  const gridDays = useMemo(() => buildDays(grid, {
    month, today, weeklyOffs: q.data?.weeklyOffs ?? [], holidays: q.data?.holidays ?? [], leaves: q.data?.leaves ?? [],
  }), [grid, month, today, q.data]);

  const move = (delta: number) => {
    const n = month + delta;
    if (n < 1) { setMonth(12); setYear((y) => y - 1); } else if (n > 12) { setMonth(1); setYear((y) => y + 1); } else setMonth(n);
  };
  const thisYear = Number(today.slice(0, 4));

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="Holiday Calendar" description={q.data?.calendarName ? `Your calendar: ${q.data.calendarName}` : 'The holidays that apply to you'} />
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => move(-1)}><ChevronLeft className="size-4" aria-hidden /></Button>
              <h2 className="min-w-36 text-center text-base font-semibold" aria-live="polite">{MONTH_NAMES[month - 1]} {year}</h2>
              <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => move(1)}><ChevronRight className="size-4" aria-hidden /></Button>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => { setYear(thisYear); setMonth(Number(today.slice(5, 7))); }}>Today</Button>
              <Select className="w-28!" value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
                {[thisYear - 1, thisYear, thisYear + 1, thisYear + 2].map((y) => <option key={y} value={y}>{y}</option>)}
              </Select>
            </div>
          </div>
          <QueryState query={q} loadingRows={10}>
            {() => <CalendarGrid days={gridDays} onSelectLeave={setOpenId} leaveLabel={(l) => l.leaveTypeName} />}
          </QueryState>
        </Card>

        <Card className="min-w-0">
          <CardHeader title={`Holidays in ${year}`} description={q.data ? `${q.data.holidays.length} in your calendar` : undefined} />
          {q.data && q.data.holidays.length === 0 && (
            <EmptyState icon={<PartyPopper />} title="No holidays for this year" description="HR hasn’t published a holiday calendar that applies to you yet." />
          )}
          {q.data && q.data.holidays.length > 0 && (
            <CardBody className="max-h-[36rem] overflow-y-auto">
              <ul className="space-y-3">
                {q.data.holidays.map((h) => (
                  <li key={h.day + h.name} className="flex items-start gap-3 text-sm">
                    <CalendarDays className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink">{h.name}</span>
                      <span className="text-xs text-muted">{formatDate(h.day, prefs)}</span>
                    </span>
                    <Badge tone={TYPE_TONE[h.holidayType] ?? 'neutral'}>{labelOf(HOLIDAY_TYPES, h.holidayType)}</Badge>
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>
      </div>
    </div>
  );
}

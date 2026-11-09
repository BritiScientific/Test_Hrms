import { cn } from '@/utils/cn';
import type { LeaveRequestRow, HolidayEntry } from '@/types/leave';
import { DAY_NAMES } from '@/utils/format';

export interface CalendarDayInfo {
  date: string;
  dayOfMonth: number;
  inMonth: boolean;
  isWeeklyOff: boolean;
  isToday: boolean;
  holidays: HolidayEntry[];
  leaves: LeaveRequestRow[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The Monday-or-whatever-first week containing a date, as seven ISO dates. */
export function weekDays(anchor: string, weekStart: number): string[] {
  const d = new Date(`${anchor}T00:00:00Z`);
  const back = (d.getUTCDay() - weekStart + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setUTCDate(d.getUTCDate() + i);
    return iso(x);
  });
}

/** Whole weeks covering a month. Pure, so it can be unit tested. */
export function monthGrid(year: number, month: number, weekStart: number): string[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const start = new Date(first);
  start.setUTCDate(1 - ((first.getUTCDay() - weekStart + 7) % 7));
  const last = new Date(Date.UTC(year, month, 0));
  const cells: string[] = [];
  for (const d = new Date(start); d <= last || cells.length % 7 !== 0; d.setUTCDate(d.getUTCDate() + 1)) cells.push(iso(d));
  return cells;
}

export function buildDays(
  dates: string[],
  opts: { month?: number; today: string; weeklyOffs: number[]; holidays: HolidayEntry[]; leaves: LeaveRequestRow[] },
): CalendarDayInfo[] {
  return dates.map((date) => {
    const d = new Date(`${date}T00:00:00Z`);
    return {
      date,
      dayOfMonth: d.getUTCDate(),
      inMonth: opts.month === undefined || d.getUTCMonth() + 1 === opts.month,
      isWeeklyOff: opts.weeklyOffs.includes(d.getUTCDay()),
      isToday: date === opts.today,
      holidays: opts.holidays.filter((h) => h.day === date),
      leaves: opts.leaves.filter((l) => l.startDate <= date && l.endDate >= date),
    };
  });
}

/**
 * Month or week grid. Every marker carries text as well as colour. On a phone each
 * day becomes a row, so names stay readable instead of being squeezed into a cell.
 */
export function CalendarGrid({ days, weekStart = 1, tall, onSelectLeave, leaveLabel }: {
  days: CalendarDayInfo[];
  weekStart?: number;
  tall?: boolean;
  onSelectLeave?: (id: number) => void;
  leaveLabel: (l: LeaveRequestRow) => string;
}) {
  const headers = Array.from({ length: 7 }, (_, i) => DAY_NAMES[(weekStart + i) % 7]);
  const markers = (d: CalendarDayInfo) => (
    <div className="space-y-1">
      {d.holidays.map((h) => (
        <p key={h.name + h.calendarName} className={cn('truncate rounded px-1.5 py-0.5 text-xs',
          h.isOptional ? 'bg-violet-50 text-violet-700' : 'bg-amber-50 text-amber-800')} title={h.name}>
          {h.name}{h.isOptional && ' (optional)'}
        </p>
      ))}
      {d.leaves.map((l) => {
        const cls = cn('block w-full truncate rounded px-1.5 py-0.5 text-left text-xs',
          l.status === 'approved' ? 'bg-primary-soft text-primary-dark' : 'border border-dashed border-slate-300 bg-surface text-slate-600');
        return onSelectLeave
          ? <button key={l.id} type="button" className={cn(cls, 'hover:underline')} title={leaveLabel(l)} onClick={() => onSelectLeave(l.id)}>{leaveLabel(l)}</button>
          : <span key={l.id} className={cls} title={leaveLabel(l)}>{leaveLabel(l)}</span>;
      })}
    </div>
  );
  return (
    <>
      <div className="hidden md:block">
        <div className="grid grid-cols-7 border-b border-line bg-slate-50/70 text-xs font-medium tracking-wide text-muted uppercase">
          {headers.map((h) => <div key={h} className="px-2 py-2">{h.slice(0, 3)}</div>)}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => (
            <div key={d.date} className={cn('min-w-0 border-b border-r border-line p-1.5', tall ? 'min-h-40' : 'min-h-24',
              !d.inMonth && 'bg-slate-50/50 text-slate-400', d.isWeeklyOff && d.inMonth && 'bg-slate-50')}>
              <p className={cn('mb-1 text-xs tabular', d.isToday && 'inline-flex size-5 items-center justify-center rounded-full bg-primary font-semibold text-white')}>
                {d.dayOfMonth}
              </p>
              {d.inMonth && markers(d)}
            </div>
          ))}
        </div>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {days.filter((d) => d.inMonth && (d.holidays.length || d.leaves.length || d.isToday)).map((d) => (
          <li key={d.date} className="flex gap-3 px-4 py-3">
            <div className={cn('w-12 shrink-0 text-center', d.isToday && 'font-semibold text-primary')}>
              <p className="text-lg leading-tight tabular">{d.dayOfMonth}</p>
              <p className="text-xs text-muted">{DAY_NAMES[new Date(`${d.date}T00:00:00Z`).getUTCDay()].slice(0, 3)}</p>
            </div>
            <div className="min-w-0 flex-1">
              {d.holidays.length || d.leaves.length ? markers(d) : <p className="text-xs text-muted">Today</p>}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-muted">
        <Legend className="bg-amber-50 ring-amber-200" label="Holiday" />
        <Legend className="bg-violet-50 ring-violet-200" label="Optional holiday" />
        <Legend className="bg-primary-soft ring-blue-200" label="Approved leave" />
        <Legend className="bg-slate-100 ring-slate-200" label="Weekly off" />
      </div>
    </>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return <span className="inline-flex items-center gap-1.5"><span className={cn('size-3 rounded-sm ring-1 ring-inset', className)} aria-hidden />{label}</span>;
}

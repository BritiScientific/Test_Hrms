import { useLocation } from 'react-router';
import { BriefcaseBusiness, CalendarClock, Clock, IdCard, Repeat, Shuffle } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { Badge } from '@/components/ui/Badge';
import type { Column } from '@/modules/leave/components/shared';
import { workScheduleApi } from './api';
import { ConfigListView, nameColumn } from './components/ConfigListView';
import { NamedConfigForm } from './forms/NamedConfigForm';
import { RotationForm } from './forms/RotationForm';
import { ShiftScheduleForm, hoursLabel } from './forms/ShiftScheduleForm';
import { WORK_SCHEDULE_TABS, type TabKey } from './tabs';
import { baseCategoryLabel, type EmployeeType, type Rotation, type Shift, type ShiftSchedule, type WorkType } from './types';

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function usageText(parts: [number, string][]) {
  const used = parts.filter(([n]) => n > 0).map(([n, w]) => plural(n, w));
  return used.length ? used.join(', ') : <span className="text-muted">Not used</span>;
}

const rotationColumns: Column<Rotation>[] = [
  nameColumn<Rotation>('Pattern'),
  {
    key: 'sequence', header: 'Sequence',
    render: (r) => (
      <span className="text-sm">
        {r.items.map((i, n) => (
          <span key={i.id}>
            {n > 0 && <span className="px-1 text-muted" aria-hidden>›</span>}
            <span className={i.isActive ? undefined : 'text-muted line-through'}>{i.name}</span>
            {!i.isActive && <span className="sr-only"> (inactive)</span>}
          </span>
        ))}
      </span>
    ),
  },
  {
    key: 'interval', header: 'Interval',
    render: (r) => `Every ${plural(r.rotationInterval, r.rotationUnit === 'weeks' ? 'week' : 'day')}`,
  },
];

/** What each tab lists and how it is edited. */
export function TabContent({ tab, canManage }: { tab: TabKey; canManage: boolean }) {
  switch (tab) {
    case 'employee-type':
      return (
        <ConfigListView<EmployeeType>
          resource="employee-types" client={workScheduleApi.employeeTypes} label="Employee type"
          canManage={canManage} emptyIcon={<IdCard />}
          columns={[
            nameColumn<EmployeeType>(),
            { key: 'base', header: 'Base category', render: (r) => <Badge tone="primary">{baseCategoryLabel(r.baseCategory)}</Badge> },
            { key: 'employees', header: 'Employees', render: (r) => <span className="tabular">{r.employeeCount}</span> },
          ]}
          renderForm={(record, close) => (
            <NamedConfigForm kind="employee-type" record={record} client={workScheduleApi.employeeTypes} onClose={close} />
          )}
        />
      );
    case 'shift':
      return (
        <ConfigListView<Shift>
          resource="shifts" client={workScheduleApi.shifts} label="Shift"
          canManage={canManage} emptyIcon={<Clock />}
          columns={[
            nameColumn<Shift>(),
            { key: 'grace', header: 'Grace time', render: (r) => <span className="tabular">{r.graceTimeMinutes} min</span> },
            {
              key: 'usage', header: 'Used by',
              render: (r) => usageText([[r.usage.activeSchedules, 'schedule'], [r.usage.activeRotations, 'rotation']]),
            },
          ]}
          renderForm={(record, close) => <NamedConfigForm kind="shift" record={record} client={workScheduleApi.shifts} onClose={close} />}
        />
      );
    case 'work-type':
      return (
        <ConfigListView<WorkType>
          resource="work-types" client={workScheduleApi.workTypes} label="Work type"
          canManage={canManage} emptyIcon={<BriefcaseBusiness />}
          columns={[
            nameColumn<WorkType>(),
            { key: 'usage', header: 'Used by', render: (r) => usageText([[r.usage.activeRotations, 'rotation']]) },
          ]}
          renderForm={(record, close) => <NamedConfigForm kind="work-type" record={record} client={workScheduleApi.workTypes} onClose={close} />}
        />
      );
    case 'shift-schedule':
      return (
        <ConfigListView<ShiftSchedule>
          resource="shift-schedules" client={workScheduleApi.shiftSchedules} label="Shift schedule"
          canManage={canManage} emptyIcon={<CalendarClock />} minWidth="56rem"
          columns={[
            nameColumn<ShiftSchedule>(),
            {
              key: 'shift', header: 'Shift',
              render: (r) => (
                <span>
                  {r.shiftName}
                  {!r.shiftActive && <Badge tone="warning" className="ml-2">Inactive</Badge>}
                </span>
              ),
            },
            {
              key: 'days', header: 'Working days',
              render: (r) => (
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {r.workingDaysSummary}
                  {r.days.some((d) => d.isNightShift) && <Badge tone="violet">Overnight</Badge>}
                </span>
              ),
            },
            { key: 'minimum', header: 'Default minimum', render: (r) => hoursLabel(r.defaultMinimumWorkingMinutes) },
          ]}
          renderForm={(record, close) => <ShiftScheduleForm record={record} client={workScheduleApi.shiftSchedules} onClose={close} />}
        />
      );
    case 'rotating-shift':
      return (
        <ConfigListView<Rotation>
          resource="rotating-shifts" client={workScheduleApi.rotatingShifts} label="Rotating shift"
          canManage={canManage} emptyIcon={<Repeat />} columns={rotationColumns}
          renderForm={(record, close) => <RotationForm of="shift" record={record} client={workScheduleApi.rotatingShifts} onClose={close} />}
        />
      );
    case 'rotating-work-type':
      return (
        <ConfigListView<Rotation>
          resource="rotating-work-types" client={workScheduleApi.rotatingWorkTypes} label="Rotating work type"
          canManage={canManage} emptyIcon={<Shuffle />} columns={rotationColumns}
          renderForm={(record, close) => <RotationForm of="work-type" record={record} client={workScheduleApi.rotatingWorkTypes} onClose={close} />}
        />
      );
  }
}

/** Child route for one tab (the router wraps it in that tab's .view guard). */
export default function WorkScheduleTab() {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const tab = WORK_SCHEDULE_TABS.find((t) => pathname.endsWith(`/${t.key}`));
  if (!tab) return null;
  // key: each tab gets a fresh list (search, filter, page).
  return <TabContent key={tab.key} tab={tab.key} canManage={can(tab.manage)} />;
}

import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { SETTINGS_NAV, visibleGroups, firstSettingsPath } from '@/components/navigation/nav-config';
import { ToastProvider } from '@/components/ui/Toast';
import { routes } from '@/app/router';
import { ApiError } from '@/services/api-client';
import { workScheduleApi, type ResourceApi } from '@/modules/work-schedule/api';
import { ConfigListView, nameColumn } from '@/modules/work-schedule/components/ConfigListView';
import { StatusToggleDialog } from '@/modules/work-schedule/components/StatusToggleDialog';
import { RotationForm } from '@/modules/work-schedule/forms/RotationForm';
import { isOvernight, parseDuration, scheduleSchema, spanMinutes } from '@/modules/work-schedule/forms/ShiftScheduleForm';
import { WORK_SCHEDULE_TABS, firstVisibleTab } from '@/modules/work-schedule/tabs';
import type { Rotation, Shift } from '@/modules/work-schedule/types';
import { auditActionLabel } from '@/utils/permissions';

vi.mock('@/app/providers/AuthProvider', async (orig) => {
  const actual = await orig<typeof import('@/app/providers/AuthProvider')>();
  return { ...actual };
});

const can = (perms: string[]) => {
  const set = new Set(perms);
  return (...codes: string[]) => codes.some((c) => set.has(c));
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider>
    </QueryClientProvider>,
  );
}

const shift = (o: Partial<Shift> = {}): Shift => ({
  id: 1, name: 'Night Shift', description: null, isActive: true, createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', createdBy: 1, updatedBy: 1, graceTimeMinutes: 10,
  usage: { activeSchedules: 0, activeRotations: 0 }, ...o,
});

function fakeClient<T>(items: T[], overrides: Partial<ResourceApi<T>> = {}): ResourceApi<T> {
  return {
    list: vi.fn().mockResolvedValue({ items, total: items.length, page: 1, limit: 25 }),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    setStatus: vi.fn(),
    ...overrides,
  } as unknown as ResourceApi<T>;
}

// ------------------------------------------------------------- navigation ---
describe('navigation and routes', () => {
  it('Work Schedule shows in settings for any work schedule permission, and not for a manager', () => {
    const items = (perms: string[]) => visibleGroups(SETTINGS_NAV, can(perms)).flatMap((g) => g.items.map((i) => i.label));
    expect(items(['workschedule.shift.view'])).toContain('Work Schedule');
    expect(items(['workschedule.employee_type.manage'])).toContain('Work Schedule');
    expect(items(['leave.request.approve'])).not.toContain('Work Schedule');
  });

  it('/settings/work-schedule opens the first tab the user may view', () => {
    expect(firstVisibleTab(can(['workschedule.employee_type.view']))?.key).toBe('employee-type');
    expect(firstVisibleTab(can(['workschedule.shift.view', 'workschedule.work_type.view']))?.key).toBe('shift');
    expect(firstVisibleTab(can([]))).toBeUndefined();
    expect(firstSettingsPath(can(['workschedule.work_type.view']))).toBe('/settings/work-schedule');
  });

  it('each tab is its own route with a breadcrumb: Settings > Work Schedule > <tab>', () => {
    const find = (list: any[], path: string): any => {
      for (const r of list) {
        if (r.path === path) return r;
        const hit = r.children && find(r.children, path);
        if (hit) return hit;
      }
      return undefined;
    };
    const ws = find(routes, 'work-schedule');
    expect(ws.handle.crumb).toBe('Work Schedule');
    const tabs = ws.children.filter((c: any) => c.path);
    expect(tabs.map((c: any) => c.path)).toEqual(WORK_SCHEDULE_TABS.map((t) => t.key));
    expect(tabs.map((c: any) => c.handle.crumb)).toEqual(
      ['Shift', 'Shift Schedule', 'Rotating Shift', 'Work Type', 'Rotating Work Type', 'Employee Type']);
  });

  it('work schedule audit events read as sentences', () => {
    expect(auditActionLabel('shift.deactivated')).toBe('Shift deactivated');
    expect(auditActionLabel('rotating_work_type.created')).toBe('Rotating work type created');
  });
});

// -------------------------------------------------------------- list view ---
describe('ConfigListView', () => {
  const view = (canManage: boolean) => wrap(
    <ConfigListView<Shift> resource="shifts" client={fakeClient([shift(), shift({ id: 2, name: 'Day', isActive: false })])}
      label="Shift" columns={[nameColumn<Shift>()]} canManage={canManage} emptyIcon={null} renderForm={() => null} />,
  );

  it('offers Edit and Activate/Deactivate, and never Delete', async () => {
    view(true);
    await screen.findAllByText('Night Shift');
    expect(screen.getAllByRole('button', { name: 'Edit Night Shift' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Deactivate Night Shift' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Activate Day' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
  });

  it('view-only users get no create, edit or status buttons', async () => {
    view(false);
    await screen.findAllByText('Night Shift');
    expect(screen.queryByRole('button', { name: /new shift/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit|activate|deactivate/i })).toBeNull();
  });
});

// ---------------------------------------------------------- status dialog ---
describe('StatusToggleDialog', () => {
  it('lists the records that block a deactivation', async () => {
    const client = fakeClient<Shift>([], {
      setStatus: vi.fn().mockRejectedValue(new ApiError(409, 'HAS_ACTIVE_DEPENDENTS', 'Still in use', {
        total: 2,
        items: [{ type: 'shift_schedule', id: 4, name: 'Weekday Schedule' }, { type: 'rotating_shift', id: 7, name: 'Morning / Night' }],
      })),
    });
    wrap(<StatusToggleDialog record={shift()} label="Shift" client={client} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Still in use by 2 active records')).toBeInTheDocument();
    expect(screen.getByText('Weekday Schedule')).toBeInTheDocument();
    expect(screen.getByText('Morning / Night')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------- rotation form ---
describe('RotationForm', () => {
  const rotation: Rotation = {
    id: 9, name: 'Morning / Night', description: null, isActive: true, createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z',
    createdBy: 1, updatedBy: 1, rotationInterval: 1, rotationUnit: 'weeks', sequenceSummary: 'Morning > Night',
    items: [
      { id: 1, name: 'Morning', isActive: true, sequenceOrder: 1 },
      { id: 2, name: 'Night', isActive: true, sequenceOrder: 2 },
    ],
  };

  it('reorders entries with the arrow buttons and saves them in that order', async () => {
    vi.spyOn(workScheduleApi, 'shiftOptions').mockResolvedValue([
      { id: 1, name: 'Morning', graceTimeMinutes: 0 }, { id: 2, name: 'Night', graceTimeMinutes: 0 },
    ]);
    const update = vi.fn().mockResolvedValue(rotation);
    wrap(<RotationForm of="shift" record={rotation} client={fakeClient<Rotation>([], { update })} onClose={() => {}} />);
    const list = screen.getByRole('list', { name: 'Rotating shift sequence' });
    await userEvent.click(within(list).getByRole('button', { name: 'Move Night up' }));
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Night'), expect.stringContaining('Morning')]);
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][1]).toMatchObject({ items: [2, 1], updatedAt: rotation.updatedAt });
  });

  it('a deactivated entry is shown as Inactive and must be removed before saving', async () => {
    vi.spyOn(workScheduleApi, 'shiftOptions').mockResolvedValue([{ id: 1, name: 'Morning', graceTimeMinutes: 0 }]);
    const update = vi.fn();
    const withInactive = { ...rotation, items: [rotation.items[0], { ...rotation.items[1], isActive: false }] };
    wrap(<RotationForm of="shift" record={withInactive} client={fakeClient<Rotation>([], { update })} onClose={() => {}} />);
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText(/Remove deactivated shifts: Night/)).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------ weekly editor rules ---
describe('shift schedule rules', () => {
  const week = (patch: Record<number, object> = {}) => Array.from({ length: 7 }, (_, i) => ({
    dayOfWeek: i + 1, isWorkingDay: i < 5, startTime: i < 5 ? '09:00' : '', endTime: i < 5 ? '18:00' : '', minimum: '', ...patch[i],
  }));
  const parse = (days: ReturnType<typeof week>, defaultMinimum = '8:00') => scheduleSchema.safeParse({
    name: 'Standard', description: '', shiftId: '1', defaultMinimum, automaticCheckoutEnabled: false, days,
  });
  const issuePaths = (r: ReturnType<typeof parse>) => (r.success ? [] : r.error.issues.map((i) => i.path.join('.')));

  it('22:00 to 06:00 is overnight and lasts 8 hours', () => {
    expect(isOvernight('22:00', '06:00')).toBe(true);
    expect(spanMinutes('22:00', '06:00')).toBe(480);
    expect(parse(week({ 0: { startTime: '22:00', endTime: '06:00' } })).success).toBe(true);
  });

  it('a minimum longer than the shift is rejected on that day', () => {
    expect(issuePaths(parse(week({ 2: { minimum: '9:30' } })))).toEqual(['days.2.minimum']);
  });

  it('the default minimum also applies, and equal start and end is rejected', () => {
    expect(issuePaths(parse(week(), '9:30'))).toHaveLength(5);
    expect(issuePaths(parse(week({ 1: { endTime: '09:00' } })))).toEqual(['days.1.endTime']);
  });

  it('a working day needs both times; a day off needs none', () => {
    expect(issuePaths(parse(week({ 0: { startTime: '' } })))).toEqual(['days.0.startTime']);
    expect(parse(week({ 5: { isWorkingDay: false, startTime: '', endTime: '' } })).success).toBe(true);
  });

  it('durations are h:mm up to 24 hours', () => {
    expect(parseDuration('8:30')).toBe(510);
    expect(parseDuration('24:00')).toBe(1440);
    expect(parseDuration('24:01')).toBeNull();
    expect(parseDuration('8h')).toBeNull();
  });
});

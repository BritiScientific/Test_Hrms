import type { ReactNode } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_NAV, visibleGroups } from '@/components/navigation/nav-config';
import { ToastProvider } from '@/components/ui/Toast';
import { routes } from '@/app/router';
import { api, ApiError } from '@/services/api-client';
import { assignmentApi, pickerApi } from '@/modules/work-schedules/api';
import { AssignDialog } from '@/modules/work-schedules/AssignmentDialogs';
import { AssignmentList } from '@/modules/work-schedules/AssignmentList';
import { EmployeePickerDialog } from '@/modules/work-schedules/EmployeePickerDialog';
import { ASSIGN_TABS, firstVisibleAssignTab } from '@/modules/work-schedules/tabs';
import type { Assignment, PickerEmployee } from '@/modules/work-schedules/types';

vi.mock('@/app/providers/AuthProvider', async (orig) => {
  const actual = await orig<typeof import('@/app/providers/AuthProvider')>();
  return {
    ...actual,
    useMe: () => ({ tenant: { preferences: { dateFormat: 'YYYY-MM-DD', timezone: 'Asia/Kolkata' } } }),
  };
});

const can = (perms: string[]) => {
  const set = new Set(perms);
  return (...codes: string[]) => codes.some((c) => set.has(c));
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}><ToastProvider><MemoryRouter>{ui}</MemoryRouter></ToastProvider></QueryClientProvider>,
  );
}

const TAB = ASSIGN_TABS[0];

const assignment = (o: Partial<Assignment> = {}): Assignment => ({
  id: 1, employee: { id: 10, name: 'Priya', code: 'E502', jobTitle: null },
  pattern: { id: 5, name: 'Morning / Night', isActive: true },
  rotation: { basedOn: 'after', afterDays: 8 }, rotateLabel: 'Every 8 days', sequenceSummary: 'Morning > Night', startDate: '2026-01-01', endDate: null,
  status: 'active', phase: 'current', reason: null, createdAt: '', updatedAt: '2026-01-01T00:00:00.000Z',
  current: { id: 1, name: 'Morning' }, nextSwitch: '2026-01-09', next: { id: 2, name: 'Night' }, ...o,
});

afterEach(() => vi.restoreAllMocks());

describe('navigation and routes', () => {
  it('Work Schedules shows for any assignment permission, and not for a manager', () => {
    const labels = (perms: string[]) => visibleGroups(SETTINGS_NAV, can(perms)).flatMap((g) => g.items.map((i) => i.label));
    expect(labels(['workschedule.rotating_shift_assignment.view'])).toContain('Work Schedules');
    expect(labels(['workschedule.rotating_work_type_assignment.manage'])).toContain('Work Schedules');
    expect(labels(['leave.request.approve'])).not.toContain('Work Schedules');
  });

  it('opens the first tab the user may view', () => {
    expect(firstVisibleAssignTab(can(['workschedule.rotating_work_type_assignment.view']))?.key).toBe('rotating-work-type');
    expect(firstVisibleAssignTab(can([]))).toBeUndefined();
  });

  it('the breadcrumb reads Settings > Work Schedule > Work Schedules', () => {
    const settings: any = (routes[0].children as any[]).flatMap(function walk(r: any): any[] { return [r, ...(r.children ?? []).flatMap(walk)]; })
      .find((r: any) => r.path === '/settings');
    const crumbs = (list: any[]): string[] => list.flatMap((r) => [r.handle?.crumb, ...(r.children ? crumbs(r.children) : [])]).filter(Boolean);
    const group = settings.children.find((c: any) => !c.path && c.handle?.crumb === 'Work Schedule');
    expect(group.handle.crumb).toBe('Work Schedule');
    const page = group.children[0];
    expect([page.path, page.handle.crumb]).toEqual(['work-schedules', 'Work Schedules']);
    expect(page.children.filter((c: any) => c.path).map((c: any) => c.path)).toEqual(['rotating-shift', 'rotating-work-type']);
    expect(crumbs(settings.children)).toContain('Work Schedules');
  });
});

describe('AssignmentList', () => {
  const mockList = (items: Assignment[]) =>
    vi.spyOn(api, 'get').mockResolvedValue({ items, total: items.length, page: 1, limit: 25 } as never);

  it('shows the computed current, next switch and next, and offers End or Cancel but never Delete', async () => {
    mockList([
      assignment(),
      assignment({ id: 2, employee: { id: 11, name: 'Rahul', code: 'E501', jobTitle: null }, phase: 'upcoming', current: null, nextSwitch: null, next: null, startDate: '2026-12-01' }),
    ]);
    wrap(<AssignmentList tab={TAB} canManage />);
    await screen.findAllByText('Priya');
    expect(screen.getAllByText('Morning').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-01-09').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: "End Priya's rotation" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: "Cancel Rahul's assignment" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: "Cancel Priya's assignment" })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete|remove/i })).toBeNull();
  });

  it('view-only users get no Assign, Edit, End, Cancel or selection', async () => {
    mockList([assignment()]);
    wrap(<AssignmentList tab={TAB} canManage={false} />);
    await screen.findAllByText('Priya');
    expect(screen.queryByRole('button', { name: /^assign$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit|end|cancel/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('an ended or cancelled assignment has no row actions', async () => {
    mockList([assignment({ status: 'ended', phase: 'completed' }), assignment({ id: 3, status: 'cancelled', phase: 'cancelled' })]);
    wrap(<AssignmentList tab={TAB} canManage />);
    await screen.findAllByText('Priya');
    expect(screen.queryByRole('button', { name: /^edit/i })).toBeNull();
  });
});

describe('EmployeePickerDialog', () => {
  const emp = (id: number, name: string, assigned = false): PickerEmployee =>
    ({ id, name, code: `E${id}`, jobTitle: null, department: null, employeeType: null, assigned });

  it('keeps the selection across pages and flags employees who are already assigned', async () => {
    vi.spyOn(pickerApi, 'options').mockResolvedValue({ jobTitles: [], departments: [], employeeTypes: [], roles: [], managers: [] });
    vi.spyOn(pickerApi, 'list').mockImplementation(async (_k, _f, page) => ({
      items: page === 1 ? [emp(1, 'Asha', true), emp(2, 'Anita')] : [emp(3, 'Rahul')], total: 12, page, limit: 10,
    }));
    const onConfirm = vi.fn();
    wrap(<EmployeePickerDialog open kind="rotating-shift" initial={new Map()} onClose={() => {}} onConfirm={onConfirm} />);
    await screen.findByText('Asha');
    expect(screen.getByText('Already assigned')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Anita' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('Rahul');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select Rahul' }));
    const selected = screen.getByRole('complementary', { name: 'Selected employees' });
    expect(within(selected).getByText('Anita')).toBeInTheDocument();
    expect(within(selected).getByText('Rahul')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Select 2 employees/ }));
    expect([...onConfirm.mock.calls[0][0].keys()]).toEqual([2, 3]);
  });

  it('"Select all matching" adds every matching id', async () => {
    vi.spyOn(pickerApi, 'options').mockResolvedValue({ jobTitles: [], departments: [], employeeTypes: [], roles: [], managers: [] });
    vi.spyOn(pickerApi, 'list').mockResolvedValue({ items: [emp(1, 'Asha')], total: 4, page: 1, limit: 10 });
    vi.spyOn(pickerApi, 'allIds').mockResolvedValue({ ids: [1, 2, 3, 4], total: 4, truncated: false });
    wrap(<EmployeePickerDialog open kind="rotating-shift" initial={new Map()} onClose={() => {}} onConfirm={() => {}} />);
    await screen.findByText('Asha');
    await userEvent.click(screen.getByRole('button', { name: 'Select all 4 matching' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Select 4 employees/ })).toBeInTheDocument());
  });
});

describe('AssignDialog', () => {
  const patterns = { items: [{ id: 5, name: 'Morning / Night', isActive: true, sequenceSummary: 'Morning > Night' }], total: 1, page: 1, limit: 100 };

  it('shows the sequence of the chosen pattern', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(patterns as never);
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    await screen.findByRole('option', { name: 'Morning / Night' });
    await userEvent.selectOptions(screen.getByLabelText(/Rotating shift/), '5');
    expect(screen.getByTestId('rotation-summary')).toHaveTextContent('Sequence: Morning > Night');
  });

  it('"Based on" switches the field below it: days for After, weekdays for Weekly, 1-31 and Last day for Monthly', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(patterns as never);
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    const basedOn = screen.getByLabelText(/Based on/);
    expect([...(basedOn as HTMLSelectElement).options].map((o) => o.text)).toEqual(['After', 'Weekly', 'Monthly']);
    expect(screen.getByLabelText(/Rotate after day/)).toHaveAttribute('type', 'number');

    await userEvent.selectOptions(basedOn, 'weekly');
    expect(screen.queryByLabelText(/Rotate after day/)).toBeNull();
    const weekday = screen.getByLabelText(/Rotate on(?! day)/) as HTMLSelectElement;
    expect([...weekday.options].map((o) => o.text)).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

    await userEvent.selectOptions(basedOn, 'monthly');
    const day = screen.getByLabelText(/Rotate on day/) as HTMLSelectElement;
    const texts = [...day.options].map((o) => o.text);
    expect(texts).toHaveLength(32);
    expect([texts[0], texts[30], texts[31]]).toEqual(['1', '31', 'Last day']);
  });

  it('sends the chosen rule: weekly Wednesday, then monthly on the last day', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.includes('employee-picker/options')) return { jobTitles: [], departments: [], employeeTypes: [], roles: [], managers: [] } as never;
      if (path.includes('employee-picker')) return { items: [{ id: 10, name: 'Priya', code: 'E1', jobTitle: null, department: null, employeeType: null, assigned: false }], total: 1, page: 1, limit: 10 } as never;
      return patterns as never;
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ items: [], total: 1 } as never);
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Employees/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Priya' }));
    await userEvent.click(screen.getByRole('button', { name: /Select 1 employee/ }));
    await screen.findByRole('option', { name: 'Morning / Night' });
    await userEvent.selectOptions(screen.getByLabelText(/Rotating shift/), '5');

    await userEvent.selectOptions(screen.getByLabelText(/Based on/), 'weekly');
    await userEvent.selectOptions(screen.getByLabelText(/Rotate on(?! day)/), '3');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0][1] as any).rotation).toEqual({ basedOn: 'weekly', weekday: 3 });

  });

  it('rejects zero days before calling the server', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(patterns as never);
    const post = vi.spyOn(api, 'post');
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    await userEvent.clear(screen.getByLabelText(/Rotate after day/));
    await userEvent.type(screen.getByLabelText(/Rotate after day/), '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a whole number of days from 1 to 365')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('needs employees and a pattern before it calls the server', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(patterns as never);
    const create = vi.spyOn(api, 'post');
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose at least one employee')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('lists every clash when the server refuses an overlapping bulk assignment', async () => {
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.includes('employee-picker/options')) return { jobTitles: [], departments: [], employeeTypes: [], roles: [], managers: [] } as never;
      if (path.includes('employee-picker')) return { items: [{ id: 10, name: 'Priya', code: 'E1', jobTitle: null, department: null, employeeType: null, assigned: true }], total: 1, page: 1, limit: 10 } as never;
      return patterns as never;
    });
    vi.spyOn(api, 'post').mockRejectedValue(new ApiError(409, 'ASSIGNMENT_OVERLAP', 'Nothing was saved', {
      conflicts: [{ employeeId: 10, employeeName: 'Priya', assignmentId: 1, patternName: 'Morning / Night', startDate: '2026-01-01', endDate: null }],
    }));
    wrap(<AssignDialog tab={TAB} client={assignmentApi(TAB.path)} onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: /Employees/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Select Priya' }));
    await userEvent.click(screen.getByRole('button', { name: /Select 1 employee/ }));
    await screen.findByRole('option', { name: 'Morning / Night' });
    await userEvent.selectOptions(screen.getByLabelText(/Rotating shift/), '5');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing was saved')).toBeInTheDocument();
    expect(screen.getByText('Priya')).toBeInTheDocument();
    expect(screen.getByText(/Morning \/ Night, from/)).toBeInTheDocument();
  });
});

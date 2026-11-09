import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { MAIN_NAV, UPCOMING_MODULES, visibleGroups } from '@/components/navigation/nav-config';
import { buildDays, monthGrid, weekDays } from '@/modules/leave/components/MonthCalendar';
import { DataTable, Pager, ReasonDialog } from '@/modules/leave/components/shared';
import { rowsToCondition } from '@/modules/leave/config/ApprovalWorkflowsPage';
import { applySchema } from '@/modules/leave/employee/ApplyLeavePage';
import { dateRange, days, toCsv } from '@/modules/leave/leave-format';
import { Tabs } from '@/components/ui/Tabs';

vi.mock('@/app/providers/AuthProvider', async (orig) => {
  const actual = await orig<typeof import('@/app/providers/AuthProvider')>();
  return { ...actual };
});

/** The items a user sees in one sidebar group, for a set of permissions. */
const navFor = (perms: string[], hasEmployee = true) => {
  const set = new Set(perms);
  return visibleGroups(MAIN_NAV, (...c) => c.some((x) => set.has(x)), hasEmployee);
};
const itemsIn = (groups: ReturnType<typeof navFor>, label: string) =>
  groups.find((g) => g.label === label)?.items.map((i) => i.label) ?? [];

const EMPLOYEE = ['leave.dashboard.view_self', 'leave.request.create_self', 'leave.request.view_self', 'leave.request.cancel_self', 'leave.balance.view_self', 'leave.calendar.view_self'];
const MANAGER = ['leave.dashboard.view_team', 'leave.request.view_team', 'leave.request.approve', 'leave.request.reject', 'leave.request.return', 'leave.approval_history.view_team'];
const HR = ['leave.dashboard.view_all', 'leave.request.view_all', 'leave.request.manage', 'leave.calendar.view_all', 'leave.reports.view', 'leave.configuration.view', 'leave.configuration.manage', 'leave.policy.assign', 'leave.balance.adjust', 'workflow.configure'];

describe('leave navigation follows permissions', () => {
  it('employee menu', () => {
    const g = navFor(EMPLOYEE);
    expect(itemsIn(g, 'Leave Management')).toEqual(['My Leave Dashboard', 'Apply for Leave', 'My Leave Requests & Balance', 'Holiday Calendar']);
    expect(itemsIn(g, 'Leave Management · Team')).toEqual([]);
    expect(itemsIn(g, 'Leave Management · HR')).toEqual([]);
    expect(itemsIn(g, 'Leave Configuration')).toEqual([]);
  });
  it('manager menu has no Team Leave Calendar', () => {
    const items = itemsIn(navFor(MANAGER), 'Leave Management · Team');
    expect(items).toEqual(['Leave Dashboard', 'Team Leave Requests & Approvals']);
  });
  it('HR menu and configuration', () => {
    const g = navFor(HR);
    expect(itemsIn(g, 'Leave Management · HR')).toEqual(['Leave Dashboard', 'All Leave Requests', 'Leave Calendar', 'Leave Reports']);
    expect(itemsIn(g, 'Leave Configuration')).toEqual([
      'Leave Types', 'Leave Policies', 'Holiday Calendars', 'Approval Workflows', 'Accrual & Carry Forward', 'Employee Leave Assignments',
    ]);
  });
  it('someone with several roles sees each menu once', () => {
    const g = navFor([...EMPLOYEE, ...MANAGER, ...HR]);
    expect(g.filter((x) => x.label?.startsWith('Leave')).length).toBe(4);
  });
  it('self-service needs an employee record, even with the permission', () => {
    expect(itemsIn(navFor(EMPLOYEE, false), 'Leave Management')).toEqual([]);
  });
  it('no permissions, no leave menus', () => {
    expect(navFor([]).filter((x) => x.label?.startsWith('Leave')).length).toBe(0);
  });
  it('leave is no longer listed as coming later', () => {
    expect(UPCOMING_MODULES.map((m) => m.label)).not.toContain('Leave Management');
  });
});

describe('application form validation', () => {
  const base = { leaveTypeCode: 'CL', startDate: '2027-02-01', endDate: '2027-02-02', durationType: 'full_day' as const, halfDaySession: '', reason: 'Family event', contactDetails: '' };
  const errorsOf = (v: object) => {
    const r = applySchema.safeParse(v);
    return r.success ? {} : r.error.flatten().fieldErrors;
  };
  it('accepts a complete form', () => expect(applySchema.safeParse(base).success).toBe(true));
  it('needs a leave type, dates and a reason', () => {
    const e = errorsOf({ ...base, leaveTypeCode: '', startDate: '', reason: ' ' });
    expect(e.leaveTypeCode).toBeTruthy();
    expect(e.startDate).toBeTruthy();
    expect(e.reason).toBeTruthy();
  });
  it('rejects an end date before the start date', () => {
    expect(errorsOf({ ...base, endDate: '2027-01-31' }).endDate).toBeTruthy();
  });
  it('a half day needs a session', () => {
    expect(errorsOf({ ...base, durationType: 'half_day' }).halfDaySession).toBeTruthy();
    expect(applySchema.safeParse({ ...base, durationType: 'half_day', halfDaySession: 'first_half' }).success).toBe(true);
  });
});

describe('calendar grid', () => {
  it('covers whole weeks from the chosen first day', () => {
    const g = monthGrid(2027, 2, 1); // February 2027 starts on a Monday
    expect(g[0]).toBe('2027-02-01');
    expect(g.length % 7).toBe(0);
    expect(g).toContain('2027-02-28');
  });
  it('pads days from neighbouring months', () => {
    const g = monthGrid(2027, 3, 1); // March 2027 starts on a Monday too, April does not
    const april = monthGrid(2027, 4, 1);
    expect(g[0]).toBe('2027-03-01');
    expect(april[0]).toBe('2027-03-29');
  });
  it('a week view is seven days from the first day of the week', () => {
    const w = weekDays('2027-02-03', 1);
    expect(w).toHaveLength(7);
    expect(w[0]).toBe('2027-02-01');
    expect(w[6]).toBe('2027-02-07');
  });
  it('places holidays and multi-day leave on every date they cover', () => {
    const d = buildDays(['2027-02-01', '2027-02-02', '2027-02-06'], {
      month: 2, today: '2027-02-02', weeklyOffs: [0, 6],
      holidays: [{ day: '2027-02-01', name: 'H', holidayType: 'national', isOptional: false }],
      leaves: [{ id: 1, employeeId: 1, employeeName: 'A', departmentName: null, leaveTypeName: 'CL', startDate: '2027-02-01', endDate: '2027-02-02', durationType: 'full_day', halfDaySession: null, totalDays: 2, status: 'approved', createdAt: '' }],
    });
    expect(d[0].holidays).toHaveLength(1);
    expect(d[0].leaves).toHaveLength(1);
    expect(d[1].leaves).toHaveLength(1);
    expect(d[1].isToday).toBe(true);
    expect(d[2].leaves).toHaveLength(0);
    expect(d[2].isWeeklyOff).toBe(true);
  });
});

describe('formatting', () => {
  it('shows days without noise', () => {
    expect(days(1)).toBe('1');
    expect(days(1.5)).toBe('1.5');
    expect(days(0.5)).toBe('0.5');
    expect(days(null)).toBe('—');
  });
  it('shows a half-day session', () => {
    const prefs = { dateFormat: 'DD/MM/YYYY' as const, timezone: 'UTC' };
    expect(dateRange({ startDate: '2027-02-01', endDate: '2027-02-01', halfDaySession: 'first_half' }, prefs)).toBe('01/02/2027 (First half)');
    expect(dateRange({ startDate: '2027-02-01', endDate: '2027-02-03' }, prefs)).toBe('01/02/2027 – 03/02/2027');
  });
  it('CSV: quotes what needs it and neutralises spreadsheet formulas', () => {
    const csv = toCsv([{ key: 'a', label: 'Name' }, { key: 'b', label: 'Days' }], [{ a: '=HYPERLINK("http://x")', b: 2 }, { a: 'Smith, Jan', b: -1.5 }]);
    const [, first, second] = csv.split('\r\n');
    expect(first.startsWith(`"'=HYPERLINK`)).toBe(true);
    expect(second).toBe('"Smith, Jan",-1.5');
  });
});

describe('workflow condition builder', () => {
  const fields = [
    { field: 'totalDays', label: 'Days', type: 'number' as const },
    { field: 'leaveTypeCode', label: 'Type', type: 'string' as const },
    { field: 'isPaid', label: 'Paid', type: 'boolean' as const },
  ];
  it('no rows means the step always applies', () => expect(rowsToCondition([], fields)).toBeNull());
  it('one row stays simple, with the right value type', () => {
    expect(rowsToCondition([{ field: 'totalDays', op: 'gt', value: '3' }], fields)).toEqual({ field: 'totalDays', op: 'gt', value: 3 });
    expect(rowsToCondition([{ field: 'isPaid', op: 'eq', value: 'false' }], fields)).toEqual({ field: 'isPaid', op: 'eq', value: false });
  });
  it('several rows must all hold, and "one of" splits on commas', () => {
    expect(rowsToCondition([
      { field: 'totalDays', op: 'gte', value: '5' },
      { field: 'leaveTypeCode', op: 'in', value: 'EL, SL' },
    ], fields)).toEqual({ all: [
      { field: 'totalDays', op: 'gte', value: 5 },
      { field: 'leaveTypeCode', op: 'in', value: ['EL', 'SL'] },
    ] });
  });
});

describe('shared components', () => {
  it('tabs: arrow keys move between tabs', async () => {
    const onChange = vi.fn();
    render(<Tabs label="Sections" active="a" onChange={onChange} tabs={[{ key: 'a', label: 'One' }, { key: 'b', label: 'Two', count: 3 }]} />);
    const tablist = screen.getByRole('tablist', { name: 'Sections' });
    expect(within(tablist).getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    expect(within(tablist).getByRole('tab', { name: /Two/ })).toHaveTextContent('3');
    within(tablist).getByRole('tab', { name: 'One' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('b');
  });
  it('data table: renders every column, and rows can be opened', async () => {
    const onRowClick = vi.fn();
    render(<MemoryRouter><DataTable caption="People" rows={[{ id: 1, n: 'Asha' }]} rowKey={(r) => r.id} onRowClick={onRowClick}
      columns={[{ key: 'n', header: 'Name', render: (r) => r.n }]} /></MemoryRouter>);
    expect(screen.getByRole('table', { name: 'People' })).toBeInTheDocument();
    await userEvent.click(screen.getAllByText('Asha')[0]);
    expect(onRowClick).toHaveBeenCalledWith({ id: 1, n: 'Asha' });
  });
  it('pager: limits and moves', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Pager total={50} limit={20} offset={0} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onChange).toHaveBeenCalledWith(20);
    rerender(<Pager total={50} limit={20} offset={40} onChange={onChange} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
  it('reason dialog: a required reason cannot be empty', async () => {
    const onConfirm = vi.fn();
    render(<ReasonDialog open title="Reject" label="Reason" confirmLabel="Reject it" onClose={() => {}} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reject it', hidden: true }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/Reason/, { selector: 'textarea' }), 'Busy period');
    await userEvent.click(screen.getByRole('button', { name: 'Reject it', hidden: true }));
    expect(onConfirm).toHaveBeenCalledWith('Busy period');
  });
});

/** Pure work schedule rules: no database needed. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMinutes, isOvernight, spanMinutes, summarizeWorkingDays, validateWeek, weeklyOffWarnings,
  type ScheduleDayInput,
} from '../src/modules/work-schedule/work-schedule-calculation';
import { ListQuery, RotationCreate, ScheduleCreate, ShiftCreate } from '../src/modules/work-schedule/work-schedule.schemas';
import { diffFields } from '../src/modules/work-schedule/work-schedule.audit';

const week = (overrides: Partial<Record<number, Partial<ScheduleDayInput>>> = {}): ScheduleDayInput[] =>
  [1, 2, 3, 4, 5, 6, 7].map((d) => ({
    dayOfWeek: d,
    isWorkingDay: d <= 5,
    startTime: d <= 5 ? '09:00' : null,
    endTime: d <= 5 ? '18:00' : null,
    minimumWorkingMinutes: d <= 5 ? 480 : 0,
    ...overrides[d],
  }));

describe('spans and overnight shifts', () => {
  test('a day shift spans end minus start', () => {
    assert.equal(spanMinutes('09:00', '18:00'), 540);
    assert.equal(isOvernight('09:00', '18:00'), false);
  });

  test('22:00 to 06:00 runs past midnight and lasts 480 minutes', () => {
    assert.equal(spanMinutes('22:00', '06:00'), 480);
    assert.equal(isOvernight('22:00', '06:00'), true);
  });

  test('times from PostgreSQL (HH:MM:SS) parse the same as HH:MM', () => {
    assert.equal(spanMinutes('22:00:00', '06:30:00'), 510);
  });

  test('minutes format as hours and minutes', () => {
    assert.equal(formatMinutes(480), '8h');
    assert.equal(formatMinutes(570), '9h 30m');
  });
});

describe('weekly validation', () => {
  test('a normal Monday to Friday week is valid', () => {
    assert.deepEqual(validateWeek(week(), 480), {});
  });

  test('a week needs exactly 7 days', () => {
    assert.ok(validateWeek(week().slice(0, 6), 0).days);
  });

  test('a day off with times is rejected', () => {
    const errors = validateWeek(week({ 6: { startTime: '09:00', endTime: '13:00' } }), 0);
    assert.ok(errors['days.5.startTime']);
  });

  test('a working day without times is rejected', () => {
    const errors = validateWeek(week({ 1: { startTime: null, endTime: null } }), 0);
    assert.ok(errors['days.0.startTime'] && errors['days.0.endTime']);
  });

  test('equal start and end is rejected', () => {
    const errors = validateWeek(week({ 2: { startTime: '09:00', endTime: '09:00' } }), 0);
    assert.match(errors['days.1.endTime'], /differ/);
  });

  test('09:00 to 18:00 with a 9h30 minimum is rejected (longer than the shift)', () => {
    const errors = validateWeek(week({ 3: { minimumWorkingMinutes: 570 } }), 0);
    assert.match(errors['days.2.minimumWorkingMinutes'], /longer than the shift/);
  });

  test('an overnight minimum is checked against the wrapped span', () => {
    assert.deepEqual(validateWeek(week({ 1: { startTime: '22:00', endTime: '06:00', minimumWorkingMinutes: 480 } }), 0), {});
    assert.ok(validateWeek(week({ 1: { startTime: '22:00', endTime: '06:00', minimumWorkingMinutes: 481 } }), 0)['days.0.minimumWorkingMinutes']);
  });

  test('a missing day minimum falls back to the schedule default, which is also checked', () => {
    const errors = validateWeek(week({ 1: { minimumWorkingMinutes: null } }), 600);
    assert.ok(errors['days.0.minimumWorkingMinutes'], 'default 600 > 540 span');
  });

  test('a repeated weekday is rejected', () => {
    const days = week();
    days[6] = { ...days[0] };
    assert.ok(validateWeek(days, 0)['days.6.dayOfWeek']);
  });
});

describe('weekly offs and summaries', () => {
  test('a working day on the organization weekly off is a warning (ISO 6 = Saturday = 6)', () => {
    const warnings = weeklyOffWarnings(week({ 6: { isWorkingDay: true, startTime: '09:00', endTime: '13:00' } }), [0, 6]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Saturday/);
  });

  test('ISO Sunday (7) maps to weekly-off 0', () => {
    const warnings = weeklyOffWarnings(week({ 7: { isWorkingDay: true, startTime: '09:00', endTime: '13:00' } }), [0]);
    assert.match(warnings[0], /Sunday/);
  });

  test('working days summarize as ranges', () => {
    assert.equal(summarizeWorkingDays([1, 2, 3, 4, 5]), 'Mon-Fri');
    assert.equal(summarizeWorkingDays([1, 3, 5]), 'Mon, Wed, Fri');
    assert.equal(summarizeWorkingDays([1, 2, 3, 6, 7]), 'Mon-Wed, Sat, Sun');
    assert.equal(summarizeWorkingDays([]), 'No working days');
  });
});

describe('request schemas', () => {
  test('grace time is 0 to 240 minutes', () => {
    assert.equal(ShiftCreate.safeParse({ name: 'Night', graceTimeMinutes: -1 }).success, false);
    assert.equal(ShiftCreate.safeParse({ name: 'Night', graceTimeMinutes: 241 }).success, false);
    assert.equal(ShiftCreate.safeParse({ name: 'Night', graceTimeMinutes: 240 }).success, true);
  });

  test('tenant_id, is_active and created_by cannot be mass-assigned', () => {
    assert.equal(ShiftCreate.safeParse({ name: 'Night', isActive: false }).success, false);
    assert.equal(ShiftCreate.safeParse({ name: 'Night', tenantId: 2 }).success, false);
  });

  test('a rotation needs 2 to 20 distinct entries, an interval of 1 to 365, and days or weeks', () => {
    const ok = { name: 'Rotation', items: [1, 2] };
    assert.equal(RotationCreate.safeParse({ ...ok, items: [1] }).success, false);
    assert.equal(RotationCreate.safeParse({ ...ok, items: [1, 1] }).success, false);
    assert.equal(RotationCreate.safeParse({ ...ok, items: Array.from({ length: 21 }, (_, i) => i + 1) }).success, false);
    assert.equal(RotationCreate.safeParse({ ...ok, rotationInterval: 0 }).success, false);
    assert.equal(RotationCreate.safeParse({ ...ok, rotationInterval: 366 }).success, false);
    assert.equal(RotationCreate.safeParse({ ...ok, rotationUnit: 'months' }).success, false);
    assert.equal(RotationCreate.safeParse(ok).success, true);
  });

  test('a schedule needs exactly 7 days and HH:MM times', () => {
    const days = week().map((d) => ({ ...d, minimumWorkingMinutes: d.minimumWorkingMinutes ?? 0 }));
    const name = 'Standard week';
    assert.equal(ScheduleCreate.safeParse({ name, shiftId: 1, days: days.slice(0, 6) }).success, false);
    assert.equal(ScheduleCreate.safeParse({ name, shiftId: 1, days: [{ ...days[0], startTime: '9am' }, ...days.slice(1)] }).success, false);
    assert.equal(ScheduleCreate.safeParse({ name, shiftId: 1, days }).success, true);
  });

  test('list limit is capped at 100 and sort is whitelisted', () => {
    assert.equal(ListQuery.safeParse({ limit: '101' }).success, false);
    assert.equal(ListQuery.safeParse({ sort: 'name; DROP TABLE x' }).success, false);
    assert.equal(ListQuery.safeParse({ sort: '-updatedAt' }).success, true);
  });
});

describe('audit diff', () => {
  test('only changed business fields are recorded', () => {
    const diff = diffFields(
      { id: 1, name: 'A', graceTimeMinutes: 5, updatedAt: 'x', usage: { activeSchedules: 1 } },
      { id: 1, name: 'B', graceTimeMinutes: 5, updatedAt: 'y', usage: { activeSchedules: 2 } },
    );
    assert.deepEqual(diff, { before: { name: 'A' }, after: { name: 'B' } });
  });

  test('no change means no diff', () => {
    assert.equal(diffFields({ name: 'A' }, { name: 'A' }), null);
  });
});

// ------------------------------------------------------------ rotation assignment ---
import { addDaysIso, daysBetween, resolveRotation, rotationLabel } from '../src/modules/work-schedule/work-schedule-calculation';
import { AssignmentCreate, AssignmentListQuery, PickerQuery } from '../src/modules/work-schedule/work-schedule.schemas';

describe('resolveRotation', () => {
  const items = ['A', 'B', 'C'];
  const at = (today: string, o: Partial<Parameters<typeof resolveRotation<string>>[0]> = {}) =>
    resolveRotation<string>({ startDate: '2026-01-01', endDate: null, today, rule: { basedOn: 'after', afterDays: 8 }, items, ...o });

  test('day 0 is the first entry and the next switch is one interval later', () => {
    const r = at('2026-01-01');
    assert.deepEqual([r.state, r.periodIndex, r.current, r.nextSwitch, r.next], ['current', 0, 'A', '2026-01-09', 'B']);
  });

  test('the last day of an interval is still the same entry', () => {
    assert.equal(at('2026-01-08').current, 'A');
    assert.equal(at('2026-01-08').nextSwitch, '2026-01-09');
  });

  test('the switch day starts the next entry', () => {
    const r = at('2026-01-09');
    assert.deepEqual([r.periodIndex, r.current, r.nextSwitch, r.next], [1, 'B', '2026-01-17', 'C']);
  });

  test('after the last entry it wraps to the first', () => {
    const r = at('2026-01-25'); // day 24 = period 3
    assert.deepEqual([r.periodIndex, r.current, r.next], [3, 'A', 'B']);
    assert.equal(at('2026-01-17').next, 'A'); // C -> A
  });

  test('"after" works for any number of days, including 14', () => {
    const rule = { basedOn: 'after', afterDays: 14 } as const;
    assert.equal(at('2026-01-14', { rule }).current, 'A');
    assert.equal(at('2026-01-15', { rule }).current, 'B');
  });

  test('weekly: switches on the chosen weekday, strictly after the start date', () => {
    const mon = { basedOn: 'weekly', weekday: 1 } as const; // 2026-01-01 is a Thursday
    let r = at('2026-01-04', { rule: mon });
    assert.deepEqual([r.current, r.nextSwitch, r.next], ['A', '2026-01-05', 'B']);
    assert.deepEqual([at('2026-01-05', { rule: mon }).current, at('2026-01-11', { rule: mon }).current], ['B', 'B']);
    assert.equal(at('2026-01-12', { rule: mon }).current, 'C');
    assert.equal(at('2026-01-19', { rule: mon }).current, 'A');
    r = at('2026-01-01', { rule: { basedOn: 'weekly', weekday: 4 } }); // same weekday as the start: first switch is a week later
    assert.equal(r.nextSwitch, '2026-01-08');
  });

  test('monthly: switches on the chosen day of each month', () => {
    const d15 = { basedOn: 'monthly', monthDay: 15 } as const;
    assert.deepEqual([at('2026-01-14', { rule: d15 }).current, at('2026-01-14', { rule: d15 }).nextSwitch], ['A', '2026-01-15']);
    assert.equal(at('2026-01-15', { rule: d15 }).current, 'B');
    assert.equal(at('2026-02-15', { rule: d15 }).current, 'C');
    assert.equal(at('2026-03-15', { rule: d15 }).current, 'A');
    // starting on the 1st with "day 1": the first switch is next month
    assert.equal(at('2026-01-20', { rule: { basedOn: 'monthly', monthDay: 1 } }).nextSwitch, '2026-02-01');
  });

  test('monthly: "last day" and day 31 follow the length of each month', () => {
    const last = { basedOn: 'monthly', monthDay: 'last' } as const;
    assert.deepEqual([at('2026-01-30', { rule: last }).nextSwitch, at('2026-01-31', { rule: last }).current], ['2026-01-31', 'B']);
    assert.deepEqual([at('2026-02-28', { rule: last }).current, at('2026-02-28', { rule: last }).nextSwitch], ['C', '2026-03-31']);
    const d31 = { basedOn: 'monthly', monthDay: 31 } as const;
    assert.equal(at('2026-02-27', { rule: d31 }).nextSwitch, '2026-02-28'); // February has no 31st
    assert.equal(at('2026-04-29', { rule: d31 }).nextSwitch, '2026-04-30');
    // across a year end
    assert.equal(resolveRotation({ startDate: '2026-12-20', endDate: null, today: '2026-12-25', rule: { basedOn: 'monthly', monthDay: 5 }, items }).nextSwitch, '2027-01-05');
  });

  test('before the start date there is no current entry', () => {
    const r = at('2025-12-31');
    assert.deepEqual([r.state, r.current, r.next, r.nextSwitch, r.periodIndex], ['upcoming', null, null, null, null]);
  });

  test('after the end date the rotation is completed', () => {
    const r = at('2026-02-01', { endDate: '2026-01-20' });
    assert.deepEqual([r.state, r.current], ['completed', null]);
    assert.equal(at('2026-01-20', { endDate: '2026-01-20' }).state, 'current', 'the end date itself is still in force');
  });

  test('a switch after the end date is not shown', () => {
    const r = at('2026-01-10', { endDate: '2026-01-12' });
    assert.deepEqual([r.current, r.nextSwitch, r.next], ['B', null, null]);
  });

  test('date arithmetic ignores DST and month lengths', () => {
    assert.equal(daysBetween('2026-03-01', '2026-03-31'), 30);
    assert.equal(addDaysIso('2026-02-27', 2), '2026-03-01');
    assert.equal(rotationLabel({ basedOn: 'after', afterDays: 8 }), 'Every 8 days');
    assert.equal(rotationLabel({ basedOn: 'weekly', weekday: 1 }), 'Every Monday');
    assert.equal(rotationLabel({ basedOn: 'monthly', monthDay: 'last' }), 'Monthly on the last day');
    assert.deepEqual([1, 2, 3, 11, 15, 22, 31].map((n) => rotationLabel({ basedOn: 'monthly', monthDay: n })),
      ['1st', '2nd', '3rd', '11th', '15th', '22nd', '31st'].map((o) => `Monthly on the ${o}`));
  });
});

describe('assignment schemas', () => {
  test('bulk create is capped at 200 distinct employees and needs a real date', () => {
    const ok = { employeeIds: [1, 2], patternId: 3, startDate: '2026-02-01', rotation: { basedOn: 'after', afterDays: 5 } };
    assert.equal(AssignmentCreate.safeParse(ok).success, true);
    assert.equal(AssignmentCreate.safeParse({ ...ok, employeeIds: Array.from({ length: 201 }, (_, i) => i + 1) }).success, false);
    assert.equal(AssignmentCreate.safeParse({ ...ok, employeeIds: Array.from({ length: 200 }, (_, i) => i + 1) }).success, true);
    assert.equal(AssignmentCreate.safeParse({ ...ok, employeeIds: [1, 1] }).success, false);
    assert.equal(AssignmentCreate.safeParse({ ...ok, employeeIds: [] }).success, false);
    assert.equal(AssignmentCreate.safeParse({ ...ok, startDate: '2026-02-31' }).success, false);
  });

  test('the rotation rule must match "based on"', () => {
    const ok = { employeeIds: [1], patternId: 3, startDate: '2026-02-01' };
    const parse = (rotation: unknown) => AssignmentCreate.safeParse({ ...ok, rotation }).success;
    assert.equal(parse({ basedOn: 'weekly', weekday: 7 }), true);
    assert.equal(parse({ basedOn: 'weekly', weekday: 8 }), false);
    assert.equal(parse({ basedOn: 'monthly', monthDay: 'last' }), true);
    assert.equal(parse({ basedOn: 'monthly', monthDay: 31 }), true);
    assert.equal(parse({ basedOn: 'monthly', monthDay: 32 }), false);
    assert.equal(parse({ basedOn: 'after', afterDays: 0 }), false);
    assert.equal(parse({ basedOn: 'after', afterDays: 366 }), false);
    assert.equal(parse({ basedOn: 'after', weekday: 1 }), false, 'a weekday does not belong to "after"');
    assert.equal(parse({ basedOn: 'yearly' }), false);
    assert.equal(AssignmentCreate.safeParse(ok).success, false, 'rotation is required');
  });

  test('tenant_id, status and assigned_by cannot be mass-assigned', () => {
    const ok = { employeeIds: [1], patternId: 3, startDate: '2026-02-01', rotation: { basedOn: 'after', afterDays: 5 } };
    for (const extra of [{ tenantId: 2 }, { status: 'ended' }, { assignedBy: 9 }]) {
      assert.equal(AssignmentCreate.safeParse({ ...ok, ...extra }).success, false);
    }
  });

  test('list limit is capped at 100 and sort is whitelisted', () => {
    assert.equal(AssignmentListQuery.safeParse({ limit: '101' }).success, false);
    assert.equal(AssignmentListQuery.safeParse({ sort: 'employee; drop' }).success, false);
    assert.equal(AssignmentListQuery.safeParse({ sort: '-employee', status: 'ended' }).success, true);
  });

  test('the picker needs a kind and parses idsOnly', () => {
    assert.equal(PickerQuery.safeParse({}).success, false);
    const q = PickerQuery.parse({ kind: 'rotating-shift', idsOnly: 'true' });
    assert.equal(q.idsOnly, true);
  });
});

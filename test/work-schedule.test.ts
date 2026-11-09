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

/** Pure leave rules: no database needed. */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLeaveDays } from '../src/modules/leave/leave-calculation';
import { duePeriods, type AccrualRule } from '../src/modules/leave/leave-accrual.service';
import { computeCarry, computeExpiries } from '../src/modules/leave/leave-carry-forward.service';

const WEEKEND = [0, 6];
// 2027-02-01 is a Monday.
const days = (startDate: string, endDate: string, extra: Partial<Parameters<typeof computeLeaveDays>[0]> = {}) =>
  computeLeaveDays({ startDate, endDate, weeklyOffs: WEEKEND, holidays: new Map(), includeNonWorkingDays: false, ...extra });

describe('chargeable days', () => {
  test('weekly offs are not charged', () => {
    const r = days('2027-02-04', '2027-02-08'); // Thursday to Monday
    assert.equal(r.totalDays, 3);
    assert.deepEqual(r.days.map((d) => d.dayType), ['working', 'working', 'weekly_off', 'weekly_off', 'working']);
  });

  test('holidays are not charged and keep their name', () => {
    const r = days('2027-02-01', '2027-02-03', { holidays: new Map([['2027-02-02', 'Founders Day']]) });
    assert.equal(r.totalDays, 2);
    assert.equal(r.days[1].dayType, 'holiday');
    assert.equal(r.days[1].holidayName, 'Founders Day');
  });

  test('a half day counts 0.5, and 0 on a weekly off', () => {
    assert.equal(days('2027-02-01', '2027-02-01', { halfDaySession: 'first_half' }).totalDays, 0.5);
    assert.equal(days('2027-02-06', '2027-02-06', { halfDaySession: 'first_half' }).totalDays, 0);
  });

  test('calendar-day leave types charge every date', () => {
    const r = days('2027-02-04', '2027-02-08', { includeNonWorkingDays: true, holidays: new Map([['2027-02-05', 'H']]) });
    assert.equal(r.totalDays, 5);
  });

  test('a date range entirely on non-working days is zero', () => {
    assert.equal(days('2027-02-06', '2027-02-07').totalDays, 0);
  });
});

const rule = (over: Partial<AccrualRule>): AccrualRule => ({
  id: 1, policy_id: 1, leave_type_id: 1, accrual_frequency: 'monthly', accrual_amount: 1.5,
  accrual_start_rule: 'joining_date', credit_timing: 'period_start', proration_enabled: false,
  maximum_balance: null, effective_from: '2020-01-01', effective_to: null, ...over,
});

describe('accrual periods', () => {
  test('monthly: one period per started month, up to the as-of date', () => {
    const p = duePeriods(rule({}), '2020-01-01', '2027-03-15');
    assert.deepEqual(p.map((x) => x.periodKey), ['2027-01', '2027-02', '2027-03']);
    assert.ok(p.every((x) => x.days === 1.5));
  });

  test('credit at period end waits for the end of the period', () => {
    const p = duePeriods(rule({ credit_timing: 'period_end' }), '2020-01-01', '2027-03-15');
    assert.deepEqual(p.map((x) => x.periodKey), ['2027-01', '2027-02']);
  });

  test('quarterly and annual keys', () => {
    assert.deepEqual(duePeriods(rule({ accrual_frequency: 'quarterly' }), '2020-01-01', '2027-05-01').map((x) => x.periodKey), ['2027-Q1', '2027-Q2']);
    assert.deepEqual(duePeriods(rule({ accrual_frequency: 'annual', accrual_amount: 12 }), '2020-01-01', '2027-05-01').map((x) => x.periodKey), ['2027']);
  });

  test('a joiner gets nothing before joining, and the joining period is prorated when enabled', () => {
    const p = duePeriods(rule({ proration_enabled: true }), '2027-03-16', '2027-04-30');
    assert.deepEqual(p.map((x) => x.periodKey), ['2027-03', '2027-04']);
    assert.equal(p[0].days, 0.77); // 16 of 31 days of 1.5
    assert.equal(p[0].creditDate, '2027-03-16');
    assert.equal(p[1].days, 1.5);
  });

  test('next_period skips the joining period', () => {
    const p = duePeriods(rule({ accrual_start_rule: 'next_period' }), '2027-03-16', '2027-04-30');
    assert.deepEqual(p.map((x) => x.periodKey), ['2027-04']);
  });

  test('joining-date accrual credits on the anniversary', () => {
    const r = rule({ accrual_frequency: 'joining_date', accrual_amount: 5 });
    assert.deepEqual(duePeriods(r, '2020-06-10', '2027-06-09'), []);
    assert.deepEqual(duePeriods(r, '2020-06-10', '2027-06-10').map((x) => x.creditDate), ['2027-06-10']);
  });

  test('one-time grant happens once, in the year it starts', () => {
    const r = rule({ accrual_frequency: 'one_time', accrual_amount: 3, effective_from: '2027-01-01' });
    assert.deepEqual(duePeriods(r, '2020-01-01', '2027-02-01').map((x) => x.periodKey), ['ONCE']);
    assert.deepEqual(duePeriods(r, '2020-01-01', '2028-02-01'), []);
  });

  test('manual rules never credit automatically', () => {
    assert.deepEqual(duePeriods(rule({ accrual_frequency: 'manual', accrual_amount: 0 }), '2020-01-01', '2027-12-31'), []);
  });

  test('the effective window limits credits', () => {
    const r = rule({ effective_from: '2027-02-01', effective_to: '2027-03-31' });
    assert.deepEqual(duePeriods(r, '2020-01-01', '2027-12-31').map((x) => x.periodKey), ['2027-02', '2027-03']);
  });
});

describe('carry-forward limits', () => {
  test('carry limit: the excess lapses', () => {
    assert.deepEqual(computeCarry(20, { maximum_carry_forward: 15, maximum_balance: null }, 0), { carried: 15, lapsed: 5 });
  });
  test('total balance limit counts what next year already holds', () => {
    assert.deepEqual(computeCarry(20, { maximum_carry_forward: 15, maximum_balance: 45 }, 40), { carried: 5, lapsed: 15 });
  });
  test('no limits: everything carries', () => {
    assert.deepEqual(computeCarry(7.5, { maximum_carry_forward: null, maximum_balance: null }, 0), { carried: 7.5, lapsed: 0 });
  });
  test('a negative closing balance carries nothing', () => {
    assert.deepEqual(computeCarry(-3, { maximum_carry_forward: 15, maximum_balance: null }, 0), { carried: 0, lapsed: 0 });
  });
});

describe('expiry is first-in-first-out', () => {
  const credit = (id: number, d: number, expires_on: string | null, effective_date: string, expired_days = 0) =>
    ({ id, days: d, expires_on, effective_date, expired_days });

  test('only what is left of a credit expires', () => {
    assert.deepEqual(computeExpiries([credit(1, 10, '2027-03-31', '2027-01-01')], 4, '2027-04-01'), [{ id: 1, days: 6 }]);
  });
  test('a credit is still valid on its expiry date', () => {
    assert.deepEqual(computeExpiries([credit(1, 10, '2027-03-31', '2027-01-01')], 0, '2027-03-31'), []);
  });
  test('used days burn the oldest credit first', () => {
    const out = computeExpiries([credit(2, 5, '2027-06-30', '2027-02-01'), credit(1, 5, '2027-03-31', '2027-01-01')], 6, '2027-07-01');
    assert.deepEqual(out, [{ id: 2, days: 4 }]);
  });
  test('a credit that already expired is not expired again, and its expired days are not burned', () => {
    const out = computeExpiries([credit(1, 5, '2027-03-31', '2027-01-01', 3), credit(2, 5, '2027-06-30', '2027-02-01')], 3, '2027-07-01');
    assert.deepEqual(out, [{ id: 2, days: 4 }]);
  });
});

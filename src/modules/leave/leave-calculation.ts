import type { Tx } from '../../config/db';
import { addDays } from './leave-common';

export type HalfDaySession = 'first_half' | 'second_half';
export type DayType = 'working' | 'weekly_off' | 'holiday';

export interface LeaveDay {
  date: string;
  dayType: DayType;
  chargeableDays: number;
  holidayName: string | null;
}

export interface HolidayRow {
  day: string;
  name: string;
  holiday_type: string;
  is_optional: boolean;
  calendar_id: number;
  calendar_name: string;
}

/**
 * Chargeable days of a date range. Computed by the server: a client-supplied
 * total is never trusted. Optional holidays are working days unless the employee
 * takes leave on them, so they must not be in `holidays`.
 */
export function computeLeaveDays(input: {
  startDate: string;
  endDate: string;
  weeklyOffs: number[];
  holidays: Map<string, string>;
  includeNonWorkingDays: boolean;
  halfDaySession?: HalfDaySession | null;
}): { totalDays: number; days: LeaveDay[] } {
  const days: LeaveDay[] = [];
  for (let d = input.startDate; d <= input.endDate; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    const holidayName = input.holidays.get(d) ?? null;
    const dayType: DayType = holidayName ? 'holiday' : input.weeklyOffs.includes(dow) ? 'weekly_off' : 'working';
    const charged = dayType === 'working' || input.includeNonWorkingDays;
    days.push({ date: d, dayType, holidayName, chargeableDays: charged ? (input.halfDaySession ? 0.5 : 1) : 0 });
  }
  return { totalDays: days.reduce((sum, x) => sum + x.chargeableDays, 0), days };
}

/**
 * Holidays that apply to one employee in a date range. The calendar is resolved
 * per date, so a transfer or a new year takes effect exactly when it should:
 *   1. the calendar assigned to the employee on that date,
 *   2. else an active calendar for the employee's work location,
 *   3. else the organization's default calendar for that year.
 */
export async function loadEmployeeHolidays(tx: Tx, employeeId: number, from: string, to: string): Promise<HolidayRow[]> {
  const r = await tx.query<HolidayRow>(
    `WITH days AS (
       SELECT d::date AS day, extract(year FROM d)::int AS yr
         FROM generate_series($2::date, $3::date, interval '1 day') AS d
     ),
     resolved AS (
       SELECT days.day, COALESCE(
         (SELECT c.id FROM leave_calendar_assignments a
            JOIN leave_holiday_calendars c ON c.tenant_id = a.tenant_id AND c.id = a.calendar_id
           WHERE a.employee_id = $1 AND c.status = 'active' AND c.calendar_year = days.yr
             AND daterange(a.effective_from, a.effective_to, '[]') @> days.day
           LIMIT 1),
         (SELECT c.id FROM leave_holiday_calendars c
            JOIN employees e ON e.tenant_id = c.tenant_id AND e.id = $1
           WHERE c.status = 'active' AND c.calendar_year = days.yr AND c.location IS NOT NULL
             AND lower(c.location) = lower(e.work_location)
             AND daterange(c.effective_from, c.effective_to, '[]') @> days.day
           ORDER BY c.id LIMIT 1),
         (SELECT c.id FROM leave_holiday_calendars c
           WHERE c.status = 'active' AND c.calendar_year = days.yr AND c.is_default
             AND daterange(c.effective_from, c.effective_to, '[]') @> days.day
           LIMIT 1)
       ) AS calendar_id
       FROM days
     )
     SELECT r.day::text AS day, h.name, h.holiday_type, h.is_optional, c.id AS calendar_id, c.name AS calendar_name
       FROM resolved r
       JOIN leave_holidays h ON h.calendar_id = r.calendar_id AND h.holiday_date = r.day
       JOIN leave_holiday_calendars c ON c.tenant_id = h.tenant_id AND c.id = h.calendar_id
      ORDER BY r.day`,
    [employeeId, from, to],
  );
  return r.rows;
}

export async function loadWeeklyOffs(tx: Tx): Promise<number[]> {
  const r = await tx.query(`SELECT weekly_offs FROM tenants WHERE id = current_tenant_id()`);
  return r.rows[0]?.weekly_offs ?? [];
}

/** Days for one employee and range: weekly offs and the employee's own holiday calendar. */
export async function calculateLeaveDays(
  tx: Tx,
  employeeId: number,
  input: { startDate: string; endDate: string; includeNonWorkingDays: boolean; halfDaySession?: HalfDaySession | null },
) {
  const weeklyOffs = await loadWeeklyOffs(tx);
  const holidays = await loadEmployeeHolidays(tx, employeeId, input.startDate, input.endDate);
  return computeLeaveDays({
    ...input,
    weeklyOffs,
    holidays: new Map(holidays.filter((h) => !h.is_optional).map((h) => [h.day, h.name])),
  });
}

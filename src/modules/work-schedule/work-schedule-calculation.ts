/**
 * Pure schedule arithmetic: no database, so it is unit-testable on its own
 * (same approach as leave-calculation.ts).
 *
 * Times are wall-clock "HH:MM" in the tenant's timezone. A day whose end is
 * not after its start runs past midnight (a night shift).
 */

export const MINUTES_PER_DAY = 1440;

export const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export const DAY_NAMES: Record<number, string> = {
  1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday',
};
const DAY_SHORT: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

export interface ScheduleDayInput {
  dayOfWeek: number;
  isWorkingDay: boolean;
  startTime?: string | null;
  endTime?: string | null;
  minimumWorkingMinutes?: number | null;
}

/** "09:30" -> 570. Accepts "HH:MM" and "HH:MM:SS" (what PostgreSQL returns for `time`). */
export function toMinutes(t: string): number {
  const m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(t);
  if (!m) throw new Error(`Invalid time ${t}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** "09:00:00" -> "09:00". */
export const toHHMM = (t: string | null | undefined): string | null => (t ? t.slice(0, 5) : null);

export const isOvernight = (start: string, end: string): boolean => toMinutes(end) <= toMinutes(start);

/** Length of the working window in minutes; an overnight window wraps past midnight. 22:00-06:00 = 480. */
export function spanMinutes(start: string, end: string): number {
  const s = toMinutes(start);
  const e = toMinutes(end);
  return e > s ? e - s : MINUTES_PER_DAY - s + e;
}

/**
 * Field errors for a full week, keyed like the request body
 * (`days.2.endTime`) so the UI can show each one on its own control.
 */
export function validateWeek(days: ScheduleDayInput[], defaultMinimum: number): Record<string, string> {
  const errors: Record<string, string> = {};
  if (days.length !== 7) {
    errors.days = 'A schedule needs exactly 7 days, Monday to Sunday';
    return errors;
  }
  const seen = new Set<number>();
  days.forEach((d, i) => {
    const key = `days.${i}`;
    if (!ISO_DAYS.includes(d.dayOfWeek as (typeof ISO_DAYS)[number])) {
      errors[`${key}.dayOfWeek`] = 'Day must be 1 (Monday) to 7 (Sunday)';
      return;
    }
    if (seen.has(d.dayOfWeek)) errors[`${key}.dayOfWeek`] = `${DAY_NAMES[d.dayOfWeek]} appears more than once`;
    seen.add(d.dayOfWeek);

    const minimum = d.minimumWorkingMinutes ?? (d.isWorkingDay ? defaultMinimum : 0);
    if (!d.isWorkingDay) {
      if (d.startTime || d.endTime) errors[`${key}.startTime`] = 'A day off has no start or end time';
      if (minimum > 0) errors[`${key}.minimumWorkingMinutes`] = 'A day off has no minimum working time';
      return;
    }
    if (!d.startTime) errors[`${key}.startTime`] = 'Enter a start time';
    if (!d.endTime) errors[`${key}.endTime`] = 'Enter an end time';
    if (!d.startTime || !d.endTime) return;
    if (toMinutes(d.startTime) === toMinutes(d.endTime)) {
      errors[`${key}.endTime`] = 'End time must differ from start time';
      return;
    }
    const span = spanMinutes(d.startTime, d.endTime);
    if (minimum > span) {
      errors[`${key}.minimumWorkingMinutes`] =
        `Minimum working time (${formatMinutes(minimum)}) is longer than the shift (${formatMinutes(span)})`;
    }
  });
  return errors;
}

/** 570 -> "9h 30m", 480 -> "8h". */
export function formatMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** [1,2,3,4,5] -> "Mon-Fri"; [1,3,5] -> "Mon, Wed, Fri"; [] -> "No working days". */
export function summarizeWorkingDays(isoDays: number[]): string {
  const days = [...new Set(isoDays)].sort((a, b) => a - b);
  if (!days.length) return 'No working days';
  const runs: string[] = [];
  let start = days[0];
  let prev = days[0];
  for (let i = 1; i <= days.length; i++) {
    const d = days[i];
    if (d === prev + 1) { prev = d; continue; }
    runs.push(start === prev ? DAY_SHORT[start] : prev === start + 1
      ? `${DAY_SHORT[start]}, ${DAY_SHORT[prev]}` : `${DAY_SHORT[start]}-${DAY_SHORT[prev]}`);
    start = d;
    prev = d;
  }
  return runs.join(', ');
}

/** ISO weekday (1 = Mon .. 7 = Sun) -> tenants.weekly_offs convention (0 = Sun .. 6 = Sat). */
export const isoToWeeklyOff = (iso: number): number => iso % 7;

/**
 * Days marked working that the tenant's configured weekly offs include. A
 * warning, not an error: a schedule is a template, and some teams do work
 * the organization's weekend.
 */
export function weeklyOffWarnings(days: ScheduleDayInput[], weeklyOffs: number[]): string[] {
  const offs = new Set(weeklyOffs);
  return days
    .filter((d) => d.isWorkingDay && offs.has(isoToWeeklyOff(d.dayOfWeek)))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => `${DAY_NAMES[d.dayOfWeek]} is a weekly off for the organization but is marked as a working day`);
}

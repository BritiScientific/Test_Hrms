import type { Tx } from '../../config/db';

export type StartSession = 'full' | 'second_half';
export type EndSession = 'full' | 'first_half';

/**
 * Working days between two dates (inclusive), excluding the tenant's weekly
 * offs and holidays, with half-day sessions. Computed by the server — never
 * trust a client-supplied totalDays.
 */
export async function calculateLeaveDays(
  tx: Tx,
  startDate: string,
  endDate: string,
  startSession: StartSession,
  endSession: EndSession,
): Promise<{ totalDays: number; workingDates: string[] }> {
  const r = await tx.query(
    `SELECT d::date::text AS day
       FROM tenants t,
            generate_series($1::date, $2::date, interval '1 day') AS d
      WHERE t.id = current_tenant_id()
        AND NOT (extract(dow FROM d)::int = ANY (t.weekly_offs))
        AND NOT EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_date = d::date)
      ORDER BY d`,
    [startDate, endDate],
  );
  const workingDates: string[] = r.rows.map((x) => x.day);
  let total = workingDates.length;
  if (startSession === 'second_half' && workingDates[0] === startDate) total -= 0.5;
  if (endSession === 'first_half' && workingDates[workingDates.length - 1] === endDate) total -= 0.5;
  return { totalDays: Math.max(total, 0), workingDates };
}

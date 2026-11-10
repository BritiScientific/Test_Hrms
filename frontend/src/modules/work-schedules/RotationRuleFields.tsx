import { Field, Input, Select } from '@/components/ui/Field';
import type { RotationRule } from './types';

/** Form state for "Based on": every field is kept so switching the dropdown loses nothing. */
export interface RuleDraft {
  basedOn: 'after' | 'weekly' | 'monthly';
  afterDays: string;
  weekday: string;
  /** '1'..'31' or 'last' */
  monthDay: string;
}

export const DEFAULT_RULE: RuleDraft = { basedOn: 'after', afterDays: '7', weekday: '1', monthDay: '1' };

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => String(i + 1));

export const draftFromRule = (r: RotationRule): RuleDraft => ({
  ...DEFAULT_RULE,
  basedOn: r.basedOn,
  ...(r.basedOn === 'after' && { afterDays: String(r.afterDays) }),
  ...(r.basedOn === 'weekly' && { weekday: String(r.weekday) }),
  ...(r.basedOn === 'monthly' && { monthDay: String(r.monthDay) }),
});

/** The rule to send, or a message for the field that is wrong. */
export function ruleFromDraft(d: RuleDraft): { rule: RotationRule } | { error: string } {
  if (d.basedOn === 'after') {
    const n = Number(d.afterDays);
    if (!/^\d+$/.test(d.afterDays.trim()) || n < 1 || n > 365) return { error: 'Enter a whole number of days from 1 to 365' };
    return { rule: { basedOn: 'after', afterDays: n } };
  }
  if (d.basedOn === 'weekly') return { rule: { basedOn: 'weekly', weekday: Number(d.weekday) } };
  return { rule: { basedOn: 'monthly', monthDay: d.monthDay === 'last' ? 'last' : Number(d.monthDay) } };
}

/**
 * "Based on" and the one field that depends on it:
 * After = a number of days, Weekly = a weekday, Monthly = a day of the month or the last day.
 */
export function RotationRuleFields({ value, onChange, error, disabled }: {
  value: RuleDraft;
  onChange: (next: RuleDraft) => void;
  error?: string;
  disabled?: boolean;
}) {
  const set = (patch: Partial<RuleDraft>) => onChange({ ...value, ...patch });
  return (
    <>
      <Field label="Based on" required>
        {({ id, describedBy }) => (
          <Select id={id} aria-describedby={describedBy} value={value.basedOn} disabled={disabled}
            onChange={(e) => set({ basedOn: e.target.value as RuleDraft['basedOn'] })}>
            <option value="after">After</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
          </Select>
        )}
      </Field>

      {value.basedOn === 'after' && (
        <Field label="Rotate after day" required error={error} hint="Switches to the next entry every this many days, counted from the start date.">
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="number" inputMode="numeric" min={1} max={365} step={1} value={value.afterDays} disabled={disabled}
              aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => set({ afterDays: e.target.value })} />
          )}
        </Field>
      )}

      {value.basedOn === 'weekly' && (
        <Field label="Rotate on" required error={error} hint="Switches to the next entry every week on this day.">
          {({ id, describedBy, invalid }) => (
            <Select id={id} value={value.weekday} disabled={disabled} aria-describedby={describedBy} aria-invalid={invalid}
              onChange={(e) => set({ weekday: e.target.value })}>
              {WEEKDAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}
            </Select>
          )}
        </Field>
      )}

      {value.basedOn === 'monthly' && (
        <Field label="Rotate on day" required error={error} hint="Months that are shorter switch on their last day instead.">
          {({ id, describedBy, invalid }) => (
            <Select id={id} value={value.monthDay} disabled={disabled} aria-describedby={describedBy} aria-invalid={invalid}
              onChange={(e) => set({ monthDay: e.target.value })}>
              {MONTH_DAYS.map((d) => <option key={d} value={d}>{d}</option>)}
              <option value="last">Last day</option>
            </Select>
          )}
        </Field>
      )}
    </>
  );
}

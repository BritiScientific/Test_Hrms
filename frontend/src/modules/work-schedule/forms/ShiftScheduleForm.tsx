import { useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Copy, Moon } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import type { ResourceApi } from '../api';
import { ConfigFormDialog } from '../components/ConfigFormDialog';
import { useInvalidateWorkSchedule, useShiftOptions } from '../hooks';
import { DAY_NAMES, type ShiftSchedule } from '../types';
import { routeServerError } from './server-errors';

// ---------------------------------------------------------------- time math --
// Same rules as the server (work-schedule-calculation.ts): an end at or before
// the start runs past midnight.

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DURATION = /^(\d{1,2}):([0-5]\d)$/;

export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
export const isOvernight = (start: string, end: string) => toMinutes(end) <= toMinutes(start);
export function spanMinutes(start: string, end: string) {
  const s = toMinutes(start);
  const e = toMinutes(end);
  return e > s ? e - s : 1440 - s + e;
}
/** "8:30" -> 510; null when not h:mm or over 24 hours. */
export function parseDuration(v: string): number | null {
  const m = DURATION.exec(v.trim());
  if (!m) return null;
  const total = Number(m[1]) * 60 + Number(m[2]);
  return total <= 1440 ? total : null;
}
export const formatDuration = (minutes: number) => `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
export const hoursLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
};

// ------------------------------------------------------------------- schema --

const day = z.object({
  dayOfWeek: z.number(),
  isWorkingDay: z.boolean(),
  startTime: z.string(),
  endTime: z.string(),
  /** h:mm; blank = use the schedule default. */
  minimum: z.string(),
});

export const scheduleSchema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(150, 'At most 150 characters'),
  description: z.string().trim().max(2000, 'At most 2000 characters'),
  shiftId: z.string().min(1, 'Choose a shift'),
  defaultMinimum: z.string().refine((v) => parseDuration(v) !== null, 'Use h:mm, up to 24:00'),
  automaticCheckoutEnabled: z.boolean(),
  days: z.array(day).length(7),
}).superRefine((v, ctx) => {
  const fallback = parseDuration(v.defaultMinimum) ?? 0;
  v.days.forEach((d, i) => {
    if (!d.isWorkingDay) return;
    const at = (field: string, message: string) => ctx.addIssue({ code: 'custom', path: ['days', i, field], message });
    if (!TIME.test(d.startTime)) at('startTime', 'Enter a start time');
    if (!TIME.test(d.endTime)) at('endTime', 'Enter an end time');
    if (!TIME.test(d.startTime) || !TIME.test(d.endTime)) return;
    if (d.startTime === d.endTime) return at('endTime', 'End must differ from start');
    const minimum = d.minimum.trim() ? parseDuration(d.minimum) : fallback;
    if (minimum === null) return at('minimum', 'Use h:mm');
    const span = spanMinutes(d.startTime, d.endTime);
    if (minimum > span) at('minimum', `Longer than the shift (${hoursLabel(span)})`);
  });
});
type Values = z.infer<typeof scheduleSchema>;

const emptyWeek = (): Values['days'] => DAY_NAMES.map((_, i) => {
  const working = i < 5;
  return { dayOfWeek: i + 1, isWorkingDay: working, startTime: working ? '09:00' : '', endTime: working ? '18:00' : '', minimum: '' };
});

const toValues = (s: ShiftSchedule | null): Values => ({
  name: s?.name ?? '',
  description: s?.description ?? '',
  shiftId: s ? String(s.shiftId) : '',
  defaultMinimum: formatDuration(s?.defaultMinimumWorkingMinutes ?? 480),
  automaticCheckoutEnabled: s?.automaticCheckoutEnabled ?? false,
  days: s?.days.length === 7
    ? s.days.map((d) => ({
      dayOfWeek: d.dayOfWeek,
      isWorkingDay: d.isWorkingDay,
      startTime: d.startTime ?? '',
      endTime: d.endTime ?? '',
      minimum: d.isWorkingDay ? formatDuration(d.minimumWorkingMinutes) : '',
    }))
    : emptyWeek(),
});

/** Server field keys -> form paths. */
const SERVER_FIELD: Record<string, string> = { defaultMinimumWorkingMinutes: 'defaultMinimum' };
const toFormPath = (k: string) => SERVER_FIELD[k] ?? k.replace(/^days\.(\d+)\.minimumWorkingMinutes$/, 'days.$1.minimum');

/**
 * Shift schedule: name, shift, default minimum hours, automatic checkout and a
 * seven-row weekly editor. The overnight badge appears as soon as an end time
 * is not after its start time.
 */
export function ShiftScheduleForm({ record, client, onClose }: {
  record: ShiftSchedule | null;
  client: ResourceApi<ShiftSchedule>;
  onClose: () => void;
}) {
  const shifts = useShiftOptions();
  const invalidate = useInvalidateWorkSchedule();
  const { notify } = useToast();
  const [current, setCurrent] = useState<ShiftSchedule | null>(record);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const { register, control, handleSubmit, reset, setError, getValues, setValue, formState: { errors, isSubmitting } } =
    useForm<Values>({ resolver: zodResolver(scheduleSchema), defaultValues: toValues(record) });
  const days = useWatch({ control, name: 'days' });

  // The saved shift stays selectable (marked inactive) even if it has since been deactivated.
  const shiftChoices = [...(shifts.data ?? [])];
  if (current && !shiftChoices.some((s) => s.id === current.shiftId)) {
    shiftChoices.unshift({ id: current.shiftId, name: `${current.shiftName} (inactive)`, graceTimeMinutes: 0 });
  }

  const copyMondayToWeekdays = () => {
    const monday = getValues('days.0');
    for (let i = 1; i <= 4; i++) {
      setValue(`days.${i}`, { ...monday, dayOfWeek: i + 1 }, { shouldDirty: true, shouldValidate: false });
    }
  };

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    const defaultMinimum = parseDuration(v.defaultMinimum) ?? 0;
    const body = {
      name: v.name.trim(),
      description: v.description.trim() || null,
      shiftId: Number(v.shiftId),
      defaultMinimumWorkingMinutes: defaultMinimum,
      automaticCheckoutEnabled: v.automaticCheckoutEnabled,
      // A day off sends no times and no minimum, whatever the inputs still hold.
      days: v.days.map((d) => (d.isWorkingDay
        ? {
          dayOfWeek: d.dayOfWeek, isWorkingDay: true, startTime: d.startTime, endTime: d.endTime,
          minimumWorkingMinutes: d.minimum.trim() ? parseDuration(d.minimum) : defaultMinimum,
        }
        : { dayOfWeek: d.dayOfWeek, isWorkingDay: false, startTime: null, endTime: null, minimumWorkingMinutes: 0 })),
    };
    try {
      const saved = current
        ? await client.update(current.id, { ...body, updatedAt: current.updatedAt })
        : await client.create(body);
      await invalidate();
      notify({ tone: 'success', title: `Shift schedule ${current ? 'saved' : 'created'}` });
      if (saved.warnings?.length) {
        notify({ tone: 'info', title: 'Saved with a note', description: saved.warnings.join(' ') });
      }
      onClose();
    } catch (e) {
      const known = new Set(['name', 'description', 'shiftId', 'defaultMinimum', 'automaticCheckoutEnabled']);
      routeServerError(e, {
        isField: (k) => known.has(toFormPath(k)) || /^days\.\d+\./.test(toFormPath(k)),
        setFieldError: (k, message) => setError(toFormPath(k) as never, { message }),
        setFormError,
        setStale,
      });
    }
  });

  const reload = async () => {
    if (!current) return;
    try {
      const latest = await client.get(current.id);
      setCurrent(latest);
      reset(toValues(latest));
      setStale(false);
      setFormError(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not reload.');
    }
  };

  return (
    <ConfigFormDialog
      title={current ? `Edit ${current.name}` : 'New shift schedule'}
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      saving={isSubmitting}
      error={formError}
      stale={stale}
      onReload={reload}
      submitLabel={current ? 'Save changes' : 'Create shift schedule'}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" required error={errors.name?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} data-autofocus aria-describedby={describedBy} aria-invalid={invalid} maxLength={150} {...register('name')} />
          )}
        </Field>
        <Field label="Shift" required error={errors.shiftId?.message}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} {...register('shiftId')}>
              <option value="">{shifts.isPending ? 'Loading…' : shiftChoices.length ? 'Choose a shift…' : 'No active shifts yet'}</option>
              {shiftChoices.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Default minimum working time" required error={errors.defaultMinimum?.message}
          hint="h:mm. Used for any working day without its own minimum.">
          {({ id, describedBy, invalid }) => (
            <Input id={id} inputMode="numeric" placeholder="8:00" className="sm:w-32"
              aria-describedby={describedBy} aria-invalid={invalid} {...register('defaultMinimum')} />
          )}
        </Field>
        <div className="flex items-start gap-2.5 rounded-lg border border-line px-3 py-2.5 sm:mt-7 sm:self-start">
          <Checkbox id="ws-auto-checkout" className="mt-0.5" {...register('automaticCheckoutEnabled')} />
          <label htmlFor="ws-auto-checkout" className="text-sm">
            <span className="font-medium text-ink">Automatic checkout</span>
            <span className="block text-xs text-muted">Saved for later use. Nothing acts on it yet.</span>
          </label>
        </div>
      </div>

      <fieldset className="min-w-0">
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <legend className="text-sm font-medium text-slate-700">Weekly schedule</legend>
          <Button size="sm" variant="outline" icon={<Copy className="size-3.5" />} onClick={copyMondayToWeekdays}>
            Copy Monday to weekdays
          </Button>
        </div>
        <p className="mb-2 text-xs text-muted">Times are in your organization&apos;s timezone. An end time at or before the start runs past midnight.</p>
        <div className="divide-y divide-line rounded-lg border border-line">
          <div aria-hidden className="hidden gap-3 bg-slate-50/70 px-3 py-2 text-xs font-medium tracking-wide text-muted uppercase sm:grid sm:grid-cols-[9rem_1fr_1fr_1fr]">
            <span>Working day</span><span>Start</span><span>End</span><span>Minimum (h:mm)</span>
          </div>
          {DAY_NAMES.map((dayName, i) => {
            const d = days?.[i];
            const working = !!d?.isWorkingDay;
            const validTimes = working && d && TIME.test(d.startTime) && TIME.test(d.endTime) && d.startTime !== d.endTime;
            const overnight = validTimes && isOvernight(d.startTime, d.endTime);
            const dayErrors = errors.days?.[i];
            return (
              <div key={dayName} className="grid gap-3 p-3 sm:grid-cols-[9rem_1fr_1fr_1fr] sm:items-start">
                <div className="flex items-center gap-2.5 sm:pt-2">
                  <Checkbox id={`ws-day-${i}`} {...register(`days.${i}.isWorkingDay`)} />
                  <label htmlFor={`ws-day-${i}`} className="text-sm font-medium text-ink">{dayName}</label>
                </div>
                {working ? (
                  <>
                    <Field label="Start" error={dayErrors?.startTime?.message} className="sm:[&>label]:sr-only">
                      {({ id, describedBy, invalid }) => (
                        <Input id={id} type="time" aria-describedby={describedBy} aria-invalid={invalid}
                          aria-label={`${dayName} start`} {...register(`days.${i}.startTime`)} />
                      )}
                    </Field>
                    <Field label="End" error={dayErrors?.endTime?.message} className="sm:[&>label]:sr-only"
                      hint={validTimes ? (
                        <span className="inline-flex items-center gap-1.5">
                          {hoursLabel(spanMinutes(d.startTime, d.endTime))}
                          {overnight && <Badge tone="violet" icon={<Moon className="size-3" aria-hidden />}>Overnight</Badge>}
                        </span>
                      ) : undefined}>
                      {({ id, describedBy, invalid }) => (
                        <Input id={id} type="time" aria-describedby={describedBy} aria-invalid={invalid}
                          aria-label={`${dayName} end`} {...register(`days.${i}.endTime`)} />
                      )}
                    </Field>
                    <Field label="Minimum (h:mm)" error={dayErrors?.minimum?.message} className="sm:[&>label]:sr-only">
                      {({ id, describedBy, invalid }) => (
                        <Input id={id} inputMode="numeric" placeholder="Default" aria-describedby={describedBy} aria-invalid={invalid}
                          aria-label={`${dayName} minimum working time`} {...register(`days.${i}.minimum`)} />
                      )}
                    </Field>
                  </>
                ) : (
                  <p className="text-sm text-muted sm:col-span-3 sm:pt-2">Day off</p>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <Field label="Description" error={errors.description?.message}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} rows={2} maxLength={2000} aria-describedby={describedBy} aria-invalid={invalid} {...register('description')} />
        )}
      </Field>
    </ConfigFormDialog>
  );
}

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useQueryClient } from '@tanstack/react-query';
import { CalendarRange, Clock, RotateCcw } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Field, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ApiError } from '@/services/api-client';
import { organizationApi } from '@/services/organization-api';
import type { DateFormat, OrganizationSettings } from '@/types/api';
import { cn } from '@/utils/cn';
import { DAY_NAMES, MONTH_NAMES, formatDateParts } from '@/utils/format';
import { orgKeys, useOrgOptions } from '../hooks';

interface Values {
  timezone: string;
  locale: string;
  dateFormat: DateFormat;
  currency: string;
  financialYearStartMonth: number;
  weekStartDay: number;
  weeklyOffs: number[];
}

const toValues = (s: OrganizationSettings): Values => ({
  timezone: s.timezone,
  locale: s.locale,
  dateFormat: s.dateFormat,
  currency: s.currency,
  financialYearStartMonth: s.financialYearStartMonth,
  weekStartDay: s.weekStartDay,
  weeklyOffs: [...s.weeklyOffs].sort(),
});

function utcOffset(tz: string): string {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(new Date());
    return p.find((x) => x.type === 'timeZoneName')?.value.replace('GMT', 'UTC') ?? '';
  } catch {
    return '';
  }
}

/** Regional preferences: explicit IANA timezone, locale, date format, currency, financial year, working week. */
export function PreferencesForm({ settings, readOnly, submitLabel = 'Save changes', onSaved, secondaryAction, guardUnsaved = true }: {
  settings: OrganizationSettings;
  readOnly?: boolean;
  submitLabel?: string;
  onSaved?: () => void;
  secondaryAction?: ReactNode;
  guardUnsaved?: boolean;
}) {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const { notify } = useToast();
  const options = useOrgOptions();
  const initial = useMemo(() => toValues(settings), [settings]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const { control, register, handleSubmit, reset, watch, setError: setFieldError, formState: { isDirty, isSubmitting, errors } } =
    useForm<Values>({ defaultValues: initial });
  useEffect(() => reset(initial), [initial, reset]);
  const blocker = useUnsavedChanges(guardUnsaved && isDirty && !isSubmitting);

  const v = watch();
  const today = new Date();
  const fyStartYear = today.getMonth() + 1 >= v.financialYearStartMonth ? today.getFullYear() : today.getFullYear() - 1;
  const fyEndMonth = ((v.financialYearStartMonth + 10) % 12) + 1;
  const fyLabel = v.financialYearStartMonth === 1
    ? `January – December ${fyStartYear}`
    : `${MONTH_NAMES[v.financialYearStartMonth - 1]} ${fyStartYear} – ${MONTH_NAMES[fyEndMonth - 1]} ${fyStartYear + 1}`;

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setConflict(false);
    if (values.weeklyOffs.length >= 7) {
      setFieldError('weeklyOffs', { message: 'Keep at least one working day' });
      return;
    }
    try {
      const saved = await organizationApi.updateSettings({ ...values, version: settings.version });
      qc.setQueryData(orgKeys.settings, saved);
      reset(toValues(saved));
      await Promise.all([qc.invalidateQueries({ queryKey: orgKeys.onboarding }), refresh()]);
      notify({ tone: 'success', title: 'Preferences saved' });
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') setConflict(true);
      else if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        for (const [k, msg] of Object.entries(e.fieldErrors)) setFieldError(k as keyof Values, { message: msg });
      } else setError(e instanceof ApiError ? e.message : 'Could not save preferences.');
    }
  });

  const tzOptions = useMemo(
    () => (options.data?.timezones ?? []).map((tz) => ({ value: tz, label: tz.replace(/_/g, ' '), hint: utcOffset(tz) })),
    [options.data],
  );

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-5">
      {blocker}
      {conflict && (
        <InlineAlert tone="warning" title="Preferences were changed by someone else">
          <Button size="sm" variant="outline" className="mt-2" icon={<RotateCcw className="size-3.5" />}
            onClick={() => qc.invalidateQueries({ queryKey: orgKeys.settings })}>Reload latest</Button>
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}

      <Card>
        <CardHeader title="Regional settings" description="Used for dates, “today” and working-day calculations across the portal." />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Timezone" required error={errors.timezone?.message} hint="IANA timezone, e.g. Asia/Kolkata">
            {({ id, describedBy, invalid }) => (
              <Controller control={control} name="timezone" render={({ field }) => (
                <Combobox id={id} value={field.value} onChange={field.onChange} options={tzOptions} disabled={readOnly || options.isPending}
                  invalid={invalid} describedBy={describedBy} placeholder="Search timezones" />
              )} />
            )}
          </Field>
          <Field label="Language & region" required error={errors.locale?.message}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} disabled={readOnly} aria-describedby={describedBy} aria-invalid={invalid} {...register('locale')}>
                {(options.data?.locales ?? [{ code: v.locale, label: v.locale }]).map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Currency" required error={errors.currency?.message}>
            {({ id, describedBy, invalid }) => (
              <Controller control={control} name="currency" render={({ field }) => (
                <Combobox id={id} value={field.value} onChange={field.onChange} disabled={readOnly || options.isPending}
                  invalid={invalid} describedBy={describedBy} placeholder="Search currencies"
                  options={(options.data?.currencies ?? []).map((c) => ({ value: c.code, label: `${c.label}`, hint: c.code }))} />
              )} />
            )}
          </Field>
          <div className="flex items-end">
            <p className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-muted">
              <Clock className="size-4 shrink-0" aria-hidden />
              Local time now:{' '}
              <span className="font-medium text-ink tabular">
                {(() => {
                  try {
                    return new Intl.DateTimeFormat(v.locale, { timeZone: v.timezone, hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(today);
                  } catch {
                    return '—';
                  }
                })()}
              </span>
            </p>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Date format" />
        <CardBody>
          <fieldset>
            <legend className="sr-only">Date format</legend>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {(options.data?.dateFormats ?? ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'] as DateFormat[]).map((f) => (
                <label key={f} className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors',
                  v.dateFormat === f ? 'border-primary bg-primary-soft/50 ring-1 ring-primary' : 'border-line hover:bg-slate-50',
                  readOnly && 'cursor-not-allowed opacity-70',
                )}>
                  <input type="radio" value={f} disabled={readOnly} className="accent-primary" {...register('dateFormat')} />
                  <span className="min-w-0">
                    <span className="block font-medium tabular">{formatDateParts(today.getFullYear(), today.getMonth() + 1, today.getDate(), f)}</span>
                    <span className="block text-xs text-muted">{f}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Financial year & working week" />
        <CardBody className="grid gap-4 md:grid-cols-2">
          <Field label="Financial year starts in" required hint={`Current financial year: ${fyLabel}`}>
            {({ id, describedBy }) => (
              <Select id={id} disabled={readOnly} aria-describedby={describedBy} {...register('financialYearStartMonth', { valueAsNumber: true })}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Week starts on" required>
            {({ id }) => (
              <Select id={id} disabled={readOnly} {...register('weekStartDay', { valueAsNumber: true })}>
                {DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            )}
          </Field>
          <div className="md:col-span-2">
            <Controller control={control} name="weeklyOffs" render={({ field }) => (
              <fieldset>
                <legend className="mb-1.5 flex items-center gap-2 text-sm font-medium text-slate-700">
                  <CalendarRange className="size-4 text-slate-400" aria-hidden /> Weekly off days
                </legend>
                <p className="mb-2 text-xs text-muted">Days nobody is expected to work. Leave calculations skip these days.</p>
                <div className="flex flex-wrap gap-2">
                  {DAY_NAMES.map((d, i) => {
                    const on = field.value.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        disabled={readOnly}
                        aria-pressed={on}
                        onClick={() => field.onChange(on ? field.value.filter((x) => x !== i) : [...field.value, i].sort())}
                        className={cn(
                          'h-10 min-w-14 rounded-lg border px-3 text-sm font-medium transition-colors pointer-coarse:h-11',
                          on ? 'border-primary bg-primary text-white' : 'border-line bg-surface text-slate-700 hover:bg-slate-50',
                          'disabled:cursor-not-allowed disabled:opacity-60',
                        )}
                      >
                        <span aria-hidden>{d.slice(0, 3)}</span>
                        <span className="sr-only">{d}</span>
                      </button>
                    );
                  })}
                </div>
                {errors.weeklyOffs && <p role="alert" className="mt-1.5 text-xs font-medium text-danger">{errors.weeklyOffs.message}</p>}
              </fieldset>
            )} />
          </div>
        </CardBody>
      </Card>

      {!readOnly && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
          {secondaryAction}
          {guardUnsaved && <Button variant="outline" disabled={!isDirty || isSubmitting} onClick={() => reset(initial)}>Cancel</Button>}
          <Button type="submit" loading={isSubmitting} disabled={guardUnsaved && !isDirty}>{submitLabel}</Button>
        </div>
      )}
    </form>
  );
}

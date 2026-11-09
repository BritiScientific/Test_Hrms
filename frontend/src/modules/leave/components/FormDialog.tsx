import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/services/api-client';
import { useInvalidateLeave } from '../hooks';

export interface FormField {
  name: string;
  label: string;
  kind?: 'text' | 'number' | 'date' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  hint?: string;
  options?: { value: string | number; label: string }[];
  placeholder?: string;
  step?: string;
  /** Only shown, and only sent, when this returns true. */
  showIf?: (values: Record<string, any>) => boolean;
  disabled?: boolean;
  /** Takes the whole row in the two-column layout. */
  wide?: boolean;
}

/**
 * One form for every configuration record, so that required checks, server
 * field errors and refreshing work the same everywhere. The API validates
 * everything again; the required check here only saves a round trip.
 */
export function FormDialog({ open, title, description, fields, initial, submitLabel = 'Save', onClose, onSubmit, footerNote }: {
  open: boolean;
  title: string;
  description?: string;
  fields: FormField[];
  initial?: Record<string, unknown>;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (values: Record<string, any>) => Promise<unknown>;
  footerNote?: string;
}) {
  const invalidate = useInvalidateLeave();
  const [formError, setFormError] = useState<string | null>(null);
  const defaults = () => Object.fromEntries(fields.map((f) => [
    f.name,
    initial?.[f.name] ?? (f.kind === 'checkbox' ? false : ''),
  ]));
  const { register, handleSubmit, reset, watch, setError, formState: { errors, isSubmitting } } = useForm<Record<string, any>>({ defaultValues: defaults() });
  const values = watch();

  // Only when opened: a background refetch re-renders the parent, and must not wipe what was typed.
  useEffect(() => {
    if (open) { reset(defaults()); setFormError(null); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = fields.filter((f) => !f.showIf || f.showIf(values));

  const submit = handleSubmit(async (raw) => {
    setFormError(null);
    let missing = false;
    for (const f of visible) {
      if (f.required && f.kind !== 'checkbox' && (raw[f.name] === '' || raw[f.name] === null || raw[f.name] === undefined)) {
        setError(f.name, { message: `Enter ${f.label.toLowerCase()}` });
        missing = true;
      }
    }
    if (missing) return;
    const body: Record<string, unknown> = {};
    for (const f of visible) {
      if (f.disabled) continue;
      body[f.name] = raw[f.name] === '' ? null : raw[f.name];
    }
    try {
      await onSubmit(body);
      await invalidate();
      onClose();
    } catch (e) {
      if (e instanceof ApiError) {
        let placed = false;
        for (const [k, msg] of Object.entries(e.fieldErrors)) {
          if (visible.some((f) => f.name === k)) { setError(k, { message: msg }); placed = true; }
        }
        if (!placed) setFormError(e.message);
      } else {
        setFormError('Could not save.');
      }
    }
  });

  return (
    <Dialog open={open} onClose={onClose} title={title} description={description} size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" form="leave-config-form" loading={isSubmitting}>{submitLabel}</Button>
        </>
      }>
      <form id="leave-config-form" noValidate onSubmit={submit} className="space-y-4">
        {formError && <InlineAlert>{formError}</InlineAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          {visible.map((f, i) => {
            const error = errors[f.name]?.message as string | undefined;
            if (f.kind === 'checkbox') {
              return (
                <label key={f.name} className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 text-sm sm:col-span-2">
                  <Checkbox className="mt-0.5" disabled={f.disabled} {...register(f.name)} />
                  <span>
                    <span className="font-medium">{f.label}</span>
                    {f.hint && <span className="block text-xs text-muted">{f.hint}</span>}
                  </span>
                </label>
              );
            }
            return (
              <Field key={f.name} label={f.label} required={f.required} hint={f.hint} error={error} className={f.wide || f.kind === 'textarea' ? 'sm:col-span-2' : undefined}>
                {({ id, invalid, describedBy }) => {
                  const common = { id, 'aria-invalid': invalid, 'aria-describedby': describedBy, disabled: f.disabled, ...(i === 0 ? { 'data-autofocus': true } : {}) };
                  if (f.kind === 'select') {
                    return (
                      <Select {...common} {...register(f.name)}>
                        {!f.required && <option value="">None</option>}
                        {f.required && !f.options?.some((o) => o.value === '') && <option value="">Choose…</option>}
                        {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </Select>
                    );
                  }
                  if (f.kind === 'textarea') return <Textarea {...common} placeholder={f.placeholder} {...register(f.name)} />;
                  return (
                    <Input {...common} type={f.kind ?? 'text'} step={f.step ?? (f.kind === 'number' ? 'any' : undefined)} min={f.kind === 'number' ? 0 : undefined}
                      placeholder={f.placeholder} {...register(f.name)} />
                  );
                }}
              </Field>
            );
          })}
        </div>
        {footerNote && <p className="text-xs text-muted">{footerNote}</p>}
      </form>
    </Dialog>
  );
}

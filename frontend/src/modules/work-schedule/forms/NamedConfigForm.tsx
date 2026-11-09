import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { InlineAlert } from '@/components/feedback/States';
import type { ResourceApi } from '../api';
import { ConfigFormDialog } from '../components/ConfigFormDialog';
import { useInvalidateWorkSchedule } from '../hooks';
import { BASE_CATEGORY_OPTIONS, type BaseCategory, type BaseRecord, type EmployeeType, type Shift } from '../types';
import { routeServerError } from './server-errors';

export type NamedKind = 'shift' | 'work-type' | 'employee-type';

const LABEL: Record<NamedKind, string> = { shift: 'Shift', 'work-type': 'Work type', 'employee-type': 'Employee type' };

const schema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(150, 'At most 150 characters'),
  description: z.string().trim().max(2000, 'At most 2000 characters'),
  graceTimeMinutes: z.string().trim(),
  // Optional: a disabled (locked) select is left out of the submitted values.
  baseCategory: z.string().optional(),
});
type Values = z.infer<typeof schema>;

const toValues = (r: BaseRecord | null): Values => ({
  name: r?.name ?? '',
  description: r?.description ?? '',
  graceTimeMinutes: String((r as Shift | null)?.graceTimeMinutes ?? 0),
  baseCategory: (r as EmployeeType | null)?.baseCategory ?? '',
});

/**
 * Modal form for the three plain masters: shift (+ grace time), work type,
 * and employee type (+ required base category). Status is not edited here:
 * activation goes through the row action and its confirm dialog.
 */
export function NamedConfigForm<T extends BaseRecord>({ kind, record, client, onClose }: {
  kind: NamedKind;
  record: T | null;
  client: ResourceApi<T>;
  onClose: () => void;
}) {
  const label = LABEL[kind];
  const invalidate = useInvalidateWorkSchedule();
  const { notify } = useToast();
  const [current, setCurrent] = useState<T | null>(record);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // Employees holding this type: its base category is locked (the server refuses a change too).
  const inUse = kind === 'employee-type' && current ? (current as unknown as EmployeeType).employeeCount : 0;

  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema.superRefine((v, ctx) => {
      if (kind === 'shift') {
        const n = Number(v.graceTimeMinutes);
        if (v.graceTimeMinutes === '' || !Number.isInteger(n) || n < 0 || n > 240) {
          ctx.addIssue({ code: 'custom', path: ['graceTimeMinutes'], message: 'Whole minutes from 0 to 240' });
        }
      }
      if (kind === 'employee-type' && !inUse && !BASE_CATEGORY_OPTIONS.some((o) => o.value === v.baseCategory)) {
        ctx.addIssue({ code: 'custom', path: ['baseCategory'], message: 'Choose a base category' });
      }
    })),
    defaultValues: toValues(record),
  });

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    const body: Record<string, unknown> = { name: v.name.trim(), description: v.description.trim() || null };
    if (kind === 'shift') body.graceTimeMinutes = Number(v.graceTimeMinutes);
    if (kind === 'employee-type' && !inUse) body.baseCategory = v.baseCategory as BaseCategory;
    try {
      if (current) await client.update(current.id, { ...body, updatedAt: current.updatedAt });
      else await client.create(body);
      await invalidate();
      notify({ tone: 'success', title: `${label} ${current ? 'saved' : 'created'}` });
      onClose();
    } catch (e) {
      routeServerError(e, {
        isField: (k) => k in toValues(null),
        setFieldError: (k, message) => setError(k as keyof Values, { message }),
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
      title={current ? `Edit ${current.name}` : `New ${label.toLowerCase()}`}
      onClose={onClose}
      onSubmit={submit}
      saving={isSubmitting}
      error={formError}
      stale={stale}
      onReload={reload}
      submitLabel={current ? 'Save changes' : `Create ${label.toLowerCase()}`}
    >
      {current && !current.isActive && (
        <InlineAlert tone="info">This {label.toLowerCase()} is inactive. Saving does not change its status.</InlineAlert>
      )}
      <Field label="Name" required error={errors.name?.message}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} data-autofocus aria-describedby={describedBy} aria-invalid={invalid} maxLength={150} {...register('name')} />
        )}
      </Field>

      {kind === 'shift' && (
        <Field label="Grace time (minutes)" required error={errors.graceTimeMinutes?.message}
          hint="How late someone can arrive before it counts as late. 0 to 240.">
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="number" inputMode="numeric" min={0} max={240} step={1} className="sm:w-40"
              aria-describedby={describedBy} aria-invalid={invalid} {...register('graceTimeMinutes')} />
          )}
        </Field>
      )}

      {kind === 'employee-type' && (
        <Field label="Base category" required error={errors.baseCategory?.message}
          hint={inUse > 0
            ? `Locked: ${inUse} employee${inUse === 1 ? '' : 's'} hold this type. Create a new type to use another category.`
            : 'Reports, the organization chart and workflow conditions group employees by this category.'}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} disabled={inUse > 0} aria-describedby={describedBy} aria-invalid={invalid} {...register('baseCategory')}>
              <option value="">Choose…</option>
              {BASE_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          )}
        </Field>
      )}

      <Field label="Description" error={errors.description?.message}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} rows={3} maxLength={2000} aria-describedby={describedBy} aria-invalid={invalid} {...register('description')} />
        )}
      </Field>
    </ConfigFormDialog>
  );
}

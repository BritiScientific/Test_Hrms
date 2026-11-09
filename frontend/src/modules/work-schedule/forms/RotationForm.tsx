import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import type { ResourceApi } from '../api';
import { ConfigFormDialog } from '../components/ConfigFormDialog';
import { useInvalidateWorkSchedule, useShiftOptions, useWorkTypeOptions } from '../hooks';
import type { Rotation } from '../types';
import { routeServerError } from './server-errors';

const MAX_ITEMS = 20;

const schema = z.object({
  name: z.string().trim().min(2, 'Enter at least 2 characters').max(150, 'At most 150 characters'),
  description: z.string().trim().max(2000, 'At most 2000 characters'),
  rotationInterval: z.string().trim().refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 365, 'Whole number from 1 to 365'),
  rotationUnit: z.enum(['days', 'weeks']),
});
type Values = z.infer<typeof schema>;

const toValues = (r: Rotation | null): Values => ({
  name: r?.name ?? '',
  description: r?.description ?? '',
  rotationInterval: String(r?.rotationInterval ?? 1),
  rotationUnit: r?.rotationUnit ?? 'days',
});

interface Entry { id: number; name: string; isActive: boolean }

/**
 * Rotating shift / rotating work type. The picker offers active entries only
 * and hides ones already chosen; an entry that has since been deactivated
 * still shows (marked Inactive) so the user can see and remove it.
 */
export function RotationForm({ of, record, client, onClose }: {
  of: 'shift' | 'work-type';
  record: Rotation | null;
  client: ResourceApi<Rotation>;
  onClose: () => void;
}) {
  const label = of === 'shift' ? 'Rotating shift' : 'Rotating work type';
  const entryLabel = of === 'shift' ? 'shift' : 'work type';
  const shiftOptions = useShiftOptions(of === 'shift');
  const workTypeOptions = useWorkTypeOptions(of === 'work-type');
  const options = (of === 'shift' ? shiftOptions.data : workTypeOptions.data) ?? [];

  const invalidate = useInvalidateWorkSchedule();
  const { notify } = useToast();
  const [current, setCurrent] = useState<Rotation | null>(record);
  const [entries, setEntries] = useState<Entry[]>(record?.items.map(({ id, name, isActive }) => ({ id, name, isActive })) ?? []);
  const [pick, setPick] = useState('');
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  const { register, handleSubmit, reset, setError, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: toValues(record),
  });

  const available = useMemo(() => options.filter((o) => !entries.some((e) => e.id === o.id)), [options, entries]);

  const add = () => {
    const o = options.find((x) => String(x.id) === pick);
    if (!o) return;
    setEntries((list) => [...list, { id: o.id, name: o.name, isActive: true }]);
    setPick('');
    setItemsError(null);
  };
  const move = (i: number, step: -1 | 1) => setEntries((list) => {
    const next = [...list];
    [next[i], next[i + step]] = [next[i + step], next[i]];
    return next;
  });
  const remove = (i: number) => setEntries((list) => list.filter((_, j) => j !== i));

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    if (entries.length < 2) return setItemsError(`Add at least 2 ${entryLabel}s`);
    const inactive = entries.filter((e) => !e.isActive);
    if (inactive.length) return setItemsError(`Remove deactivated ${entryLabel}s: ${inactive.map((e) => e.name).join(', ')}`);
    setItemsError(null);
    const body = {
      name: v.name.trim(),
      description: v.description.trim() || null,
      rotationInterval: Number(v.rotationInterval),
      rotationUnit: v.rotationUnit,
      items: entries.map((e) => e.id),
    };
    try {
      if (current) await client.update(current.id, { ...body, updatedAt: current.updatedAt });
      else await client.create(body);
      await invalidate();
      notify({ tone: 'success', title: `${label} ${current ? 'saved' : 'created'}` });
      onClose();
    } catch (e) {
      routeServerError(e, {
        isField: (k) => k in toValues(null) || k === 'items',
        setFieldError: (k, message) => (k === 'items' ? setItemsError(message) : setError(k as keyof Values, { message })),
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
      setEntries(latest.items.map(({ id, name, isActive }) => ({ id, name, isActive })));
      setStale(false);
      setFormError(null);
      setItemsError(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not reload.');
    }
  };

  return (
    <ConfigFormDialog
      title={current ? `Edit ${current.name}` : `New ${label.toLowerCase()}`}
      size="lg"
      onClose={onClose}
      onSubmit={submit}
      saving={isSubmitting}
      error={formError}
      stale={stale}
      onReload={reload}
      submitLabel={current ? 'Save changes' : `Create ${label.toLowerCase()}`}
    >
      <Field label="Pattern name" required error={errors.name?.message}>
        {({ id, describedBy, invalid }) => (
          <Input id={id} data-autofocus aria-describedby={describedBy} aria-invalid={invalid} maxLength={150} {...register('name')} />
        )}
      </Field>

      <fieldset className="min-w-0">
        <legend className="mb-1.5 text-sm font-medium text-slate-700">
          Sequence<span className="ml-0.5 text-danger" aria-hidden>*</span>
          <span className="sr-only"> (required)</span>
        </legend>
        <p className="mb-2 text-xs text-muted">At least 2 different {entryLabel}s, in the order they repeat.</p>

        {entries.length > 0 && (
          <ol className="mb-3 divide-y divide-line rounded-lg border border-line" aria-label={`${label} sequence`}>
            {entries.map((e, i) => (
              <li key={e.id} className="flex items-center gap-2 px-3 py-2">
                <span className="w-6 shrink-0 text-right text-xs text-muted tabular" aria-hidden>{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {e.name}
                  {!e.isActive && <Badge tone="warning" className="ml-2">Inactive</Badge>}
                </span>
                <Button size="icon" variant="ghost" aria-label={`Move ${e.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp className="size-4" aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Move ${e.name} down`} disabled={i === entries.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown className="size-4" aria-hidden />
                </Button>
                <Button size="icon" variant="ghost" aria-label={`Remove ${e.name}`} onClick={() => remove(i)}>
                  <X className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ol>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={`Add a ${entryLabel}`} className="flex-1" error={itemsError ?? undefined}
            hint={!available.length && options.length ? `Every active ${entryLabel} is already in the sequence.` : undefined}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} value={pick} onChange={(ev) => setPick(ev.target.value)} aria-describedby={describedBy}
                aria-invalid={invalid} disabled={!available.length || entries.length >= MAX_ITEMS}>
                <option value="">{options.length ? `Choose a ${entryLabel}…` : `No active ${entryLabel}s yet`}</option>
                {available.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </Select>
            )}
          </Field>
          <Button variant="outline" icon={<Plus className="size-4" />} onClick={add} disabled={!pick}>Add</Button>
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Rotate every" required error={errors.rotationInterval?.message}>
          {({ id, describedBy, invalid }) => (
            <Input id={id} type="number" inputMode="numeric" min={1} max={365} step={1}
              aria-describedby={describedBy} aria-invalid={invalid} {...register('rotationInterval')} />
          )}
        </Field>
        <Field label="Unit" required error={errors.rotationUnit?.message}>
          {({ id, describedBy, invalid }) => (
            <Select id={id} aria-describedby={describedBy} aria-invalid={invalid} {...register('rotationUnit')}>
              <option value="days">Days</option>
              <option value="weeks">Weeks</option>
            </Select>
          )}
        </Field>
      </div>

      <Field label="Description" error={errors.description?.message}>
        {({ id, describedBy, invalid }) => (
          <Textarea id={id} rows={3} maxLength={2000} aria-describedby={describedBy} aria-invalid={invalid} {...register('description')} />
        )}
      </Field>
    </ConfigFormDialog>
  );
}

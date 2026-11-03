import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { ApiError } from '@/services/api-client';

export const roleSchema = z.object({
  name: z.string().trim().min(2, 'Use at least 2 characters').max(100, 'Up to 100 characters'),
  description: z.string().trim().max(1000, 'Up to 1000 characters'),
});
export type RoleValues = z.infer<typeof roleSchema>;

/** Create/edit/duplicate dialog for a role's name and description. */
export function RoleFormDialog({ open, onClose, title, description, initial, submitLabel, onSubmit }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  initial: RoleValues;
  submitLabel: string;
  onSubmit: (v: { name: string; description: string | null }) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError: setFieldError, formState: { errors, isSubmitting } } =
    useForm<RoleValues>({ resolver: zodResolver(roleSchema), defaultValues: initial });

  useEffect(() => {
    if (open) {
      reset(initial);
      setError(null);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      await onSubmit({ name: v.name.trim(), description: v.description.trim() || null });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setFieldError('name', { message: e.message });
      else setError(e instanceof ApiError ? e.message : 'Could not save the role.');
    }
  });

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" form="role-form" loading={isSubmitting}>{submitLabel}</Button>
        </>
      }
    >
      <form id="role-form" noValidate onSubmit={submit} className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label="Role name" error={errors.name?.message} required hint="Must be unique in your organization">
          {({ id, describedBy, invalid }) => (
            <Input id={id} data-autofocus aria-describedby={describedBy} aria-invalid={invalid} {...register('name')} />
          )}
        </Field>
        <Field label="Description" error={errors.description?.message} hint="Explain who this role is for and what it allows">
          {({ id, describedBy, invalid }) => (
            <Textarea id={id} rows={3} aria-describedby={describedBy} aria-invalid={invalid} {...register('description')} />
          )}
        </Field>
      </form>
    </Dialog>
  );
}

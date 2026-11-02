import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate } from 'react-router';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { rbacApi } from '@/services/rbac-api';
import { roleSchema } from './RoleFormDialog';
import { useInvalidateRbac, useRoles } from './hooks';

const schema = roleSchema.extend({ cloneFrom: z.string() });
type Values = z.infer<typeof schema>;

/** Create a custom role, optionally starting from an existing role's permissions. */
export default function RoleCreatePage() {
  usePageTitle('Create role');
  const navigate = useNavigate();
  const { me } = useAuth();
  const roles = useRoles();
  const invalidate = useInvalidateRbac();
  const { notify } = useToast();
  const [error, setError] = useState<string | null>(null);
  const held = new Set(me?.permissions ?? []);

  const { register, handleSubmit, setError: setFieldError, watch, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', description: '', cloneFrom: '' },
  });
  const cloneFrom = watch('cloneFrom');
  const source = roles.data?.find((r) => String(r.id) === cloneFrom);

  const onSubmit = handleSubmit(async (v) => {
    setError(null);
    const body = { name: v.name.trim(), description: v.description.trim() || null };
    try {
      const created = v.cloneFrom ? await rbacApi.cloneRole(Number(v.cloneFrom), body) : await rbacApi.createRole(body);
      await invalidate();
      notify({ tone: 'success', title: `Role “${created.name}” created` });
      navigate(v.cloneFrom ? `/settings/access/roles/${created.id}` : `/settings/access/roles/${created.id}/permissions`, { replace: true });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') setFieldError('name', { message: e.message });
      else setError(e instanceof ApiError ? e.message : 'Could not create the role.');
    }
  });

  return (
    <div className="max-w-3xl">
      <PageHeader title="Create role" description="Give the role a clear name. You will choose its permissions next." />
      <Card>
        <CardBody>
          <form noValidate onSubmit={onSubmit} className="space-y-5">
            {error && <InlineAlert>{error}</InlineAlert>}
            <Field label="Role name" required error={errors.name?.message} hint="For example: Payroll Officer, Department Head">
              {({ id, describedBy, invalid }) => <Input id={id} autoFocus aria-describedby={describedBy} aria-invalid={invalid} {...register('name')} />}
            </Field>
            <Field label="Description" error={errors.description?.message} hint="Explain the responsibility this role is intended for">
              {({ id, describedBy, invalid }) => <Textarea id={id} rows={3} aria-describedby={describedBy} aria-invalid={invalid} {...register('description')} />}
            </Field>
            <Field label="Start from" hint="Copy the permissions of an existing role (optional)">
              {({ id, describedBy }) => (
                <Select id={id} aria-describedby={describedBy} {...register('cloneFrom')} disabled={roles.isPending}>
                  <option value="">Blank role — no permissions</option>
                  {roles.data?.map((r) => {
                    const blocked = r.permissions.some((c) => !held.has(c));
                    return (
                      <option key={r.id} value={r.id} disabled={blocked}>
                        {r.name} ({r.permission_count} permissions){blocked ? ' — includes permissions you don’t hold' : ''}
                      </option>
                    );
                  })}
                </Select>
              )}
            </Field>
            {source && (
              <InlineAlert tone="info">
                The new role starts with the {source.permission_count} permissions of “{source.name}”. You can adjust them afterwards.
                It is always a custom role, even when copied from a system role.
              </InlineAlert>
            )}
            <div className="flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:justify-end">
              <ButtonLink to="/settings/access/roles" variant="outline">Cancel</ButtonLink>
              <Button type="submit" loading={isSubmitting}>{source ? 'Create role' : 'Create and choose permissions'}</Button>
            </div>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ChevronDown, UserPlus } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { Combobox } from '@/components/ui/Combobox';
import { Dialog } from '@/components/ui/Dialog';
import { ApiError } from '@/services/api-client';
import { employeesApi } from '@/services/employees-api';
import { rbacApi } from '@/services/rbac-api';
import type { QuickAddResult } from '@/types/api';
import { cn } from '@/utils/cn';
import { InviteLink } from './InviteLink';
import { EMPLOYMENT_TYPES, useDepartments, useInvalidateEmployees, useManagerOptions } from './shared';

const schema = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(200),
  workEmail: z.string().trim().min(1, 'Enter the work email').email('Enter a valid email address'),
  dateOfJoining: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the joining date'),
  employeeCode: z.string().trim().max(50).regex(/^[A-Za-z0-9_-]*$/, 'Letters, digits, - and _ only'),
  jobTitle: z.string().trim().max(150),
  departmentId: z.string(),
  managerId: z.string(),
  employmentType: z.string(),
  roleId: z.string(),
  sendInvite: z.boolean(),
});
type Values = z.infer<typeof schema>;

const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Quick add (approach A): three required fields, everything else optional.
 * The server creates login, membership, record, manager line, role and
 * activation link in ONE transaction — all or nothing.
 */
export function QuickAddDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { can } = useAuth();
  const canAssign = can('roles.assign');
  const invalidate = useInvalidateEmployees();
  const departments = useDepartments(open);
  const managers = useManagerOptions(open);
  const roles = useQuery({ queryKey: ['roles'], queryFn: rbacApi.roles, enabled: open && canAssign });
  const nextCode = useQuery({ queryKey: ['employees', 'next-code'], queryFn: employeesApi.nextCode, enabled: open, staleTime: 0 });
  const defaultRole = useMemo(() => roles.data?.find((r) => r.name === 'Employee' && r.is_active)?.id, [roles.data]);
  const [more, setMore] = useState(false);
  const [result, setResult] = useState<QuickAddResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const defaults: Values = {
    fullName: '', workEmail: '', dateOfJoining: localToday(), employeeCode: '', jobTitle: '',
    departmentId: '', managerId: '', employmentType: 'full_time', roleId: '', sendInvite: true,
  };
  const { register, control, handleSubmit, reset, setValue, setError: setFieldError, getValues, formState: { errors, isSubmitting } } =
    useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults });

  useEffect(() => {
    if (open) { reset(defaults); setResult(null); setError(null); setMore(false); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (defaultRole && !getValues('roleId')) setValue('roleId', String(defaultRole));
  }, [defaultRole, getValues, setValue]);

  const submit = handleSubmit(async (v) => {
    setError(null);
    try {
      const r = await employeesApi.quickAdd({
        fullName: v.fullName.trim(),
        workEmail: v.workEmail.trim(),
        dateOfJoining: v.dateOfJoining,
        employeeCode: v.employeeCode.trim() || null,
        jobTitle: v.jobTitle.trim() || null,
        departmentId: v.departmentId ? Number(v.departmentId) : null,
        managerId: v.managerId ? Number(v.managerId) : null,
        ...(v.employmentType !== 'full_time' ? { employmentType: v.employmentType } : {}),
        ...(canAssign && v.roleId ? { roleIds: [Number(v.roleId)] } : {}),
        sendInvite: v.sendInvite,
      });
      await invalidate();
      setResult(r);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'EMPLOYEE_EXISTS') return setFieldError('workEmail', { message: e.message });
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        for (const [k, msg] of Object.entries(e.fieldErrors)) {
          if (k in defaults) setFieldError(k as keyof Values, { message: msg });
          else setError(msg);
        }
        if (Object.keys(e.fieldErrors).some((k) => ['departmentId', 'managerId', 'employeeCode', 'jobTitle'].includes(k))) setMore(true);
        return;
      }
      setError(e instanceof ApiError
        ? e.code === 'PRIVILEGE_ESCALATION' ? 'You can only assign roles whose permissions you hold yourself.' : e.message
        : 'Could not add the employee.');
    }
  });

  if (result) {
    const e = result.employee;
    return (
      <Dialog open={open} onClose={onClose} title={`${e.fullName} added`} size="lg"
        description={`Employee ${e.employeeCode}${e.jobTitle ? ` · ${e.jobTitle}` : ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => { reset(defaults); if (defaultRole) setValue('roleId', String(defaultRole)); setResult(null); nextCode.refetch(); }}
              icon={<UserPlus className="size-4" />}>Add another</Button>
            <ButtonLink to={`/employees/${e.id}`} onClick={onClose}>Open profile</ButtonLink>
          </>
        }>
        <div className="space-y-4 text-sm">
          {result.invitation && <InviteLink url={result.invitation.url} expiresAt={result.invitation.expiresAt} name={e.fullName} />}
          {result.linkedExistingMember && (
            <InlineAlert tone="info">{e.fullName} already had access to this organization. Their account is now linked to this employee record — no activation needed.</InlineAlert>
          )}
          {!result.invitation && !result.linkedExistingMember && (
            <InlineAlert tone="info">No activation link was created. Issue one from the employee’s profile when they should get access.</InlineAlert>
          )}
          <p className="text-muted">
            Next: {e.fullName.split(' ')[0]} activates their account and fills their personal, address and emergency-contact
            details from <strong>My profile</strong>. You can fill or correct anything from their <Link to={`/employees/${e.id}`} onClick={onClose} className="font-medium text-primary hover:underline">profile</Link>.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={onClose} title="Quick add employee" size="lg"
      description="Only three details are needed now. The employee completes the rest after activating."
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>Cancel</Button>
          <Button type="submit" form="quick-add" loading={isSubmitting} icon={<UserPlus className="size-4" />}>Add employee</Button>
        </>
      }>
      <form id="quick-add" noValidate onSubmit={submit} className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.fullName?.message} className="sm:col-span-2">
            {({ id, describedBy, invalid }) => <Input id={id} data-autofocus autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid} {...register('fullName')} />}
          </Field>
          <Field label="Work email" required error={errors.workEmail?.message} hint="They sign in with this">
            {({ id, describedBy, invalid }) => <Input id={id} type="email" autoComplete="off" aria-describedby={describedBy} aria-invalid={invalid} {...register('workEmail')} />}
          </Field>
          <Field label="Date of joining" required error={errors.dateOfJoining?.message}>
            {({ id, describedBy, invalid }) => <Input id={id} type="date" aria-describedby={describedBy} aria-invalid={invalid} {...register('dateOfJoining')} />}
          </Field>
        </div>

        <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more}
          className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline">
          <ChevronDown className={cn('size-4 transition-transform', more && 'rotate-180')} aria-hidden />
          {more ? 'Fewer details' : 'More details (optional)'}
        </button>

        {more && (
          <div className="grid gap-4 rounded-xl border border-line bg-slate-50/60 p-4 sm:grid-cols-2">
            <Field label="Employee code" error={errors.employeeCode?.message} hint={nextCode.data ? `Leave blank to use ${nextCode.data.employeeCode}` : undefined}>
              {({ id, describedBy, invalid }) => <Input id={id} placeholder={nextCode.data?.employeeCode} aria-describedby={describedBy} aria-invalid={invalid} {...register('employeeCode')} />}
            </Field>
            <Field label="Job title" error={errors.jobTitle?.message}>
              {({ id, describedBy, invalid }) => <Input id={id} aria-describedby={describedBy} aria-invalid={invalid} {...register('jobTitle')} />}
            </Field>
            <Field label="Department" error={errors.departmentId?.message}>
              {({ id, invalid }) => (
                <Select id={id} aria-invalid={invalid} {...register('departmentId')}>
                  <option value="">No department</option>
                  {departments.data?.filter((d) => d.isActive).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Reporting manager" error={errors.managerId?.message}>
              {({ id, invalid }) => (
                <Controller control={control} name="managerId" render={({ field }) => (
                  <Combobox id={id} value={field.value || null} onChange={field.onChange} invalid={invalid}
                    options={managers.data ?? []} placeholder="Search people" disabled={managers.isPending} />
                )} />
              )}
            </Field>
            <Field label="Employment type">
              {({ id }) => (
                <Select id={id} {...register('employmentType')}>
                  {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              )}
            </Field>
            {canAssign && (
              <Field label="Role" hint="What they can do once active">
                {({ id, describedBy }) => (
                  <Select id={id} aria-describedby={describedBy} {...register('roleId')}>
                    <option value="">No role yet</option>
                    {roles.data?.filter((r) => r.is_active).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                )}
              </Field>
            )}
          </div>
        )}

        <label className="flex items-start gap-3 rounded-lg border border-line px-3 py-2.5 text-sm">
          <Checkbox className="mt-0.5" {...register('sendInvite')} />
          <span>
            <span className="font-medium">Create an activation link</span>
            <span className="block text-xs text-muted">They set a password and complete their own details. Untick to add a record without portal access for now.</span>
          </span>
        </label>
        {canAssign && !more && defaultRole && (
          <p className="text-xs text-muted">They will get the <strong>Employee</strong> role. Change it under “More details”.</p>
        )}
      </form>
    </Dialog>
  );
}

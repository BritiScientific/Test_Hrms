import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { RotateCcw } from 'lucide-react';
import { InlineAlert } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Field, Input, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ApiError } from '@/services/api-client';
import type { EmployeePatch } from '@/services/employees-api';
import type { Employee } from '@/types/api';
import { useOrgOptions } from '../organization/hooks';
import { EMPLOYMENT_TYPES, GENDERS, STATUS_LABEL, useDepartments, useManagerOptions } from './shared';

type Mode = 'hr' | 'self';

interface Values {
  // HR
  fullName: string; employeeCode: string; jobTitle: string; employmentType: string; departmentId: string;
  managerId: string; dateOfJoining: string; workLocation: string; status: string;
  // self-service
  preferredName: string; dateOfBirth: string; gender: string; personalEmail: string; mobilePhone: string;
  line1: string; line2: string; city: string; stateProvince: string; postalCode: string; countryCode: string;
  ecName: string; ecRelation: string; ecPhone: string;
}

const s = (v: unknown) => (v == null ? '' : String(v));
function toValues(e: Employee): Values {
  return {
    fullName: e.fullName, employeeCode: e.employeeCode, jobTitle: s(e.jobTitle), employmentType: e.employmentType,
    departmentId: s(e.department?.id), managerId: s(e.manager?.id), dateOfJoining: s(e.dateOfJoining),
    workLocation: s(e.workLocation), status: e.status,
    preferredName: s(e.preferredName), dateOfBirth: s(e.dateOfBirth), gender: s(e.gender),
    personalEmail: s(e.personalEmail), mobilePhone: s(e.mobilePhone),
    line1: s(e.address.line1), line2: s(e.address.line2), city: s(e.address.city), stateProvince: s(e.address.stateProvince),
    postalCode: s(e.address.postalCode), countryCode: s(e.address.countryCode),
    ecName: s(e.emergencyContact.name), ecRelation: s(e.emergencyContact.relation), ecPhone: s(e.emergencyContact.phone),
  };
}

const HR_KEYS = ['fullName', 'employeeCode', 'jobTitle', 'employmentType', 'departmentId', 'managerId', 'dateOfJoining', 'workLocation', 'status'] as const;
const SELF_TOP = ['preferredName', 'dateOfBirth', 'gender', 'personalEmail', 'mobilePhone'] as const;
const ADDRESS: Record<string, string> = { line1: 'line1', line2: 'line2', city: 'city', stateProvince: 'stateProvince', postalCode: 'postalCode', countryCode: 'countryCode' };
const EMERGENCY: Record<string, string> = { ecName: 'name', ecRelation: 'relation', ecPhone: 'phone' };

/** Server error key -> form field. */
function fieldFor(key: string): keyof Values | null {
  if (key.startsWith('address.')) return (key.slice(8) as keyof Values) ?? null;
  if (key.startsWith('emergencyContact.')) {
    const k = key.slice(17);
    return (Object.entries(EMERGENCY).find(([, v]) => v === k)?.[0] as keyof Values) ?? null;
  }
  return key as keyof Values;
}

/** Only changed fields are sent; "" clears a field. */
function diff(values: Values, initial: Values, mode: Mode): EmployeePatch {
  const patch: EmployeePatch = {};
  const changed = (k: keyof Values) => values[k].trim() !== initial[k].trim();
  const out = (k: keyof Values) => (values[k].trim() === '' ? null : values[k].trim());
  if (mode === 'hr') {
    for (const k of HR_KEYS) {
      if (!changed(k)) continue;
      patch[k] = k === 'departmentId' || k === 'managerId' ? (values[k] ? Number(values[k]) : null) : out(k);
    }
  }
  for (const k of SELF_TOP) if (changed(k)) patch[k] = out(k);
  const address: Record<string, unknown> = {};
  for (const [k, api] of Object.entries(ADDRESS)) if (changed(k as keyof Values)) address[api] = out(k as keyof Values);
  if (Object.keys(address).length) patch.address = address;
  const ec: Record<string, unknown> = {};
  for (const [k, api] of Object.entries(EMERGENCY)) if (changed(k as keyof Values)) ec[api] = out(k as keyof Values);
  if (Object.keys(ec).length) patch.emergencyContact = ec;
  return patch;
}

const REQUIRED_FOR_PROFILE = new Set(['dateOfBirth', 'mobilePhone', 'city', 'countryCode', 'ecName', 'ecPhone']);

/**
 * One form for both audiences:
 *  - mode 'hr': every field (job details + the employee's own details).
 *  - mode 'self': only the self-service sections (the API rejects anything else).
 */
export function EmployeeForm({ employee, mode, readOnly, onSave }: {
  employee: Employee;
  mode: Mode;
  readOnly?: boolean;
  onSave: (patch: EmployeePatch) => Promise<Employee>;
}) {
  const { notify } = useToast();
  const options = useOrgOptions();
  const departments = useDepartments(mode === 'hr');
  const managers = useManagerOptions(mode === 'hr' && !readOnly);
  const initial = useMemo(() => toValues(employee), [employee]);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const { register, control, handleSubmit, reset, setError: setFieldError, formState: { errors, isDirty, isSubmitting } } =
    useForm<Values>({ defaultValues: initial });
  useEffect(() => reset(initial), [initial, reset]);
  const blocker = useUnsavedChanges(isDirty && !isSubmitting);

  const submit = handleSubmit(async (values) => {
    setError(null);
    setConflict(false);
    if (mode === 'hr' && values.fullName.trim().length < 2) return setFieldError('fullName', { message: 'Enter the full name' });
    const patch = diff(values, initial, mode);
    if (!Object.keys(patch).length) return;
    try {
      const saved = await onSave({ ...patch, version: employee.version });
      reset(toValues(saved));
      notify({ tone: 'success', title: mode === 'self' ? 'Your details were saved' : 'Employee saved',
        description: saved.profile.completed && !employee.profile.completed ? 'Profile is now complete.' : undefined });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') return setConflict(true);
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) {
        let mapped = false;
        for (const [k, msg] of Object.entries(e.fieldErrors)) {
          const f = fieldFor(k);
          if (f && f in initial) { setFieldError(f, { message: msg }); mapped = true; }
        }
        if (!mapped) setError(e.message);
      } else setError(e instanceof ApiError ? e.message : 'Could not save.');
    }
  });

  const text = (name: keyof Values, label: string, o: { type?: string; required?: boolean; hint?: string; autoComplete?: string; className?: string } = {}) => (
    <Field label={label} error={errors[name]?.message} required={o.required} className={o.className}
      hint={o.hint ?? (REQUIRED_FOR_PROFILE.has(name) && !initial[name] ? 'Needed to complete the profile' : undefined)}>
      {({ id, describedBy, invalid }) => (
        <Input id={id} type={o.type ?? 'text'} autoComplete={o.autoComplete} disabled={readOnly}
          aria-describedby={describedBy} aria-invalid={invalid} {...register(name)} />
      )}
    </Field>
  );

  return (
    <form noValidate onSubmit={submit} className="space-y-5">
      {blocker}
      {conflict && (
        <InlineAlert tone="warning" title="Someone else changed this profile">
          Your changes were not saved. Reload the latest version and re-apply them.
          <div className="mt-2">
            <Button size="sm" variant="outline" icon={<RotateCcw className="size-3.5" />} onClick={() => window.location.reload()}>Reload</Button>
          </div>
        </InlineAlert>
      )}
      {error && <InlineAlert>{error}</InlineAlert>}

      {mode === 'hr' && (
        <Card>
          <CardHeader title="Job details" description="Managed by HR." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text('fullName', 'Full name', { required: true })}
            {text('employeeCode', 'Employee code', { required: true })}
            {text('jobTitle', 'Job title')}
            <Field label="Employment type">
              {({ id }) => (
                <Select id={id} disabled={readOnly} {...register('employmentType')}>
                  {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Department" error={errors.departmentId?.message}>
              {({ id, invalid }) => (
                // Controlled: options arrive after the form, and the saved value must still show.
                <Controller control={control} name="departmentId" render={({ field }) => (
                  <Select id={id} disabled={readOnly} aria-invalid={invalid} value={field.value} onChange={field.onChange} onBlur={field.onBlur}>
                    <option value="">No department</option>
                    {(departments.data ?? (employee.department ? [{ id: employee.department.id, name: employee.department.name }] : []))
                      .map((d) => <option key={d.id} value={String(d.id)}>{d.name}</option>)}
                  </Select>
                )} />
              )}
            </Field>
            <Field label="Reporting manager" error={errors.managerId?.message}>
              {({ id, invalid }) => (
                <Controller control={control} name="managerId" render={({ field }) => (
                  readOnly
                    ? <Input id={id} disabled value={employee.manager?.name ?? '—'} readOnly />
                    : (
                      <div className="flex gap-2">
                        <div className="min-w-0 flex-1">
                          <Combobox id={id} value={field.value || null} onChange={field.onChange} invalid={invalid}
                            placeholder={employee.manager?.name ?? 'Search people'}
                            options={(managers.data ?? (employee.manager ? [{ value: String(employee.manager.id), label: employee.manager.name }] : []))
                              .filter((o) => o.value !== String(employee.id))} />
                        </div>
                        {field.value && <Button variant="ghost" size="sm" className="h-10" onClick={() => field.onChange('')}>Clear</Button>}
                      </div>
                    )
                )} />
              )}
            </Field>
            {text('dateOfJoining', 'Date of joining', { type: 'date', required: true })}
            {text('workLocation', 'Work location')}
            <Field label="Employment status" hint="Exited ends portal access immediately">
              {({ id, describedBy }) => (
                <Select id={id} disabled={readOnly} aria-describedby={describedBy} {...register('status')}>
                  {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </Select>
              )}
            </Field>
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Personal details" description={mode === 'hr' ? 'Usually filled by the employee.' : undefined}
          actions={mode === 'hr' && <Badge tone="neutral">Self-service</Badge>} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {text('preferredName', 'Preferred name', { hint: 'What colleagues call you (optional)' })}
          {text('dateOfBirth', 'Date of birth', { type: 'date', autoComplete: 'bday' })}
          <Field label="Gender" hint="Optional">
            {({ id, describedBy }) => (
              <Select id={id} disabled={readOnly} aria-describedby={describedBy} {...register('gender')}>
                <option value="">Not specified</option>
                {GENDERS.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
              </Select>
            )}
          </Field>
          {text('mobilePhone', 'Mobile phone', { type: 'tel', autoComplete: 'tel' })}
          {text('personalEmail', 'Personal email', { type: 'email', autoComplete: 'email', hint: 'Optional' })}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Home address" actions={mode === 'hr' && <Badge tone="neutral">Self-service</Badge>} />
        <CardBody className="grid gap-4 sm:grid-cols-2">
          {text('line1', 'Address line 1', { autoComplete: 'address-line1', className: 'sm:col-span-2', hint: 'Optional' })}
          {text('line2', 'Address line 2', { autoComplete: 'address-line2', className: 'sm:col-span-2', hint: 'Optional' })}
          {text('city', 'City', { autoComplete: 'address-level2' })}
          {text('stateProvince', 'State / province', { autoComplete: 'address-level1', hint: 'Optional' })}
          {text('postalCode', 'Postal code', { autoComplete: 'postal-code', hint: 'Optional' })}
          <Field label="Country" error={errors.countryCode?.message} hint={!initial.countryCode ? 'Needed to complete the profile' : undefined}>
            {({ id, describedBy, invalid }) => (
              <Controller control={control} name="countryCode" render={({ field }) => (
                <Combobox id={id} value={field.value || null} onChange={field.onChange} disabled={readOnly || options.isPending}
                  invalid={invalid} describedBy={describedBy} placeholder="Search countries"
                  options={(options.data?.countries ?? []).map((c) => ({ value: c.code, label: c.label, hint: c.code }))} />
              )} />
            )}
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Emergency contact" actions={mode === 'hr' && <Badge tone="neutral">Self-service</Badge>} />
        <CardBody className="grid gap-4 sm:grid-cols-3">
          {text('ecName', 'Name', { autoComplete: 'off' })}
          {text('ecRelation', 'Relationship', { hint: 'Optional' })}
          {text('ecPhone', 'Phone', { type: 'tel', autoComplete: 'off' })}
        </CardBody>
      </Card>

      {!readOnly && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
          <Button variant="outline" disabled={!isDirty || isSubmitting} onClick={() => reset(initial)}>Cancel</Button>
          <Button type="submit" loading={isSubmitting} disabled={!isDirty}>Save changes</Button>
        </div>
      )}
    </form>
  );
}

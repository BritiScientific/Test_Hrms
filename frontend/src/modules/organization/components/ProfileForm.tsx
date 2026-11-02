import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import { ApiError } from '@/services/api-client';
import { organizationApi } from '@/services/organization-api';
import type { OrganizationProfile, ProfilePatch } from '@/types/api';
import { orgKeys, useOrgOptions } from '../hooks';

const opt = (max: number, msg?: string) => z.string().trim().max(max, msg ?? `Up to ${max} characters`);

export const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'Enter at least 2 characters').max(200),
  legalName: opt(200),
  industry: opt(100),
  registrationNumber: opt(100),
  contactPerson: opt(200),
  contactEmail: z.union([z.literal(''), z.string().trim().email('Enter a valid email address').max(254)]),
  contactPhone: z.union([z.literal(''), z.string().trim().regex(/^\+?[0-9 ()-]{5,40}$/, 'Digits, spaces, +, ( ) and - only')]),
  website: z.union([z.literal(''), z.string().trim().url('Enter a full URL, e.g. https://example.com').max(300)
    .refine((u) => /^https?:\/\//i.test(u), 'Must start with http:// or https://')]),
  line1: opt(200),
  line2: opt(200),
  city: opt(100),
  stateProvince: opt(100),
  postalCode: opt(20),
  countryCode: z.string(),
});
export type ProfileValues = z.infer<typeof profileSchema>;
export type ProfileSection = 'basic' | 'contact' | 'address';

const ADDRESS_KEYS = ['line1', 'line2', 'city', 'stateProvince', 'postalCode', 'countryCode'] as const;

export function profileToValues(p: OrganizationProfile): ProfileValues {
  return {
    displayName: p.displayName ?? '',
    legalName: p.legalName ?? '',
    industry: p.industry ?? '',
    registrationNumber: p.registrationNumber ?? '',
    contactPerson: p.contactPerson ?? '',
    contactEmail: p.contactEmail ?? '',
    contactPhone: p.contactPhone ?? '',
    website: p.website ?? '',
    line1: p.address.line1 ?? '',
    line2: p.address.line2 ?? '',
    city: p.address.city ?? '',
    stateProvince: p.address.stateProvince ?? '',
    postalCode: p.address.postalCode ?? '',
    countryCode: p.address.countryCode ?? '',
  };
}

/** Only changed fields are sent; "" clears a field (null on the server). */
export function valuesToPatch(values: ProfileValues, initial: ProfileValues): ProfilePatch {
  const patch: Record<string, unknown> = {};
  const address: Record<string, unknown> = {};
  for (const key of Object.keys(values) as (keyof ProfileValues)[]) {
    const v = values[key].trim();
    if (v === initial[key].trim()) continue;
    const out = v === '' ? null : v;
    if ((ADDRESS_KEYS as readonly string[]).includes(key)) address[key] = out;
    else patch[key] = out;
  }
  if (Object.keys(address).length) patch.address = address;
  return patch as ProfilePatch;
}

const INDUSTRIES = ['Information Technology', 'Software', 'Manufacturing', 'Healthcare', 'Financial Services', 'Education',
  'Retail', 'Consulting', 'Logistics', 'Hospitality', 'Construction', 'Non-profit', 'Government', 'Other'];

/**
 * Organization profile form used by the settings page (all sections) and by
 * onboarding steps (a subset). Saves only changed fields with the profile
 * version for optimistic concurrency.
 */
export function ProfileForm({ profile, sections = ['basic', 'contact', 'address'], readOnly, submitLabel = 'Save changes',
  onSaved, secondaryAction, guardUnsaved = true }: {
  profile: OrganizationProfile;
  sections?: ProfileSection[];
  readOnly?: boolean;
  submitLabel?: string;
  onSaved?: (p: OrganizationProfile) => void;
  secondaryAction?: ReactNode;
  guardUnsaved?: boolean;
}) {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const { notify } = useToast();
  const options = useOrgOptions();
  const initial = useMemo(() => profileToValues(profile), [profile]);
  const [conflict, setConflict] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { register, control, handleSubmit, reset, setError, formState: { errors, isDirty, isSubmitting } } =
    useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: initial });

  useEffect(() => reset(initial), [initial, reset]);
  const blocker = useUnsavedChanges(guardUnsaved && isDirty && !isSubmitting);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    setConflict(false);
    const patch = valuesToPatch(values, initial);
    if (!Object.keys(patch).length) {
      onSaved?.(profile);
      return;
    }
    try {
      const saved = await organizationApi.updateProfile({ ...patch, version: profile.version });
      qc.setQueryData(orgKeys.profile, saved);
      reset(profileToValues(saved));
      await Promise.all([qc.invalidateQueries({ queryKey: orgKeys.onboarding }), refresh()]);
      notify({ tone: 'success', title: 'Organization profile saved' });
      onSaved?.(saved);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setConflict(true);
        return;
      }
      if (e instanceof ApiError) {
        const fe = e.fieldErrors;
        let mapped = false;
        for (const [k, msg] of Object.entries(fe)) {
          const name = k.replace(/^address\./, '') as keyof ProfileValues;
          if (name in initial) {
            setError(name, { message: msg });
            mapped = true;
          }
        }
        if (!mapped) setFormError(e.message);
      } else setFormError('Could not save. Please try again.');
    }
  });

  const text = (name: keyof ProfileValues, label: string, opts: { required?: boolean; hint?: string; type?: string; autoComplete?: string; className?: string; inputMode?: 'email' | 'tel' | 'url' } = {}) => (
    <Field label={label} error={errors[name]?.message} required={opts.required} hint={opts.hint} className={opts.className}>
      {({ id, describedBy, invalid }) => (
        <Input id={id} type={opts.type ?? 'text'} autoComplete={opts.autoComplete} inputMode={opts.inputMode}
          disabled={readOnly} aria-describedby={describedBy} aria-invalid={invalid} {...register(name)} />
      )}
    </Field>
  );

  return (
    <form noValidate onSubmit={onSubmit} className="space-y-5">
      {blocker}
      {conflict && (
        <InlineAlert tone="warning" title="Someone else changed this profile">
          <p>Your changes were not saved. Reload the latest version, then re-apply your edits.</p>
          <Button size="sm" variant="outline" className="mt-2" icon={<RotateCcw className="size-3.5" />}
            onClick={() => qc.invalidateQueries({ queryKey: orgKeys.profile })}>
            Reload latest
          </Button>
        </InlineAlert>
      )}
      {formError && <InlineAlert>{formError}</InlineAlert>}

      {sections.includes('basic') && (
        <Card>
          <CardHeader title="Basic information" description="How your organization appears across the portal." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text('displayName', 'Display name', { required: true, autoComplete: 'organization' })}
            {text('legalName', 'Legal name', { hint: 'As registered with the authorities' })}
            <Field label="Industry" error={errors.industry?.message}>
              {({ id, describedBy, invalid }) => (
                <>
                  <Input id={id} list={`${id}-industries`} disabled={readOnly} aria-describedby={describedBy} aria-invalid={invalid} {...register('industry')} />
                  <datalist id={`${id}-industries`}>{INDUSTRIES.map((i) => <option key={i} value={i} />)}</datalist>
                </>
              )}
            </Field>
            {text('registrationNumber', 'Registration number', { hint: 'e.g. CIN, company number (optional)' })}
          </CardBody>
        </Card>
      )}

      {sections.includes('contact') && (
        <Card>
          <CardHeader title="Contact details" description="Where employees and partners can reach HR." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text('contactPerson', 'Contact person', { autoComplete: 'name' })}
            {text('contactEmail', 'Contact email', { type: 'email', autoComplete: 'email', inputMode: 'email' })}
            {text('contactPhone', 'Phone', { type: 'tel', autoComplete: 'tel', inputMode: 'tel' })}
            {text('website', 'Website', { type: 'url', inputMode: 'url', hint: 'Include https://' })}
          </CardBody>
        </Card>
      )}

      {sections.includes('address') && (
        <Card>
          <CardHeader title="Address" description="Registered or head-office address. Only the fields your business needs." />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {text('line1', 'Address line 1', { autoComplete: 'address-line1', className: 'sm:col-span-2' })}
            {text('line2', 'Address line 2', { autoComplete: 'address-line2', className: 'sm:col-span-2' })}
            {text('city', 'City', { autoComplete: 'address-level2' })}
            {text('stateProvince', 'State / province', { autoComplete: 'address-level1' })}
            {text('postalCode', 'Postal code', { autoComplete: 'postal-code' })}
            <Field label="Country" error={errors.countryCode?.message}>
              {({ id, describedBy, invalid }) => (
                <Controller
                  control={control}
                  name="countryCode"
                  render={({ field }) => (
                    <Combobox
                      id={id}
                      value={field.value || null}
                      onChange={field.onChange}
                      disabled={readOnly || options.isPending}
                      invalid={invalid}
                      describedBy={describedBy}
                      placeholder="Search countries"
                      options={(options.data?.countries ?? []).map((c) => ({ value: c.code, label: c.label, hint: c.code }))}
                    />
                  )}
                />
              )}
            </Field>
          </CardBody>
        </Card>
      )}

      {!readOnly && (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-col-reverse gap-2 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex-row sm:justify-end sm:border-0 sm:bg-transparent sm:p-0">
          {secondaryAction}
          {guardUnsaved && (
            <Button variant="outline" disabled={!isDirty || isSubmitting} onClick={() => reset(initial)}>Cancel</Button>
          )}
          <Button type="submit" loading={isSubmitting} disabled={guardUnsaved && !isDirty}>{submitLabel}</Button>
        </div>
      )}
    </form>
  );
}

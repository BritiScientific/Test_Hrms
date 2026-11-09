import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { CalendarPlus, Paperclip, Trash2 } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { EmptyState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { leaveApi, type ApplyBody } from '@/services/leave-api';
import { formatBytes, formatDate } from '@/utils/format';
import { errorMessage, leaveKey, useInvalidateLeave } from '../hooks';
import { days, daysLabel, tenantToday } from '../leave-format';

const MAX_FILE = 5 * 1024 * 1024;

export const applySchema = z.object({
  leaveTypeCode: z.string().min(1, 'Choose a leave type'),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the start date'),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the end date'),
  durationType: z.enum(['full_day', 'half_day']),
  halfDaySession: z.string(),
  reason: z.string().trim().min(3, 'Please give a reason').max(2000),
  contactDetails: z.string().trim().max(300),
}).superRefine((v, ctx) => {
  if (v.endDate && v.startDate && v.endDate < v.startDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'The end date is before the start date' });
  }
  if (v.durationType === 'half_day' && !v.halfDaySession) {
    ctx.addIssue({ code: 'custom', path: ['halfDaySession'], message: 'Choose the first or second half' });
  }
});
type Values = z.infer<typeof applySchema>;

const toBody = (v: Values, attachmentIds: number[]): ApplyBody => ({
  leaveTypeCode: v.leaveTypeCode,
  startDate: v.startDate,
  endDate: v.durationType === 'half_day' ? v.startDate : v.endDate,
  durationType: v.durationType,
  halfDaySession: v.durationType === 'half_day' ? (v.halfDaySession as ApplyBody['halfDaySession']) : null,
  reason: v.reason.trim(),
  contactDetails: v.contactDetails.trim() || null,
  ...(attachmentIds.length ? { attachmentIds } : {}),
});

/**
 * The server checks everything; the panel beside the form shows its answer as the
 * employee types, so the chargeable days and any problems are visible before submitting.
 */
export default function ApplyLeavePage() {
  usePageTitle('Apply for Leave');
  const me = useMe();
  const navigate = useNavigate();
  const { notify } = useToast();
  const invalidate = useInvalidateLeave();
  const prefs = me.tenant.preferences;
  // One key per form: a double click or a retry after a lost response cannot create two requests.
  const idempotencyKey = useRef(crypto.randomUUID());
  const [attachment, setAttachment] = useState<{ id: number; fileName: string; byteSize: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { register, handleSubmit, watch, setValue, setError, formState: { errors, isSubmitting } } = useForm<Values>({
    resolver: zodResolver(applySchema),
    defaultValues: { leaveTypeCode: '', startDate: '', endDate: '', durationType: 'full_day', halfDaySession: '', reason: '', contactDetails: '' },
  });
  const values = watch();

  const types = useQuery({ queryKey: leaveKey('applicable-types'), queryFn: () => leaveApi.applicableTypes() });
  const type = useMemo(() => types.data?.types.find((t) => t.code === values.leaveTypeCode), [types.data, values.leaveTypeCode]);
  const isHalf = values.durationType === 'half_day';

  useEffect(() => {
    if (type && !type.effectiveAllowHalfDay && isHalf) setValue('durationType', 'full_day');
  }, [type, isHalf, setValue]);
  useEffect(() => {
    if (values.startDate && !values.endDate) setValue('endDate', values.startDate);
  }, [values.startDate, values.endDate, setValue]);

  const previewInput = useDebounced(JSON.stringify(toBody(values, attachment ? [attachment.id] : [])));
  const canPreview = !!values.leaveTypeCode && !!values.startDate && (isHalf || !!values.endDate);
  const preview = useQuery({
    queryKey: leaveKey('preview', previewInput),
    queryFn: () => leaveApi.preview(JSON.parse(previewInput)),
    enabled: canPreview,
    staleTime: 0,
    placeholderData: (prev) => prev,
  });

  const pickFile = async (file: File | undefined) => {
    if (!file) return;
    setFormError(null);
    if (file.size > MAX_FILE) return setFormError('Files can be at most 5 MB.');
    setUploading(true);
    try {
      const a = await leaveApi.uploadAttachment(file);
      if (attachment) await leaveApi.removeAttachment(attachment.id).catch(() => undefined);
      setAttachment(a);
    } catch (e) {
      setFormError(errorMessage(e, 'The file could not be uploaded.'));
    } finally {
      setUploading(false);
    }
  };

  const submit = handleSubmit(async (v) => {
    setFormError(null);
    try {
      await leaveApi.apply(toBody(v, attachment ? [attachment.id] : []), idempotencyKey.current);
      await invalidate();
      notify({ tone: 'success', title: 'Leave request submitted', description: 'Your approver has been notified. The days are held until a decision.' });
      navigate('/leave/my-requests?tab=requests');
    } catch (e) {
      if (e instanceof ApiError) {
        for (const [k, msg] of Object.entries(e.fieldErrors)) {
          if (k in v) setError(k as keyof Values, { message: msg });
        }
        // A validation failure is final for this attempt, so the employee can correct it and retry with a new key.
        if (e.status === 422) idempotencyKey.current = crypto.randomUUID();
        setFormError(e.message);
      } else {
        setFormError('The request could not be submitted.');
      }
    }
  });

  if (types.isPending) return <><PageHeader title="Apply for Leave" /><Card><CardBody><LoadingBlock rows={6} /></CardBody></Card></>;
  if (types.data && !types.data.types.length) {
    return (
      <>
        <PageHeader title="Apply for Leave" />
        <Card><EmptyState icon={<CalendarPlus />} title="No leave types are available to you"
          description="HR hasn’t assigned a leave policy that covers you yet. Contact them to get set up." /></Card>
      </>
    );
  }

  const issueFor = (field: string) => preview.data?.issues.find((i) => i.field === field)?.message;
  const generalIssues = preview.data?.issues.filter((i) => !i.field) ?? [];
  const p = preview.data;

  return (
    <div>
      <PageHeader title="Apply for Leave" description={types.data?.policy ? `Under ${types.data.policy.name}` : undefined} />
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <form noValidate onSubmit={submit}>
            <CardBody className="space-y-4">
              {formError && <InlineAlert>{formError}</InlineAlert>}
              <Field label="Leave type" required error={errors.leaveTypeCode?.message ?? (canPreview ? issueFor('leaveTypeCode') : undefined)}
                hint={type?.description ?? undefined}>
                {({ id, invalid, describedBy }) => (
                  <Select id={id} data-autofocus aria-invalid={invalid} aria-describedby={describedBy} {...register('leaveTypeCode')}>
                    <option value="">Choose a leave type</option>
                    {types.data?.types.map((t) => <option key={t.code} value={t.code}>{t.name}{!t.isPaid ? ' (unpaid)' : ''}</option>)}
                  </Select>
                )}
              </Field>

              <fieldset>
                <legend className="mb-1.5 text-sm font-medium text-slate-700">Duration</legend>
                <div className="flex flex-wrap gap-4 text-sm">
                  <label className="flex items-center gap-2"><input type="radio" value="full_day" className="accent-primary" {...register('durationType')} />Full day</label>
                  <label className={type && !type.effectiveAllowHalfDay ? 'flex items-center gap-2 text-slate-400' : 'flex items-center gap-2'}>
                    <input type="radio" value="half_day" className="accent-primary" disabled={!!type && !type.effectiveAllowHalfDay} {...register('durationType')} />
                    Half day{type && !type.effectiveAllowHalfDay && ' (not available for this type)'}
                  </label>
                </div>
              </fieldset>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={isHalf ? 'Date' : 'Start date'} required error={errors.startDate?.message ?? issueFor('startDate')}>
                  {({ id, invalid, describedBy }) => <Input id={id} type="date" aria-invalid={invalid} aria-describedby={describedBy} {...register('startDate')} />}
                </Field>
                {isHalf ? (
                  <Field label="Session" required error={errors.halfDaySession?.message ?? issueFor('halfDaySession')}>
                    {({ id, invalid, describedBy }) => (
                      <Select id={id} aria-invalid={invalid} aria-describedby={describedBy} {...register('halfDaySession')}>
                        <option value="">Choose a session</option>
                        <option value="first_half">First half</option>
                        <option value="second_half">Second half</option>
                      </Select>
                    )}
                  </Field>
                ) : (
                  <Field label="End date" required error={errors.endDate?.message ?? issueFor('endDate')}>
                    {({ id, invalid, describedBy }) => <Input id={id} type="date" min={values.startDate || undefined} aria-invalid={invalid} aria-describedby={describedBy} {...register('endDate')} />}
                  </Field>
                )}
              </div>

              <Field label="Reason" required error={errors.reason?.message}>
                {({ id, invalid, describedBy }) => <Textarea id={id} maxLength={2000} aria-invalid={invalid} aria-describedby={describedBy} {...register('reason')} />}
              </Field>

              <Field label="Contact details during leave" required={type?.requiresContactDetails}
                error={errors.contactDetails?.message ?? issueFor('contactDetails')}
                hint={type?.requiresContactDetails ? undefined : 'Optional'}>
                {({ id, invalid, describedBy }) => <Input id={id} maxLength={300} placeholder="Phone or email" aria-invalid={invalid} aria-describedby={describedBy} {...register('contactDetails')} />}
              </Field>

              <div>
                <p className="mb-1.5 text-sm font-medium text-slate-700">
                  Supporting document
                  {type?.requiresAttachment ? <span className="ml-0.5 text-danger" aria-hidden>*</span> : <span className="ml-1 font-normal text-muted">(optional)</span>}
                </p>
                {attachment ? (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Paperclip className="size-4 shrink-0 text-slate-400" aria-hidden />
                      <span className="truncate">{attachment.fileName}</span>
                      <span className="shrink-0 text-xs text-muted">{formatBytes(attachment.byteSize)}</span>
                    </span>
                    <Button variant="ghost" size="icon" aria-label="Remove the file" onClick={() => {
                      leaveApi.removeAttachment(attachment.id).catch(() => undefined);
                      setAttachment(null);
                    }}><Trash2 className="size-4" aria-hidden /></Button>
                  </div>
                ) : (
                  <Input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" disabled={uploading} aria-label="Supporting document"
                    className="py-1.5" onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                )}
                <p className="mt-1.5 text-xs text-muted">{uploading ? 'Uploading…' : 'PDF, PNG, JPEG or WebP, up to 5 MB.'}</p>
                {canPreview && issueFor('attachment') && <p role="alert" className="mt-1.5 text-xs font-medium text-danger">{issueFor('attachment')}</p>}
              </div>
            </CardBody>
            <div className="safe-bottom flex flex-col-reverse gap-2 border-t border-line bg-slate-50/60 px-4 py-3 sm:flex-row sm:justify-end sm:px-5">
              <Button variant="outline" onClick={() => navigate(-1)} disabled={isSubmitting}>Cancel</Button>
              <Button type="submit" loading={isSubmitting} disabled={uploading} icon={<CalendarPlus className="size-4" />}>Submit request</Button>
            </div>
          </form>
        </Card>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Summary" description={canPreview ? undefined : 'Choose a leave type and dates to see the days charged.'} />
            {canPreview && p && (
              <CardBody className="space-y-4" aria-live="polite">
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3"><dt className="text-muted">Chargeable days</dt><dd className="text-lg font-semibold tabular">{days(p.totalDays)}</dd></div>
                  {p.balance && type?.isPaid && (
                    <>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Available now</dt><dd className="tabular">{days(p.balance.available)}</dd></div>
                      <div className="flex justify-between gap-3"><dt className="text-muted">Left after this request</dt><dd className="font-medium tabular">{days(p.balance.afterRequest)}</dd></div>
                    </>
                  )}
                </dl>
                <p className="text-xs text-muted">Nothing is deducted until the final approval. The days are held in the meantime.</p>
                {p.days.some((d) => d.chargeableDays === 0) && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-slate-700">Not charged</p>
                    <ul className="space-y-1 text-xs text-muted">
                      {p.days.filter((d) => d.chargeableDays === 0).map((d) => (
                        <li key={d.date} className="flex justify-between gap-2">
                          <span>{formatDate(d.date, prefs)}</span>
                          <span className="truncate">{d.holidayName ?? 'Weekly off'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {generalIssues.map((i) => <InlineAlert key={i.code}>{i.message}</InlineAlert>)}
                {p.warnings.map((w) => <InlineAlert key={w} tone="warning">{w}</InlineAlert>)}
                {p.ok && <Badge tone="success">Ready to submit</Badge>}
              </CardBody>
            )}
          </Card>
          {type && (
            <Card>
              <CardHeader title={`${type.name} rules`} as="h3" />
              <CardBody>
                <ul className="space-y-1.5 text-sm text-slate-700">
                  {type.annualEntitlement > 0 && <li>{daysLabel(type.annualEntitlement)} a year</li>}
                  {type.minNoticeDays > 0 && <li>Apply at least {daysLabel(type.minNoticeDays)} ahead</li>}
                  {type.effectiveMaxConsecutiveDays != null && <li>At most {daysLabel(type.effectiveMaxConsecutiveDays)} in one request</li>}
                  <li>{type.allowBackdated
                    ? `Past dates allowed${type.maxBackdatedDays != null ? `, up to ${daysLabel(type.maxBackdatedDays)} back` : ''}`
                    : 'Past dates not allowed'}</li>
                  {type.includeNonWorkingDays && <li>Weekly offs and holidays are charged</li>}
                  {type.requiresAttachment && <li>A supporting document is required</li>}
                  <li className="text-xs text-muted">Today is {formatDate(tenantToday(prefs.timezone), prefs)}</li>
                </ul>
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

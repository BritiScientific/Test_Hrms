import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ArrowLeft } from 'lucide-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { InlineAlert, LoadingBlock } from '@/components/feedback/States';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { careersApi } from '../api';
import { FileField, RESUME_ACCEPT } from '../AddCandidateDialog';
import type { PublicQuestion, UploadedFile } from '../types';
import { CareersMessage, useCareersOrg } from './CareersLayout';

const PHOTO_ACCEPT = '.png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp';
type Answer = string | boolean | '';

/** /careers/:jobSlug/apply — the application form. */
export default function ApplyPage() {
  const slug = useParams().jobSlug ?? '';
  const navigate = useNavigate();
  const { setOrg } = useCareersOrg();
  const q = useQuery({
    queryKey: ['careers', 'job', slug], queryFn: () => careersApi.job(slug),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const job = q.data?.job;
  const org = q.data?.organization;
  useEffect(() => { if (org) setOrg(org); }, [org, setOrg]);
  usePageTitle(job ? `Apply · ${job.title}` : 'Apply');

  const [v, setV] = useState({ fullName: '', email: '', phone: '', location: '', currentTitle: '', currentCompany: '', experienceYears: '', linkedinUrl: '', coverLetter: '', jobPositionId: '', website: '' });
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [resume, setResume] = useState<File | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  // Uploaded files are remembered so a retry after a failed submit does not upload them again.
  const [uploaded, setUploaded] = useState<{ resume?: { file: File; ref: UploadedFile }; photo?: { file: File; ref: UploadedFile } }>({});
  const [consent, setConsent] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (job && job.positions.length === 1) setV((s) => (s.jobPositionId ? s : { ...s, jobPositionId: String(job.positions[0].id) }));
  }, [job]);

  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const submit = useMutation({
    mutationFn: async () => {
      const files: typeof uploaded = { ...uploaded };
      if (resume && files.resume?.file !== resume) files.resume = { file: resume, ref: await careersApi.upload(slug, 'resume', resume) };
      if (photo && files.photo?.file !== photo) files.photo = { file: photo, ref: await careersApi.upload(slug, 'photo', photo) };
      if (!resume) delete files.resume;
      if (!photo) delete files.photo;
      setUploaded(files);
      const ref = (f?: { ref: UploadedFile }) => (f ? { id: f.ref.id, claimToken: f.ref.claimToken } : undefined);
      return careersApi.apply(slug, {
        fullName: v.fullName.trim(), email: v.email.trim(), phone: v.phone.trim(), location: v.location.trim() || null,
        currentTitle: v.currentTitle.trim() || null, currentCompany: v.currentCompany.trim() || null,
        experienceYears: v.experienceYears.trim() === '' ? null : Number(v.experienceYears), linkedinUrl: v.linkedinUrl.trim() || null,
        jobPositionId: v.jobPositionId ? Number(v.jobPositionId) : null, coverLetter: v.coverLetter.trim() || null,
        resume: ref(files.resume), photo: ref(files.photo),
        answers: (job?.questions ?? []).flatMap((qn) => {
          const a = answers[qn.id];
          if (a === undefined || a === '') return [];
          return [{ questionId: qn.id, value: qn.type === 'number' ? Number(a) : a }];
        }),
        consent: true, website: v.website,
      });
    },
    onSuccess: (r) => navigate(`/careers/${slug}/applied`, { replace: true, state: { reference: r.reference, jobTitle: r.jobTitle, message: r.message, org: org?.slug } }),
    onError: (e) => {
      if (!(e instanceof ApiError)) return setFormError('Something went wrong. Please try again.');
      if (e.code === 'ALREADY_APPLIED') return setFormError('You have already applied for this job with this email address. We will be in touch.');
      if (e.status === 404) return setFormError('This job is no longer open for applications.');
      const fe = e.fieldErrors;
      if (Object.keys(fe).length) {
        setErrors(fe);
        const known = (k: string) => k in v || k === 'resume' || k === 'photo' || k === 'consent' || k.startsWith('answer_');
        setFormError(Object.keys(fe).every(known) ? null : Object.values(fe).join(' '));
        // A rejected upload must be chosen again.
        if (fe.resume) setUploaded((u) => ({ ...u, resume: undefined }));
        return;
      }
      setFormError(e.message);
    },
  });

  if (q.isPending) return <div className="mx-auto max-w-2xl"><LoadingBlock rows={8} label="Loading form" /></div>;
  if (q.isError || !job || !org) {
    return <CareersMessage title="This job is no longer open" action={<ButtonLink to="/careers" variant="outline">See all jobs</ButtonLink>}>The position may have been filled or closed.</CareersMessage>;
  }

  const validate = () => {
    const e: Record<string, string> = {};
    if (v.fullName.trim().length < 2) e.fullName = 'Enter your full name';
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = 'Enter a valid email address';
    if (!/^\+?[0-9 ()-]{5,40}$/.test(v.phone.trim())) e.phone = 'Enter a phone number (digits, spaces, +, ( ) and - only)';
    if (v.experienceYears.trim() && !(Number(v.experienceYears) >= 0 && Number(v.experienceYears) <= 80)) e.experienceYears = 'Enter years between 0 and 80';
    if (v.linkedinUrl.trim() && !/^https?:\/\/\S+$/i.test(v.linkedinUrl.trim())) e.linkedinUrl = 'Enter a full link starting with https://';
    if (job.positions.length > 1 && !v.jobPositionId) e.jobPositionId = 'Choose the role you are applying for';
    if (job.resumeRequired && !resume) e.resume = 'Please attach your resume';
    for (const qn of job.questions) {
      const a = answers[qn.id];
      const empty = a === undefined || a === '';
      if (qn.required && empty) e[`answer_${qn.id}`] = 'This question is required';
      else if (!empty && qn.type === 'number' && !Number.isFinite(Number(a))) e[`answer_${qn.id}`] = 'Enter a number';
    }
    if (!consent) e.consent = 'Please accept the privacy notice to apply';
    return e;
  };
  const onSubmit = (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormError(null);
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    submit.mutate();
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link to={`/careers/${slug}`} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />Back to job</Link>
      <form noValidate onSubmit={onSubmit} className="space-y-5 rounded-xl border border-line bg-surface p-5 shadow-card sm:p-8">
        <div><h1 className="text-xl font-semibold tracking-tight">Apply for {job.title}</h1><p className="mt-1 text-sm text-muted">Fields marked * are required.</p></div>
        {formError && <InlineAlert>{formError}</InlineAlert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.fullName}>{({ id, invalid, describedBy }) => <Input id={id} autoComplete="name" value={v.fullName} onChange={set('fullName')} maxLength={200} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Email" required error={errors.email}>{({ id, invalid, describedBy }) => <Input id={id} type="email" autoComplete="email" value={v.email} onChange={set('email')} maxLength={254} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Phone" required error={errors.phone}>{({ id, invalid, describedBy }) => <Input id={id} type="tel" autoComplete="tel" value={v.phone} onChange={set('phone')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Current location" error={errors.location}>{({ id }) => <Input id={id} autoComplete="address-level2" value={v.location} onChange={set('location')} maxLength={200} />}</Field>
          <Field label="Current role">{({ id }) => <Input id={id} value={v.currentTitle} onChange={set('currentTitle')} maxLength={200} />}</Field>
          <Field label="Current company">{({ id }) => <Input id={id} value={v.currentCompany} onChange={set('currentCompany')} maxLength={200} />}</Field>
          <Field label="Years of experience" error={errors.experienceYears}>{({ id, invalid, describedBy }) => <Input id={id} inputMode="decimal" value={v.experienceYears} onChange={set('experienceYears')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="LinkedIn profile" error={errors.linkedinUrl}>{({ id, invalid, describedBy }) => <Input id={id} type="url" placeholder="https://" value={v.linkedinUrl} onChange={set('linkedinUrl')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
        </div>

        {job.positions.length > 1 && (
          <Field label="Role" required error={errors.jobPositionId}>
            {({ id, invalid, describedBy }) => (
              <Select id={id} value={v.jobPositionId} onChange={set('jobPositionId')} aria-invalid={invalid} aria-describedby={describedBy}>
                <option value="">Choose a role…</option>
                {job.positions.map((p) => <option key={p.id} value={p.id}>{p.title}{p.department ? ` (${p.department})` : ''}</option>)}
              </Select>
            )}
          </Field>
        )}

        <Field label="Resume" required={job.resumeRequired} hint="PDF, DOC or DOCX, up to 5 MB." error={errors.resume}>
          {({ id, invalid, describedBy }) => <FileField id={id} file={resume} onChange={setResume} accept={RESUME_ACCEPT} invalid={invalid} describedBy={describedBy} />}
        </Field>
        {job.photoAllowed && (
          <Field label="Profile photo" hint="Optional. PNG, JPEG or WebP, up to 5 MB." error={errors.photo}>
            {({ id, invalid, describedBy }) => <FileField id={id} file={photo} onChange={setPhoto} accept={PHOTO_ACCEPT} invalid={invalid} describedBy={describedBy} />}
          </Field>
        )}
        <Field label="Cover letter" hint="Optional.">{({ id }) => <Textarea id={id} rows={5} value={v.coverLetter} onChange={set('coverLetter')} maxLength={5000} />}</Field>

        {job.questions.length > 0 && (
          <fieldset className="space-y-4 border-t border-line pt-5">
            <legend className="mb-1 text-sm font-semibold text-ink">A few questions</legend>
            {job.questions.map((qn) => (
              <Question key={qn.id} q={qn} value={answers[qn.id] ?? ''} error={errors[`answer_${qn.id}`]} onChange={(a) => setAnswers((s) => ({ ...s, [qn.id]: a }))} />
            ))}
          </fieldset>
        )}

        {/* Honeypot: hidden from people and assistive technology; bots tend to fill it. */}
        <div aria-hidden className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
          <label>Website<input tabIndex={-1} autoComplete="off" value={v.website} onChange={set('website')} /></label>
        </div>

        <div>
          <label className="flex items-start gap-3 text-sm text-slate-700">
            <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={consent} onChange={(e) => setConsent(e.target.checked)} aria-invalid={!!errors.consent || undefined} aria-describedby={errors.consent ? 'consent-err' : undefined} />
            <span>I agree that {org.name} may store and process my details to consider my application
              {org.privacyNoticeUrl && <> (<a href={org.privacyNoticeUrl} target="_blank" rel="noopener noreferrer" className="text-primary underline">privacy notice</a>)</>}.</span>
          </label>
          {errors.consent && <p id="consent-err" role="alert" className="mt-1.5 text-xs font-medium text-danger">{errors.consent}</p>}
        </div>

        <Button type="submit" size="lg" loading={submit.isPending}>Submit application</Button>
      </form>
    </div>
  );
}

function Question({ q, value, error, onChange }: { q: PublicQuestion; value: Answer; error?: string; onChange: (v: Answer) => void }) {
  return (
    <Field label={q.label} required={q.required} error={error}>
      {({ id, invalid, describedBy }) => {
        const a11y = { 'aria-invalid': invalid, 'aria-describedby': describedBy } as const;
        if (q.type === 'textarea') return <Textarea id={id} rows={3} value={String(value)} maxLength={2000} onChange={(e) => onChange(e.target.value)} {...a11y} />;
        if (q.type === 'number') return <Input id={id} inputMode="decimal" value={String(value)} onChange={(e) => onChange(e.target.value)} {...a11y} />;
        if (q.type === 'yes_no') {
          return (
            <Select id={id} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'yes')} {...a11y}>
              <option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option>
            </Select>
          );
        }
        if (q.type === 'select') {
          return (
            <Select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)} {...a11y}>
              <option value="">Choose…</option>{q.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          );
        }
        return <Input id={id} value={String(value)} maxLength={2000} onChange={(e) => onChange(e.target.value)} {...a11y} />;
      }}
    </Field>
  );
}

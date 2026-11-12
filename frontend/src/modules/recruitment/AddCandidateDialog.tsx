import { useRef, useState } from 'react';
import { FileUp, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { formatBytes } from '@/utils/format';
import { recruitmentApi } from './api';
import { SOURCE_LABEL } from './common';
import { errorText, fieldErrors, useInvalidateRecruitment } from './hooks';
import type { Recruitment } from './types';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const RESUME_ACCEPT = '.pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** File picker that shows the chosen file and checks its size before anything is uploaded. */
export function FileField({ id, file, onChange, accept, invalid, describedBy }: {
  id: string; file: File | null; onChange: (f: File | null) => void; accept: string; invalid?: boolean; describedBy?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <input ref={ref} id={id} type="file" accept={accept} className="sr-only" aria-invalid={invalid || undefined} aria-describedby={describedBy}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          e.target.value = '';
          if (f && f.size > MAX_FILE_BYTES) { setError('The file is larger than 5 MB'); return; }
          if (f && f.size === 0) { setError('The file is empty'); return; }
          setError(null);
          onChange(f);
        }} />
      {file ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-slate-50 px-3 py-2 text-sm">
          <span className="min-w-0 truncate">{file.name} <span className="text-muted">· {formatBytes(file.size)}</span></span>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Remove file" onClick={() => onChange(null)}><X className="size-4" /></Button>
        </div>
      ) : (
        <Button variant="outline" icon={<FileUp className="size-4" />} onClick={() => ref.current?.click()}>Choose file</Button>
      )}
      {error && <p role="alert" className="mt-1.5 text-xs font-medium text-danger">{error}</p>}
    </div>
  );
}

/** HR adds a candidate by hand (referral, agency, walk-in). They enter the Applied stage. */
export function AddCandidateDialog({ recruitment, onClose, onAdded }: {
  recruitment: Recruitment; onClose: () => void; onAdded: (applicationId: number) => void;
}) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const [v, setV] = useState({ fullName: '', email: '', phone: '', currentTitle: '', currentCompany: '', experienceYears: '', location: '', linkedinUrl: '', source: 'manual',
    jobPositionId: recruitment.vacancies.length === 1 ? String(recruitment.vacancies[0].jobPositionId) : '' });
  const [resume, setResume] = useState<File | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: async () => {
      const uploaded = resume ? await recruitmentApi.upload('resume', resume) : null;
      return recruitmentApi.recruitments.addCandidate(recruitment.id, {
        fullName: v.fullName.trim(), email: v.email.trim(), phone: v.phone.trim() || null, currentTitle: v.currentTitle.trim() || null,
        currentCompany: v.currentCompany.trim() || null, experienceYears: v.experienceYears.trim() === '' ? null : Number(v.experienceYears),
        location: v.location.trim() || null, linkedinUrl: v.linkedinUrl.trim() || null, source: v.source,
        jobPositionId: v.jobPositionId ? Number(v.jobPositionId) : null,
        ...(uploaded ? { resume: { id: uploaded.id, claimToken: uploaded.claimToken } } : {}),
      });
    },
    onSuccess: async (app) => { await invalidate(); notify({ tone: 'success', title: `${app.candidate.name} added` }); onAdded(app.id); },
    onError: (e) => {
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe);
      else setFormError(errorText(e, 'Could not add the candidate'));
    },
  });

  const submit = () => {
    const e: Record<string, string> = {};
    if (v.fullName.trim().length < 2) e.fullName = 'Enter at least 2 characters';
    if (!/^\S+@\S+\.\S+$/.test(v.email.trim())) e.email = 'Enter a valid email address';
    if (v.phone.trim() && !/^\+?[0-9 ()-]{5,40}$/.test(v.phone.trim())) e.phone = 'Digits, spaces, +, ( ) and - only';
    if (v.experienceYears.trim() && !(Number(v.experienceYears) >= 0 && Number(v.experienceYears) <= 80)) e.experienceYears = 'Enter years between 0 and 80';
    if (v.linkedinUrl.trim() && !/^https?:\/\/\S+$/i.test(v.linkedinUrl.trim())) e.linkedinUrl = 'Enter a full link starting with https://';
    if (recruitment.vacancies.length > 1 && !v.jobPositionId) e.jobPositionId = 'Choose the job position';
    setErrors(e);
    setFormError(null);
    if (!Object.keys(e).length) save.mutate();
  };

  return (
    <Dialog open onClose={save.isPending ? () => undefined : onClose} size="md" title="Add candidate" description={recruitment.title}
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button onClick={submit} loading={save.isPending}>Add candidate</Button></>}>
      <div className="space-y-4">
        {formError && <InlineAlert>{formError}</InlineAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.fullName}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={v.fullName} onChange={set('fullName')} maxLength={200} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Email" required error={errors.email}>{({ id, invalid, describedBy }) => <Input id={id} type="email" value={v.email} onChange={set('email')} maxLength={254} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Phone" error={errors.phone}>{({ id, invalid, describedBy }) => <Input id={id} type="tel" value={v.phone} onChange={set('phone')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Location">{({ id }) => <Input id={id} value={v.location} onChange={set('location')} maxLength={200} />}</Field>
          <Field label="Current role">{({ id }) => <Input id={id} value={v.currentTitle} onChange={set('currentTitle')} maxLength={200} />}</Field>
          <Field label="Current company">{({ id }) => <Input id={id} value={v.currentCompany} onChange={set('currentCompany')} maxLength={200} />}</Field>
          <Field label="Experience (years)" error={errors.experienceYears}>{({ id, invalid, describedBy }) => <Input id={id} inputMode="decimal" value={v.experienceYears} onChange={set('experienceYears')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="LinkedIn" error={errors.linkedinUrl}>{({ id, invalid, describedBy }) => <Input id={id} type="url" value={v.linkedinUrl} onChange={set('linkedinUrl')} placeholder="https://" aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          {recruitment.vacancies.length > 1 && (
            <Field label="Job position" required error={errors.jobPositionId}>
              {({ id, invalid }) => (
                <Select id={id} value={v.jobPositionId} onChange={set('jobPositionId')} aria-invalid={invalid}>
                  <option value="">Choose…</option>
                  {recruitment.vacancies.map((x) => <option key={x.jobPositionId} value={x.jobPositionId}>{x.title}</option>)}
                </Select>
              )}
            </Field>
          )}
          <Field label="Source">
            {({ id }) => (
              <Select id={id} value={v.source} onChange={set('source')}>
                {['manual', 'referral', 'agency', 'other'].map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Resume" hint="PDF, DOC or DOCX, up to 5 MB." error={errors.resume}>
          {({ id, invalid, describedBy }) => <FileField id={id} file={resume} onChange={setResume} accept={RESUME_ACCEPT} invalid={invalid} describedBy={describedBy} />}
        </Field>
      </div>
    </Dialog>
  );
}

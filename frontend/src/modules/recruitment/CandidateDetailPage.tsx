import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Download, ExternalLink, Mail, MapPin, Pencil, Phone } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatBytes } from '@/utils/format';
import { recruitmentApi } from './api';
import { ApplicationDialog } from './ApplicationDialog';
import { ApplicationStatusBadge, SOURCE_LABEL, StageBadge, useDates } from './common';
import { errorText, fieldErrors, isStale, useCandidate, useInvalidateRecruitment } from './hooks';
import type { CandidateDetail } from './types';

export default function CandidateDetailPage() {
  const id = Number(useParams().candidateId);
  const q = useCandidate(id);
  const { can } = useAuth();
  const { date } = useDates();
  const [viewing, setViewing] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const c = q.data;
  usePageTitle(c?.fullName ?? 'Candidate');

  if (!Number.isInteger(id) || id <= 0) return <ErrorState error={new Error('bad id')} />;
  return (
    <>
      <Link to="/recruitment/candidates" className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All candidates</Link>
      {q.isPending && <Card className="p-4"><LoadingBlock rows={8} /></Card>}
      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {c && (
        <>
          <PageHeader title={<span className="flex items-center gap-3"><Avatar name={c.fullName} size="lg" />{c.fullName}</span>}
            description={[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ') || undefined}
            actions={can('recruitment.candidate.manage') && <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEditing(true)}>Edit</Button>} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Contact" />
              <CardBody className="space-y-3 text-sm">
                <Row icon={<Mail className="size-4" />}><a className="break-all text-primary hover:underline" href={`mailto:${c.email}`}>{c.email}</a></Row>
                {c.phone && <Row icon={<Phone className="size-4" />}><a href={`tel:${c.phone}`} className="hover:underline">{c.phone}</a></Row>}
                {c.location && <Row icon={<MapPin className="size-4" />}>{c.location}</Row>}
                {c.linkedinUrl && <Row icon={<ExternalLink className="size-4" />}><a href={c.linkedinUrl} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-primary hover:underline">LinkedIn profile</a></Row>}
                <dl className="grid grid-cols-2 gap-3 border-t border-line pt-3">
                  <div><dt className="text-xs text-muted">Experience</dt><dd>{c.experienceYears != null ? `${c.experienceYears} years` : '—'}</dd></div>
                  <div><dt className="text-xs text-muted">Source</dt><dd>{SOURCE_LABEL[c.source] ?? c.source}</dd></div>
                  <div><dt className="text-xs text-muted">Added</dt><dd>{date(c.createdAt)}</dd></div>
                </dl>
              </CardBody>
            </Card>
            <div className="space-y-4">
              <Card>
                <CardHeader title="Applications" description={`${c.applications.length} in total`} />
                {c.applications.length === 0 ? <CardBody className="text-sm text-muted">No applications.</CardBody> : (
                  <ul className="divide-y divide-line">
                    {c.applications.map((a) => (
                      <li key={a.id}>
                        <button type="button" onClick={() => setViewing(a.id)} className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left hover:bg-slate-50">
                          <span className="min-w-0"><span className="block font-medium text-ink">{a.recruitment.title}</span>
                            <span className="block text-xs text-muted">{a.position?.title ? `${a.position.title} · ` : ''}Applied {date(a.appliedAt)} · {a.reference}</span></span>
                          <span className="flex items-center gap-2"><StageBadge name={a.stage.name} type={a.stage.type} /><ApplicationStatusBadge status={a.status} /></span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card>
                <CardHeader title="Documents" />
                {c.documents.length === 0 ? <CardBody className="text-sm text-muted">No documents.</CardBody> : (
                  <ul className="divide-y divide-line">
                    {c.documents.map((d) => (
                      <li key={d.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                        <span className="min-w-0"><span className="block truncate font-medium text-ink">{d.fileName}</span>
                          <span className="text-xs text-muted">{d.kind === 'resume' ? 'Resume' : 'Photo'} · {formatBytes(d.byteSize)} · {date(d.uploadedAt)}</span></span>
                        <a href={d.url} download className="inline-flex items-center gap-1.5 text-primary hover:underline"><Download className="size-4" aria-hidden />Download</a>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </div>
          {viewing !== null && <ApplicationDialog applicationId={viewing} onClose={() => setViewing(null)} />}
          {editing && <EditCandidateDialog candidate={c} onClose={() => setEditing(false)} />}
        </>
      )}
    </>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <p className="flex items-start gap-2.5"><span className="mt-0.5 text-slate-400" aria-hidden>{icon}</span><span className="min-w-0">{children}</span></p>;
}

function EditCandidateDialog({ candidate: c, onClose }: { candidate: CandidateDetail; onClose: () => void }) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const [v, setV] = useState({ fullName: c.fullName, phone: c.phone ?? '', currentTitle: c.currentTitle ?? '', currentCompany: c.currentCompany ?? '',
    experienceYears: c.experienceYears != null ? String(c.experienceYears) : '', location: c.location ?? '', linkedinUrl: c.linkedinUrl ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((s) => ({ ...s, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => recruitmentApi.candidates.update(c.id, {
      fullName: v.fullName.trim(), phone: v.phone.trim() || null, currentTitle: v.currentTitle.trim() || null, currentCompany: v.currentCompany.trim() || null,
      experienceYears: v.experienceYears.trim() === '' ? null : Number(v.experienceYears), location: v.location.trim() || null,
      linkedinUrl: v.linkedinUrl.trim() || null, updatedAt: c.updatedAt,
    }),
    onSuccess: async () => { await invalidate(); notify({ tone: 'success', title: 'Candidate saved' }); onClose(); },
    onError: (e) => { if (isStale(e)) return setStale(true); const fe = fieldErrors(e); if (Object.keys(fe).length) setErrors(fe); else setFormError(errorText(e)); },
  });
  const submit = () => {
    const e: Record<string, string> = {};
    if (v.fullName.trim().length < 2) e.fullName = 'Enter at least 2 characters';
    if (v.phone.trim() && !/^\+?[0-9 ()-]{5,40}$/.test(v.phone.trim())) e.phone = 'Digits, spaces, +, ( ) and - only';
    if (v.experienceYears.trim() && !(Number(v.experienceYears) >= 0 && Number(v.experienceYears) <= 80)) e.experienceYears = 'Enter years between 0 and 80';
    if (v.linkedinUrl.trim() && !/^https?:\/\/\S+$/i.test(v.linkedinUrl.trim())) e.linkedinUrl = 'Enter a full link starting with https://';
    setErrors(e); setFormError(null);
    if (!Object.keys(e).length) save.mutate();
  };
  return (
    <Dialog open onClose={save.isPending ? () => undefined : onClose} size="md" title="Edit candidate" description="The email address identifies the candidate and cannot be changed."
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button onClick={submit} loading={save.isPending}>Save</Button></>}>
      <div className="space-y-4">
        {stale && <InlineAlert tone="warning" title="This candidate was changed by someone else">Close this window and reopen it to see the latest version.</InlineAlert>}
        {formError && <InlineAlert>{formError}</InlineAlert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Full name" required error={errors.fullName}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={v.fullName} onChange={set('fullName')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Phone" error={errors.phone}>{({ id, invalid, describedBy }) => <Input id={id} value={v.phone} onChange={set('phone')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Current role">{({ id }) => <Input id={id} value={v.currentTitle} onChange={set('currentTitle')} />}</Field>
          <Field label="Current company">{({ id }) => <Input id={id} value={v.currentCompany} onChange={set('currentCompany')} />}</Field>
          <Field label="Experience (years)" error={errors.experienceYears}>{({ id, invalid, describedBy }) => <Input id={id} inputMode="decimal" value={v.experienceYears} onChange={set('experienceYears')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
          <Field label="Location">{({ id }) => <Input id={id} value={v.location} onChange={set('location')} />}</Field>
          <Field label="LinkedIn" className="sm:col-span-2" error={errors.linkedinUrl}>{({ id, invalid, describedBy }) => <Input id={id} type="url" value={v.linkedinUrl} onChange={set('linkedinUrl')} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
        </div>
      </div>
    </Dialog>
  );
}


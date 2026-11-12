import { useState, type ReactNode } from 'react';
import { CalendarPlus, Download, Mail, Phone, Send, User } from 'lucide-react';
import { Link } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Field, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { Avatar } from '@/components/ui/Avatar';
import { recruitmentApi } from './api';
import { ApplicationStatusBadge, INTERVIEW_STATUS, MODE_LABEL, SOURCE_LABEL, StageBadge, Stars, useDates } from './common';
import { errorText, useApplication, useInvalidateRecruitment, useRecruitment, useRejectionReasonOptions } from './hooks';
import { InterviewDetailDialog, InterviewFormDialog } from './InterviewDialogs';
import type { Stage } from './types';

/** Ask why a candidate is rejected (reason list is configurable) and an optional note. */
export function RejectDialog({ open, count = 1, name, loading, onClose, onConfirm }: {
  open: boolean; count?: number; name?: string; loading?: boolean; onClose: () => void;
  onConfirm: (v: { rejectionReasonId: number | null; rejectionNote: string | null }) => void;
}) {
  const reasons = useRejectionReasonOptions(open);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const close = () => { setReason(''); setNote(''); onClose(); };
  return (
    <Dialog open={open} onClose={close} size="sm" title={count > 1 ? `Reject ${count} candidates?` : `Reject ${name ?? 'this candidate'}?`}
      description="They are moved to the Rejected stage and notified."
      footer={<>
        <Button variant="outline" onClick={close} disabled={loading}>Back</Button>
        <Button variant="destructive" loading={loading} onClick={() => onConfirm({ rejectionReasonId: reason ? Number(reason) : null, rejectionNote: note.trim() || null })}>Reject</Button>
      </>}>
      <div className="space-y-4">
        <Field label="Reason">
          {({ id }) => (
            <Select id={id} data-autofocus value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">No reason given</option>
              {reasons.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Visible to the hiring team only.">
          {({ id }) => <Textarea id={id} rows={3} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

interface MoveTarget { id: number; updatedAt: string; name: string }

/**
 * Moving a candidate to a stage. Rejecting asks for a reason and hiring asks
 * for confirmation; every other stage moves straight away. Render `dialogs`
 * once next to the caller.
 */
export function useStageMover() {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const [pending, setPending] = useState<{ app: MoveTarget; stage: Stage } | null>(null);

  const mutation = useMutation({
    mutationFn: (v: { app: MoveTarget; stage: Stage; rejectionReasonId?: number | null; rejectionNote?: string | null }) =>
      recruitmentApi.applications.move(v.app.id, { stageId: v.stage.id, updatedAt: v.app.updatedAt, rejectionReasonId: v.rejectionReasonId, rejectionNote: v.rejectionNote }),
    onSuccess: async (_d, v) => {
      await invalidate();
      setPending(null);
      notify({ tone: 'success', title: `${v.app.name} moved to ${v.stage.name}` });
    },
    onError: async (e) => {
      setPending(null);
      notify({ tone: 'error', title: errorText(e, 'Could not move the candidate') });
      await invalidate(); // a stale row refreshes so the next try works
    },
  });

  const move = (app: MoveTarget, stage: Stage) => {
    if (stage.stageType === 'rejected' || stage.stageType === 'hired') setPending({ app, stage });
    else mutation.mutate({ app, stage });
  };

  const dialogs: ReactNode = (
    <>
      <RejectDialog open={pending?.stage.stageType === 'rejected'} name={pending?.app.name} loading={mutation.isPending}
        onClose={() => setPending(null)} onConfirm={(v) => pending && mutation.mutate({ ...pending, ...v })} />
      <ConfirmDialog open={pending?.stage.stageType === 'hired'} onClose={() => setPending(null)} loading={mutation.isPending}
        title={`Hire ${pending?.app.name ?? 'candidate'}?`} description="This fills one of the open places for their job position." confirmLabel="Hire"
        onConfirm={() => pending && mutation.mutate(pending)} />
    </>
  );
  return { move, dialogs, busy: mutation.isPending };
}

/** Full view of one application: profile, answers, interviews, notes, history and the actions for it. */
export function ApplicationDialog({ applicationId, onClose }: { applicationId: number; onClose: () => void }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const { date, dateTime } = useDates();
  const q = useApplication(applicationId);
  const app = q.data;
  const rec = useRecruitment(app?.recruitment.id ?? null);
  const mover = useStageMover();
  const [note, setNote] = useState('');
  const [schedule, setSchedule] = useState(false);
  const [openInterview, setOpenInterview] = useState<number | null>(null);
  const canManage = can('recruitment.candidate.manage');
  const canSchedule = can('recruitment.interview.manage');

  const addNote = useMutation({
    mutationFn: () => recruitmentApi.applications.addNote(applicationId, note.trim()),
    onSuccess: async () => { setNote(''); await invalidate(); },
    onError: (e) => notify({ tone: 'error', title: errorText(e, 'Could not add the note') }),
  });
  const patch = useMutation({
    mutationFn: (b: { rating?: number | null; jobPositionId?: number | null }) => recruitmentApi.applications.patch(applicationId, { ...b, updatedAt: app!.updatedAt }),
    onSuccess: invalidate,
    onError: async (e) => { notify({ tone: 'error', title: errorText(e, 'Could not save') }); await invalidate(); },
  });

  return (
    <>
      <Dialog open={!schedule && openInterview === null} onClose={onClose} size="lg"
        title={app ? <span className="flex items-center gap-3"><Avatar name={app.candidate.name} src={app.photoUrl} size="md" />{app.candidate.name}</span> : 'Candidate'}
        description={app ? `${app.recruitment.title} · ${app.reference}` : undefined}>
        {q.isPending && <LoadingBlock rows={8} />}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {app && (
          <div className="space-y-6 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StageBadge name={app.stage.name} type={app.stage.type} />
              <ApplicationStatusBadge status={app.status} />
              <Badge>{SOURCE_LABEL[app.source] ?? app.source}</Badge>
              {app.rejection && <Badge tone="danger">{app.rejection.reason ?? 'No reason given'}</Badge>}
              <Link to={`/recruitment/candidates/${app.candidate.id}`} className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline" onClick={onClose}>
                <User className="size-3.5" aria-hidden />Full candidate profile
              </Link>
            </div>

            {canManage && rec.data && (
              <div className="grid gap-3 rounded-lg border border-line bg-slate-50/60 p-3 sm:grid-cols-3">
                <Field label="Stage">
                  {({ id }) => (
                    <Select id={id} value={app.stage.id} disabled={mover.busy}
                      onChange={(e) => { const s = rec.data!.stages.find((x) => x.id === Number(e.target.value)); if (s) mover.move({ id: app.id, updatedAt: app.updatedAt, name: app.candidate.name }, s); }}>
                      {rec.data!.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Job position" hint={!app.position && rec.data.vacancies.length > 1 ? 'Needed before hiring' : undefined}>
                  {({ id }) => (
                    <Select id={id} value={app.position?.id ?? ''} disabled={patch.isPending || app.status === 'hired'}
                      onChange={(e) => patch.mutate({ jobPositionId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Not set</option>
                      {rec.data!.vacancies.map((v) => <option key={v.jobPositionId} value={v.jobPositionId}>{v.title}</option>)}
                    </Select>
                  )}
                </Field>
                <Field label="Rating">
                  {() => <div className="pt-2"><Stars value={app.rating} onChange={(v) => patch.mutate({ rating: v })} label="Rating" /></div>}
                </Field>
              </div>
            )}

            <dl className="grid gap-3 sm:grid-cols-2">
              <Detail icon={<Mail className="size-4" />} label="Email"><a className="text-primary hover:underline" href={`mailto:${app.candidate.email}`}>{app.candidate.email}</a></Detail>
              <Detail icon={<Phone className="size-4" />} label="Phone">{app.candidate.phone ?? '—'}</Detail>
              <Detail label="Current role">{app.candidate.currentTitle ?? '—'}</Detail>
              <Detail label="Experience">{app.candidate.experienceYears != null ? `${app.candidate.experienceYears} years` : '—'}</Detail>
              <Detail label="Job position">{app.position?.title ?? '—'}</Detail>
              <Detail label="Applied">{dateTime(app.appliedAt)}</Detail>
            </dl>

            {app.resumeUrl && (
              <a href={app.resumeUrl} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-slate-50" download>
                <Download className="size-4" aria-hidden />Download resume
              </a>
            )}
            {app.rejection?.note && <InlineAlert tone="warning" title="Rejection note">{app.rejection.note}</InlineAlert>}
            {app.coverLetter && <Section title="Cover letter"><p className="whitespace-pre-wrap text-slate-700">{app.coverLetter}</p></Section>}
            {app.answers.length > 0 && (
              <Section title="Application answers">
                <dl className="space-y-2">
                  {app.answers.map((a) => (
                    <div key={a.questionId}><dt className="text-xs text-muted">{a.label}</dt><dd className="text-ink">{typeof a.value === 'boolean' ? (a.value ? 'Yes' : 'No') : String(a.value)}</dd></div>
                  ))}
                </dl>
              </Section>
            )}

            <Section title="Interviews" action={canSchedule && app.status === 'active' ? <Button size="sm" variant="outline" icon={<CalendarPlus className="size-4" />} onClick={() => setSchedule(true)}>Schedule</Button> : undefined}>
              {app.interviews.length === 0 ? <p className="text-muted">No interviews yet.</p> : (
                <ul className="divide-y divide-line rounded-lg border border-line">
                  {app.interviews.map((i) => (
                    <li key={i.id}>
                      <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left hover:bg-slate-50" onClick={() => setOpenInterview(i.id)}>
                        <span><span className="font-medium text-ink">{i.title}</span><span className="block text-xs text-muted">{dateTime(i.startsAt)} · {MODE_LABEL[i.mode]}</span></span>
                        <Badge tone={INTERVIEW_STATUS[i.status].tone}>{INTERVIEW_STATUS[i.status].label}</Badge>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Notes">
              {canManage && (
                <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) addNote.mutate(); }}>
                  <Textarea aria-label="Add a note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note for the hiring team" maxLength={4000} />
                  <Button type="submit" icon={<Send className="size-4" />} loading={addNote.isPending} disabled={!note.trim()} aria-label="Add note" />
                </form>
              )}
              {app.notes.length === 0 ? <p className="text-muted">No notes yet.</p> : (
                <ul className="space-y-2">
                  {app.notes.map((n) => (
                    <li key={n.id} className="rounded-lg bg-slate-50 p-3"><p className="whitespace-pre-wrap text-slate-700">{n.body}</p><p className="mt-1 text-xs text-muted">{n.by ?? 'Someone'} · {dateTime(n.at)}</p></li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="History">
              <ol className="space-y-2 border-l border-line pl-4">
                {app.history.map((h) => (
                  <li key={h.id} className="relative">
                    <span aria-hidden className="absolute top-1.5 -left-[1.28rem] size-2 rounded-full bg-slate-300" />
                    <p className="text-ink">{h.from ? <>{h.from} → <strong>{h.to}</strong></> : <>Entered <strong>{h.to}</strong></>}</p>
                    <p className="text-xs text-muted">{h.by ?? 'Applicant'} · {date(h.at)}{h.note ? ` · ${h.note}` : ''}</p>
                  </li>
                ))}
              </ol>
            </Section>
          </div>
        )}
      </Dialog>
      {mover.dialogs}
      {schedule && app && <InterviewFormDialog application={{ id: app.id, candidateName: app.candidate.name, recruitmentTitle: app.recruitment.title }} onClose={() => setSchedule(false)} />}
      {openInterview !== null && <InterviewDetailDialog interviewId={openInterview} onClose={() => setOpenInterview(null)} />}
    </>
  );
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-medium tracking-wide text-muted uppercase">{title}</h3>{action}</div>
      {children}
    </section>
  );
}
function Detail({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return <div><dt className="flex items-center gap-1 text-xs text-muted">{icon}{label}</dt><dd className="mt-0.5 text-ink">{children}</dd></div>;
}

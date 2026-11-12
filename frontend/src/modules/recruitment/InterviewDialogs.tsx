import { useState } from 'react';
import { CalendarClock, ExternalLink, MapPin, Pencil, Phone, Video } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { ReasonDialog } from '@/modules/leave/components/shared';
import { recruitmentApi } from './api';
import {
  EmployeePicker, INTERVIEW_STATUS, MODE_LABEL, RECOMMENDATION_LABEL, Stars, fromLocalInput, toLocalInput, useDates,
} from './common';
import { errorText, fieldErrors, isStale, useInterview, useInvalidateRecruitment } from './hooks';
import type { BusyConflict, InterviewDetail, InterviewMode, Recommendation } from './types';

const MODE_ICON = { video: Video, in_person: MapPin, phone: Phone } as const;

const pad = (n: number) => String(n).padStart(2, '0');
/** Next whole hour, as a datetime-local value. */
function nextHour(offsetHours = 0) {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1 + offsetHours);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

/** Schedule a new interview for an application, or edit a scheduled one. */
export function InterviewFormDialog({ application, interview, onClose, onSaved }: {
  application: { id: number; candidateName: string; recruitmentTitle: string };
  interview?: InterviewDetail | null;
  onClose: () => void;
  onSaved?: (i: InterviewDetail) => void;
}) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const { dateTime } = useDates();
  const [title, setTitle] = useState(interview?.title ?? 'Interview');
  const [startsAt, setStartsAt] = useState(interview ? toLocalInput(interview.startsAt) : nextHour());
  const [endsAt, setEndsAt] = useState(interview ? toLocalInput(interview.endsAt) : nextHour(1));
  const [mode, setMode] = useState<InterviewMode>(interview?.mode ?? 'video');
  const [location, setLocation] = useState(interview?.location ?? '');
  const [link, setLink] = useState(interview?.meetingLink ?? '');
  const [notes, setNotes] = useState(interview?.notes ?? '');
  const [interviewers, setInterviewers] = useState<number[]>(interview?.interviewers.map((i) => i.id) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<BusyConflict[] | null>(null);
  const [stale, setStale] = useState(false);

  const validate = () => {
    const e: Record<string, string> = {};
    if (title.trim().length < 2) e.title = 'Enter at least 2 characters';
    if (!startsAt) e.startsAt = 'Choose a start time';
    if (!endsAt) e.endsAt = 'Choose an end time';
    else if (startsAt && new Date(endsAt) <= new Date(startsAt)) e.endsAt = 'End time must be after the start time';
    if (mode === 'video' && !/^https?:\/\/\S+$/i.test(link.trim())) e.meetingLink = 'Add the meeting link (https://…)';
    if (mode === 'in_person' && !location.trim()) e.location = 'Add the location';
    if (!interviewers.length) e.interviewerIds = 'Choose at least one interviewer';
    return e;
  };

  const save = useMutation({
    mutationFn: (allowConflicts: boolean) => {
      const body = {
        title: title.trim(), startsAt: fromLocalInput(startsAt), endsAt: fromLocalInput(endsAt), mode,
        location: location.trim() || null, meetingLink: link.trim() || null, notes: notes.trim() || null, interviewerIds: interviewers, allowConflicts,
      };
      return interview
        ? recruitmentApi.interviews.update(interview.id, { ...body, updatedAt: interview.updatedAt })
        : recruitmentApi.interviews.create({ ...body, applicationId: application.id });
    },
    onSuccess: async (saved) => {
      await invalidate();
      notify({ tone: 'success', title: interview ? 'Interview updated' : 'Interview scheduled' });
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      if (isStale(e)) return setStale(true);
      if (e instanceof ApiError && e.code === 'INTERVIEWER_BUSY') return setConflicts(e.details?.conflicts ?? []);
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe);
      else setFormError(errorText(e));
    },
  });

  const submit = (allow: boolean) => {
    setFormError(null);
    setConflicts(null);
    const e = validate();
    setErrors(e);
    if (!Object.keys(e).length) save.mutate(allow);
  };

  return (
    <Dialog open onClose={save.isPending ? () => undefined : onClose} size="md"
      title={interview ? 'Edit interview' : 'Schedule interview'} description={`${application.candidateName} · ${application.recruitmentTitle}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button onClick={() => submit(false)} loading={save.isPending}>{interview ? 'Save' : 'Schedule'}</Button>
        </>
      }>
      <div className="space-y-4">
        {stale && <InlineAlert tone="warning" title="This interview was changed by someone else">Close this window and reopen the interview to see the latest version.</InlineAlert>}
        {formError && <InlineAlert>{formError}</InlineAlert>}
        {conflicts && (
          <InlineAlert tone="warning" title="An interviewer is already booked">
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {conflicts.map((c) => <li key={`${c.interviewId}-${c.employeeId}`}>{c.employee}: {c.title}, {dateTime(c.startsAt)}</li>)}
            </ul>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => submit(true)} loading={save.isPending}>Schedule anyway</Button>
          </InlineAlert>
        )}
        <Field label="Title" required error={errors.title}>
          {({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} aria-invalid={invalid} aria-describedby={describedBy} />}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts" required error={errors.startsAt}>
            {({ id, invalid, describedBy }) => (
              <Input id={id} type="datetime-local" value={startsAt} aria-invalid={invalid} aria-describedby={describedBy}
                onChange={(e) => {
                  const v = e.target.value;
                  // Keep the same length when the start moves.
                  if (startsAt && endsAt && v) {
                    const len = new Date(endsAt).getTime() - new Date(startsAt).getTime();
                    if (len > 0) setEndsAt(toLocalInput(new Date(new Date(v).getTime() + len).toISOString()));
                  }
                  setStartsAt(v);
                }} />
            )}
          </Field>
          <Field label="Ends" required error={errors.endsAt}>
            {({ id, invalid, describedBy }) => <Input id={id} type="datetime-local" value={endsAt} min={startsAt} onChange={(e) => setEndsAt(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy} />}
          </Field>
        </div>
        <Field label="Mode" required>
          {({ id }) => (
            <Select id={id} value={mode} onChange={(e) => setMode(e.target.value as InterviewMode)}>
              {(Object.keys(MODE_LABEL) as InterviewMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </Select>
          )}
        </Field>
        {mode === 'video' && (
          <Field label="Meeting link" required error={errors.meetingLink}>
            {({ id, invalid, describedBy }) => <Input id={id} type="url" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://meet.example.com/…" aria-invalid={invalid} aria-describedby={describedBy} />}
          </Field>
        )}
        {mode !== 'video' && (
          <Field label={mode === 'in_person' ? 'Location' : 'Dial-in details'} required={mode === 'in_person'} error={errors.location}>
            {({ id, invalid, describedBy }) => <Input id={id} value={location} onChange={(e) => setLocation(e.target.value)} maxLength={300} aria-invalid={invalid} aria-describedby={describedBy} />}
          </Field>
        )}
        <Field label="Interviewers" required error={errors.interviewerIds}>
          {({ id, invalid, describedBy }) => <EmployeePicker id={id} value={interviewers} onChange={(ids) => setInterviewers(ids)} max={10} invalid={invalid} describedBy={describedBy} selected={interview?.interviewers} />}
        </Field>
        <Field label="Notes for interviewers" error={errors.notes}>
          {({ id }) => <Textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** Rating, recommendation and comments from one interviewer. Re-opening edits the same feedback. */
export function FeedbackDialog({ interview, onClose }: { interview: InterviewDetail; onClose: () => void }) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const mine = interview.myFeedback;
  const [rating, setRating] = useState<number | null>(mine?.rating ?? null);
  const [rec, setRec] = useState<Recommendation | ''>(mine?.recommendation ?? '');
  const [strengths, setStrengths] = useState(mine?.strengths ?? '');
  const [concerns, setConcerns] = useState(mine?.concerns ?? '');
  const [comments, setComments] = useState(mine?.comments ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => recruitmentApi.interviews.feedback(interview.id, {
      rating: rating!, recommendation: rec as Recommendation, strengths: strengths.trim() || null, concerns: concerns.trim() || null, comments: comments.trim() || null,
    }),
    onSuccess: async () => { await invalidate(); notify({ tone: 'success', title: 'Feedback saved' }); onClose(); },
    onError: (e) => { const fe = fieldErrors(e); if (Object.keys(fe).length) setErrors(fe); else setFormError(errorText(e)); },
  });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!rating) e.rating = 'Rate the candidate from 1 to 5';
    if (!rec) e.recommendation = 'Choose a recommendation';
    setErrors(e);
    setFormError(null);
    if (!Object.keys(e).length) save.mutate();
  };
  return (
    <Dialog open onClose={save.isPending ? () => undefined : onClose} size="md" title="Interview feedback"
      description={`${interview.application.candidate.name} · ${interview.title}`}
      footer={<><Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button><Button onClick={submit} loading={save.isPending}>Save feedback</Button></>}>
      <div className="space-y-4">
        {formError && <InlineAlert>{formError}</InlineAlert>}
        <Field label="Overall rating" required error={errors.rating}>
          {() => <div className="pt-1"><Stars value={rating} onChange={setRating} label="Overall rating" /></div>}
        </Field>
        <Field label="Recommendation" required error={errors.recommendation}>
          {({ id, invalid }) => (
            <Select id={id} value={rec} aria-invalid={invalid} onChange={(e) => setRec(e.target.value as Recommendation)}>
              <option value="">Choose…</option>
              {(Object.keys(RECOMMENDATION_LABEL) as Recommendation[]).map((k) => <option key={k} value={k}>{RECOMMENDATION_LABEL[k]}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Strengths">{({ id }) => <Textarea id={id} rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} maxLength={3000} />}</Field>
        <Field label="Concerns">{({ id }) => <Textarea id={id} rows={3} value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={3000} />}</Field>
        <Field label="Other comments">{({ id }) => <Textarea id={id} rows={3} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={3000} />}</Field>
      </div>
    </Dialog>
  );
}

/** Everything about one interview, with the actions the viewer is allowed. */
export function InterviewDetailDialog({ interviewId, onClose }: { interviewId: number; onClose: () => void }) {
  const { can } = useAuth();
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const { dateTime } = useDates();
  const q = useInterview(interviewId);
  const [edit, setEdit] = useState(false);
  const [feedback, setFeedback] = useState(false);
  const [cancel, setCancel] = useState(false);
  const canManage = can('recruitment.interview.manage');

  const status = useMutation({
    mutationFn: (b: { status: 'completed' | 'cancelled' | 'no_show'; reason?: string }) =>
      recruitmentApi.interviews.setStatus(interviewId, { ...b, updatedAt: q.data!.updatedAt }),
    onSuccess: async (_d, v) => { await invalidate(); setCancel(false); notify({ tone: 'success', title: v.status === 'cancelled' ? 'Interview cancelled' : 'Interview updated' }); },
    onError: (e) => notify({ tone: 'error', title: errorText(e, 'Could not update the interview') }),
  });

  const i = q.data;
  const started = i ? new Date(i.startsAt).getTime() <= Date.now() : false;
  const Icon = i ? MODE_ICON[i.mode] : Video;

  return (
    <>
      <Dialog open={!edit && !feedback} onClose={onClose} size="md" title={i?.title ?? 'Interview'}
        description={i ? `${i.application.candidate.name} · ${i.application.recruitment.title}` : undefined}
        footer={i && (
          <>
            {canManage && i.status === 'scheduled' && (
              <>
                <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => setEdit(true)}>Edit</Button>
                <Button variant="outline" onClick={() => setCancel(true)}>Cancel interview</Button>
                {started && <Button variant="outline" loading={status.isPending} onClick={() => status.mutate({ status: 'no_show' })}>Mark no-show</Button>}
                {started && <Button loading={status.isPending} onClick={() => status.mutate({ status: 'completed' })}>Mark completed</Button>}
              </>
            )}
            {i.canGiveFeedback && <Button onClick={() => setFeedback(true)}>{i.myFeedback ? 'Edit my feedback' : 'Give feedback'}</Button>}
          </>
        )}>
        {q.isPending && <LoadingBlock rows={5} />}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {i && (
          <div className="space-y-5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={INTERVIEW_STATUS[i.status].tone}>{INTERVIEW_STATUS[i.status].label}</Badge>
              <Badge icon={<Icon className="size-3" />}>{MODE_LABEL[i.mode]}</Badge>
              <Badge>{i.application.stageName}</Badge>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Info label="When" value={<span className="inline-flex items-center gap-1.5"><CalendarClock className="size-4 text-muted" aria-hidden />{dateTime(i.startsAt)} – {dateTime(i.endsAt)}</span>} />
              <Info label="Candidate" value={<>{i.application.candidate.name}<span className="block text-xs text-muted">{i.application.candidate.email}</span></>} />
              {i.meetingLink && <Info label="Meeting link" value={<a href={i.meetingLink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary underline">Join<ExternalLink className="size-3" aria-hidden /></a>} />}
              {i.location && <Info label={i.mode === 'in_person' ? 'Location' : 'Details'} value={i.location} />}
              <Info label="Interviewers" value={<ul>{i.interviewers.map((p) => <li key={p.id}>{p.name}{p.hasFeedback && <span className="ml-1.5 text-xs text-green-700">· feedback in</span>}</li>)}</ul>} />
              {i.cancelReason && <Info label="Cancellation reason" value={i.cancelReason} />}
            </dl>
            {i.notes && <section><h3 className="mb-1 text-xs font-medium tracking-wide text-muted uppercase">Notes</h3><p className="whitespace-pre-wrap text-slate-700">{i.notes}</p></section>}
            <section>
              <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">Feedback</h3>
              {i.feedback.length === 0 ? (
                <p className="text-muted">{i.interviewers.some((p) => !p.hasFeedback) && !canManage && !i.myFeedback
                  ? 'Submit your feedback to see your colleagues’ feedback.' : 'No feedback yet.'}</p>
              ) : (
                <ul className="space-y-3">
                  {i.feedback.map((f) => (
                    <li key={f.id} className="rounded-lg border border-line p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium text-ink">{f.by}</span>
                        <span className="flex items-center gap-2"><Stars value={f.rating} /><Badge tone={f.recommendation.endsWith('yes') ? 'success' : 'danger'}>{RECOMMENDATION_LABEL[f.recommendation]}</Badge></span>
                      </div>
                      {f.strengths && <p className="mt-2"><span className="font-medium">Strengths: </span>{f.strengths}</p>}
                      {f.concerns && <p className="mt-1"><span className="font-medium">Concerns: </span>{f.concerns}</p>}
                      {f.comments && <p className="mt-1 text-slate-600">{f.comments}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Dialog>
      {edit && i && (
        <InterviewFormDialog application={{ id: i.application.id, candidateName: i.application.candidate.name, recruitmentTitle: i.application.recruitment.title }}
          interview={i} onClose={() => setEdit(false)} />
      )}
      {feedback && i && <FeedbackDialog interview={i} onClose={() => setFeedback(false)} />}
      <ReasonDialog open={cancel} title="Cancel this interview?" description="The candidate is notified." label="Reason" optional confirmLabel="Cancel interview"
        tone="destructive" loading={status.isPending} onClose={() => setCancel(false)} onConfirm={(reason) => status.mutate({ status: 'cancelled', reason })} />
    </>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs text-muted">{label}</dt><dd className="mt-0.5 text-ink">{value}</dd></div>;
}

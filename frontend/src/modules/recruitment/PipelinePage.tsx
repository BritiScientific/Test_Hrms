import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  BriefcaseBusiness, CalendarPlus, ChevronDown, Copy, Download, ExternalLink, LayoutGrid, List, Mail, Pencil, Plus, Power, Search, Settings2, ThumbsDown, UserCheck, UserPlus,
} from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Checkbox, Input, Select } from '@/components/ui/Field';
import { Menu } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/Toast';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { Pager } from '@/modules/leave/components/shared';
import { cn } from '@/utils/cn';
import { recruitmentApi } from './api';
import { AddCandidateDialog } from './AddCandidateDialog';
import { ApplicationDialog, RejectDialog, useStageMover } from './ApplicationDialog';
import { FilledMeter, StageBadge, Stars, useDates } from './common';
import { errorText, useApplications, useInvalidateRecruitment, useRecruitment, useRecruitments } from './hooks';
import { InterviewFormDialog } from './InterviewDialogs';
import { RecruitmentWizard } from './RecruitmentWizard';
import type { ApplicationRow, Recruitment, Stage } from './types';

const PAGE = 25;
const GRID_PAGE = 50;

export default function PipelinePage() {
  usePageTitle('Recruitment pipeline');
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<'list' | 'grid'>(() => {
    try { return localStorage.getItem('rec.pipeline.view') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  const [search, setSearch] = useState('');
  const [positionId, setPositionId] = useState('');
  const [wizard, setWizard] = useState<'new' | 'edit' | null>(null);
  const q = useDebounced(search.trim(), 300);

  const list = useRecruitments({ status: showClosed ? 'all' : 'open' });
  const requested = Number(params.get('r')) || null;
  const selectedId = list.data?.items.find((r) => r.id === requested)?.id ?? list.data?.items[0]?.id ?? null;
  const detail = useRecruitment(selectedId);
  const canManage = can('recruitment.manage');

  const choose = (id: number) => setParams((p) => { p.set('r', String(id)); return p; }, { replace: true });
  const setViewPersist = (v: 'list' | 'grid') => { setView(v); try { localStorage.setItem('rec.pipeline.view', v); } catch { /* ignore */ } };

  return (
    <>
      <PageHeader title="Pipeline" description="Follow every candidate from application to hire."
        actions={canManage && <Button icon={<Plus className="size-4" />} onClick={() => setWizard('new')}>Create recruitment</Button>} />

      {list.isPending && <Card className="p-4"><LoadingBlock rows={6} /></Card>}
      {list.isError && <Card><ErrorState error={list.error} onRetry={() => list.refetch()} /></Card>}

      {list.data && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-line p-3 sm:p-4">
            <div role="tablist" aria-label="Recruitments" className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1">
              {list.data.items.map((r) => (
                <button key={r.id} role="tab" type="button" aria-selected={r.id === selectedId} onClick={() => choose(r.id)}
                  className={cn('flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                    r.id === selectedId ? 'border-primary bg-primary-soft font-medium text-primary-dark' : 'border-line bg-surface text-slate-700 hover:bg-slate-50',
                    r.status === 'closed' && 'opacity-70')}>
                  <span className="tabular flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">{r.applicationCount}</span>
                  {r.title}
                  {r.status === 'closed' && <Badge>Closed</Badge>}
                </button>
              ))}
            </div>
            <label className="flex shrink-0 items-center gap-2 text-sm text-slate-600">
              <Checkbox checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show closed
            </label>
          </div>

          {list.data.items.length === 0 ? (
            <EmptyState icon={<BriefcaseBusiness />} title={showClosed ? 'No recruitments yet' : 'No open recruitments'}
              description={canManage ? 'Create a recruitment to open a vacancy and start receiving candidates.' : 'Ask a recruiter to create one.'}
              action={canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setWizard('new')}>Create recruitment</Button> : undefined} />
          ) : detail.isPending ? <div className="p-4"><LoadingBlock rows={6} /></div>
            : detail.isError ? <ErrorState error={detail.error} onRetry={() => detail.refetch()} />
              : detail.data && (
                <RecruitmentBoard key={detail.data.id} recruitment={detail.data} view={view} onView={setViewPersist}
                  search={search} onSearch={setSearch} debouncedSearch={q} positionId={positionId} onPosition={setPositionId}
                  onEdit={() => setWizard('edit')} />
              )}
        </Card>
      )}

      {wizard && (
        <RecruitmentWizard recruitment={wizard === 'edit' ? detail.data ?? null : null} onClose={() => setWizard(null)}
          onSaved={(r) => { setWizard(null); choose(r.id); }} />
      )}
    </>
  );
}

function RecruitmentBoard({ recruitment: r, view, onView, search, onSearch, debouncedSearch, positionId, onPosition, onEdit }: {
  recruitment: Recruitment; view: 'list' | 'grid'; onView: (v: 'list' | 'grid') => void;
  search: string; onSearch: (s: string) => void; debouncedSearch: string; positionId: string; onPosition: (s: string) => void; onEdit: () => void;
}) {
  const { can } = useAuth();
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const { date } = useDates();
  const canManage = can('recruitment.manage');
  const canCandidates = can('recruitment.candidate.manage');
  const [open, setOpen] = useState<Record<number, boolean>>(() => Object.fromEntries(r.stages.map((s) => [s.id, s.count > 0 && s.stageType !== 'rejected'])));
  const [viewing, setViewing] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [confirmStatus, setConfirmStatus] = useState(false);
  const mover = useStageMover();

  const status = useMutation({
    mutationFn: () => recruitmentApi.recruitments.setStatus(r.id, { status: r.status === 'open' ? 'closed' : 'open', updatedAt: r.updatedAt }),
    onSuccess: async (d) => { await invalidate(); setConfirmStatus(false); notify({ tone: 'success', title: d.status === 'closed' ? 'Recruitment closed' : 'Recruitment reopened' }); },
    onError: async (e) => { setConfirmStatus(false); notify({ tone: 'error', title: errorText(e, 'Could not change the status') }); await invalidate(); },
  });

  const publicUrl = `${window.location.origin}${r.publicPath}`;
  const copyLink = async () => {
    try { await navigator.clipboard.writeText(publicUrl); notify({ tone: 'success', title: 'Careers link copied' }); }
    catch { notify({ tone: 'info', title: publicUrl }); }
  };
  const live = r.isPublished && r.status === 'open';

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-slate-50/70 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{r.title}</h2>
          <p className="text-xs text-muted">{date(r.startDate)}{r.endDate ? ` – ${date(r.endDate)}` : ' – open-ended'}</p>
        </div>
        <FilledMeter filled={r.filled} total={r.totalVacancies} />
        <Badge tone={r.status === 'closed' ? 'neutral' : live ? 'success' : 'warning'}>{r.status === 'closed' ? 'Closed' : live ? 'Live on careers page' : 'Not published'}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input type="search" aria-label="Search candidates" placeholder="Search candidates" className="w-44 pl-9 sm:w-56" value={search} onChange={(e) => onSearch(e.target.value)} />
          </div>
          {r.vacancies.length > 1 && (
            <Select aria-label="Filter by job position" className="w-44" value={positionId} onChange={(e) => onPosition(e.target.value)}>
              <option value="">All positions</option>
              {r.vacancies.map((v) => <option key={v.jobPositionId} value={v.jobPositionId}>{v.title}</option>)}
            </Select>
          )}
          <div className="inline-flex overflow-hidden rounded-lg border border-line" role="group" aria-label="View">
            <Button variant={view === 'list' ? 'secondary' : 'ghost'} size="icon" className="rounded-none" aria-label="List view" aria-pressed={view === 'list'} onClick={() => onView('list')}><List className="size-4" /></Button>
            <Button variant={view === 'grid' ? 'secondary' : 'ghost'} size="icon" className="rounded-none" aria-label="Board view" aria-pressed={view === 'grid'} onClick={() => onView('grid')}><LayoutGrid className="size-4" /></Button>
          </div>
          <Menu label="Recruitment actions" items={[
            ...(canManage ? [{ key: 'edit', label: 'Edit recruitment', icon: <Pencil />, onSelect: onEdit }] : []),
            { key: 'copy', label: 'Copy careers link', icon: <Copy />, onSelect: copyLink, disabled: !live, hint: live ? undefined : 'Publish and keep the recruitment open to get a public link' },
            { key: 'open', label: 'Open careers page', icon: <ExternalLink />, onSelect: () => window.open(r.publicPath, '_blank', 'noopener'), disabled: !live },
            ...(canManage ? [{ key: 'status', label: r.status === 'open' ? 'Close recruitment' : 'Reopen recruitment', icon: <Power />, tone: (r.status === 'open' ? 'danger' : 'default') as 'danger' | 'default', onSelect: () => setConfirmStatus(true) }] : []),
          ]}
            trigger={(p) => <Button variant="outline" icon={<Settings2 className="size-4" />} {...p}>Actions</Button>} />
          {canCandidates && r.status === 'open' && <Button icon={<UserPlus className="size-4" />} onClick={() => setAdding(true)}>Add</Button>}
        </div>
      </div>

      {r.vacancies.some((v) => v.filled >= v.vacancies) && (
        <div className="border-b border-line p-3"><InlineAlert tone="info">Some positions are fully filled: {r.vacancies.filter((v) => v.filled >= v.vacancies).map((v) => v.title).join(', ')}.</InlineAlert></div>
      )}

      {view === 'list' ? (
        <div className="space-y-2 p-3 sm:p-4">
          {r.stages.map((s) => (
            <StageSection key={s.id} stage={s} stages={r.stages} recruitment={r} open={!!open[s.id]} search={debouncedSearch} positionId={positionId}
              onToggle={() => setOpen((o) => ({ ...o, [s.id]: !o[s.id] }))} onView={setViewing} mover={mover} />
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto p-3 sm:p-4">
          {r.stages.map((s) => <BoardColumn key={s.id} stage={s} recruitment={r} search={debouncedSearch} positionId={positionId} onView={setViewing} mover={mover} />)}
        </div>
      )}

      {mover.dialogs}
      {viewing !== null && <ApplicationDialog applicationId={viewing} onClose={() => setViewing(null)} />}
      {adding && <AddCandidateDialog recruitment={r} onClose={() => setAdding(false)} onAdded={(id) => { setAdding(false); setViewing(id); }} />}
      <ConfirmDialog open={confirmStatus} onClose={() => setConfirmStatus(false)} loading={status.isPending} tone={r.status === 'open' ? 'destructive' : 'primary'}
        title={r.status === 'open' ? 'Close this recruitment?' : 'Reopen this recruitment?'}
        description={r.status === 'open'
          ? 'It disappears from the careers page and stops taking applications. Candidates already in the pipeline stay where they are.'
          : 'It becomes open again. Publish it from Edit to show it on the careers page.'}
        confirmLabel={r.status === 'open' ? 'Close recruitment' : 'Reopen'} onConfirm={() => status.mutate()} />
    </div>
  );
}

type Mover = ReturnType<typeof useStageMover>;

function StageSection({ stage, stages, recruitment, open, search, positionId, onToggle, onView, mover }: {
  stage: Stage; stages: Stage[]; recruitment: Recruitment; open: boolean; search: string; positionId: string;
  onToggle: () => void; onView: (id: number) => void; mover: Mover;
}) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [bulkStage, setBulkStage] = useState('');
  const [interviewFor, setInterviewFor] = useState<ApplicationRow | null>(null);
  const { can } = useAuth();
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const canManage = can('recruitment.candidate.manage');
  const canSchedule = can('recruitment.interview.manage');
  const { date } = useDates();
  const query = useMemo(() => ({ recruitmentId: recruitment.id, stageId: stage.id, search: search || undefined, jobPositionId: positionId || undefined, page, limit: PAGE, sort: 'recent' }), [recruitment.id, stage.id, search, positionId, page]);
  const apps = useApplications(query, open);
  useEffect(() => setPage(1), [search, positionId]);
  useEffect(() => { if (!open) { setSelected(new Set()); setSelecting(false); } }, [open]);

  const rows = apps.data?.items ?? [];
  const allOn = rows.length > 0 && rows.every((x) => selected.has(x.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const bulk = useMutation({
    mutationFn: (v: { stageId: number; rejectionReasonId?: number | null; rejectionNote?: string | null }) => recruitmentApi.applications.bulkMove({ ids: [...selected], ...v }),
    onSuccess: async (res) => {
      await invalidate();
      setRejecting(false);
      setSelected(new Set(res.failed.map((f) => f.id)));
      if (res.failed.length) notify({ tone: 'error', title: `${res.moved.length} moved, ${res.failed.length} could not move`, description: res.failed[0].message });
      else { notify({ tone: 'success', title: `${res.moved.length} candidate${res.moved.length === 1 ? '' : 's'} moved` }); setSelecting(false); setBulkStage(''); }
    },
    onError: (e) => { setRejecting(false); notify({ tone: 'error', title: errorText(e, 'Could not move the candidates') }); },
  });
  const runBulk = () => {
    const target = stages.find((s) => s.id === Number(bulkStage));
    if (!target) return;
    if (target.stageType === 'rejected') setRejecting(true);
    else bulk.mutate({ stageId: target.id });
  };

  const empty = stage.count === 0 || (apps.data && apps.data.total === 0);

  return (
    <section className="rounded-lg border border-red-100/0">
      <h3>
        <button type="button" aria-expanded={open} onClick={onToggle}
          className="flex w-full items-center gap-3 rounded-lg border border-line bg-slate-50/80 px-3 py-2.5 text-left hover:bg-slate-100/70">
          <span className="tabular flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">{stage.count}</span>
          <span className="text-sm font-medium text-ink">{stage.name}</span>
          <StageTypeTag type={stage.stageType} name={stage.name} />
          <ChevronDown className={cn('ml-auto size-4 text-slate-500 transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {open && (
        <div className="mt-2 rounded-lg border border-line">
          {canManage && stage.count > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-line p-2.5">
              <Button size="sm" variant={selecting ? 'secondary' : 'outline'} aria-pressed={selecting} onClick={() => { setSelecting((v) => !v); setSelected(new Set()); }}>
                {selecting ? `Selected (${selected.size})` : 'Select'}
              </Button>
              {selecting && selected.size > 0 && (
                <>
                  <Select aria-label="Move selected to" className="h-8 w-44 text-sm" value={bulkStage} onChange={(e) => setBulkStage(e.target.value)}>
                    <option value="">Move to…</option>
                    {stages.filter((s) => s.id !== stage.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                  <Button size="sm" disabled={!bulkStage} loading={bulk.isPending} onClick={runBulk}>Move</Button>
                </>
              )}
            </div>
          )}
          {apps.isPending && !empty ? <div className="p-3"><LoadingBlock rows={3} /></div>
            : apps.isError ? <ErrorState error={apps.error} onRetry={() => apps.refetch()} />
              : empty ? <p className="px-4 py-6 text-center text-sm text-muted">{search || positionId ? 'No candidates match.' : 'No candidates in this stage.'}</p>
                : (
                  <>
                    <div className="hidden overflow-x-auto md:block">
                      <table className="w-full min-w-[46rem] text-left text-sm">
                        <caption className="sr-only">{stage.name} candidates</caption>
                        <thead className="border-b border-line text-xs font-medium tracking-wide text-muted uppercase">
                          <tr>
                            {selecting && <th scope="col" className="w-10 px-3 py-2"><Checkbox aria-label="Select all on this page" checked={allOn} indeterminate={!allOn && selected.size > 0}
                              onChange={() => setSelected(allOn ? new Set() : new Set(rows.map((x) => x.id)))} /></th>}
                            <th scope="col" className="px-3 py-2">Name</th><th scope="col" className="px-3 py-2">Email</th>
                            <th scope="col" className="px-3 py-2">Position</th><th scope="col" className="px-3 py-2">Applied</th>
                            <th scope="col" className="px-3 py-2">Stage</th><th scope="col" className="px-3 py-2 text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {rows.map((a) => (
                            <tr key={a.id} className="hover:bg-slate-50/60">
                              {selecting && <td className="px-3 py-2"><Checkbox aria-label={`Select ${a.candidate.name}`} checked={selected.has(a.id)} onChange={() => toggle(a.id)} /></td>}
                              <td className="px-3 py-2">
                                <button type="button" onClick={() => onView(a.id)} className="flex items-center gap-2 text-left font-medium text-ink hover:text-primary">
                                  <Avatar name={a.candidate.name} src={a.photoUrl} size="sm" />
                                  <span>{a.candidate.name}{a.rating ? <span className="ml-2 align-middle"><Stars value={a.rating} /></span> : null}</span>
                                </button>
                              </td>
                              <td className="px-3 py-2 text-slate-600">{a.candidate.email}</td>
                              <td className="px-3 py-2 text-slate-600">{a.position?.title ?? '—'}</td>
                              <td className="px-3 py-2 text-slate-600">{date(a.appliedAt)}</td>
                              <td className="px-3 py-2">
                                {canManage ? <StageSelect app={a} stages={stages} mover={mover} /> : <StageBadge name={a.stage.name} type={a.stage.type} />}
                              </td>
                              <td className="px-3 py-2"><RowActions app={a} stages={stages} mover={mover} canManage={canManage} canSchedule={canSchedule} onView={() => onView(a.id)} onSchedule={() => setInterviewFor(a)} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <ul className="divide-y divide-line md:hidden">
                      {rows.map((a) => (
                        <li key={a.id} className="space-y-2 p-3">
                          <div className="flex items-start gap-2">
                            {selecting && <Checkbox aria-label={`Select ${a.candidate.name}`} className="mt-1" checked={selected.has(a.id)} onChange={() => toggle(a.id)} />}
                            <button type="button" onClick={() => onView(a.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                              <Avatar name={a.candidate.name} src={a.photoUrl} size="sm" />
                              <span className="min-w-0"><span className="block truncate font-medium text-ink">{a.candidate.name}</span><span className="block truncate text-xs text-muted">{a.candidate.email}</span></span>
                            </button>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            {canManage ? <StageSelect app={a} stages={stages} mover={mover} /> : <StageBadge name={a.stage.name} type={a.stage.type} />}
                            <RowActions app={a} stages={stages} mover={mover} canManage={canManage} canSchedule={canSchedule} onView={() => onView(a.id)} onSchedule={() => setInterviewFor(a)} />
                          </div>
                        </li>
                      ))}
                    </ul>
                    {apps.data && <Pager total={apps.data.total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(o) => setPage(Math.floor(o / PAGE) + 1)} />}
                  </>
                )}
        </div>
      )}
      <RejectDialog open={rejecting} count={selected.size} loading={bulk.isPending} onClose={() => setRejecting(false)}
        onConfirm={(v) => bulk.mutate({ stageId: Number(bulkStage), ...v })} />
      {interviewFor && <InterviewFormDialog application={{ id: interviewFor.id, candidateName: interviewFor.candidate.name, recruitmentTitle: recruitment.title }} onClose={() => setInterviewFor(null)} />}
    </section>
  );
}

function StageTypeTag({ type, name }: { type: Stage['stageType']; name: string }) {
  if (type === 'hired') return <Badge tone="success">Hired</Badge>;
  if (type === 'rejected' && name.toLowerCase() !== 'rejected') return <Badge tone="danger">Rejected</Badge>;
  return null;
}

function StageSelect({ app, stages, mover }: { app: ApplicationRow; stages: Stage[]; mover: Mover }) {
  return (
    <Select aria-label={`Stage for ${app.candidate.name}`} className="h-8 w-40 text-sm" value={app.stage.id} disabled={mover.busy}
      onChange={(e) => { const s = stages.find((x) => x.id === Number(e.target.value)); if (s) mover.move({ id: app.id, updatedAt: app.updatedAt, name: app.candidate.name }, s); }}>
      {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </Select>
  );
}

function RowActions({ app, stages, mover, canManage, canSchedule, onView, onSchedule }: {
  app: ApplicationRow; stages: Stage[]; mover: Mover; canManage: boolean; canSchedule: boolean; onView: () => void; onSchedule: () => void;
}) {
  const reject = stages.find((s) => s.stageType === 'rejected');
  const hire = stages.find((s) => s.stageType === 'hired');
  const target = { id: app.id, updatedAt: app.updatedAt, name: app.candidate.name };
  return (
    <div className="flex items-center justify-end gap-0.5">
      <Button size="icon" variant="ghost" className="size-8" aria-label={`View ${app.candidate.name}`} title="View" onClick={onView}><Search className="size-4" /></Button>
      <a className="inline-flex size-8 items-center justify-center rounded-lg text-slate-600 hover:bg-slate-100" href={`mailto:${app.candidate.email}`} aria-label={`Email ${app.candidate.name}`} title="Email"><Mail className="size-4" /></a>
      {app.hasResume && <Button size="icon" variant="ghost" className="size-8" aria-label={`Resume of ${app.candidate.name}`} title="Resume" onClick={onView}><Download className="size-4" /></Button>}
      {canSchedule && app.status === 'active' && <Button size="icon" variant="ghost" className="size-8" aria-label={`Schedule interview with ${app.candidate.name}`} title="Schedule interview" onClick={onSchedule}><CalendarPlus className="size-4" /></Button>}
      {canManage && hire && app.status !== 'hired' && <Button size="icon" variant="ghost" className="size-8 text-green-700" aria-label={`Hire ${app.candidate.name}`} title="Hire" disabled={mover.busy} onClick={() => mover.move(target, hire)}><UserCheck className="size-4" /></Button>}
      {canManage && reject && app.status !== 'rejected' && <Button size="icon" variant="ghost" className="size-8 text-danger" aria-label={`Reject ${app.candidate.name}`} title="Reject" disabled={mover.busy} onClick={() => mover.move(target, reject)}><ThumbsDown className="size-4" /></Button>}
    </div>
  );
}

/** One stage as a board column; cards drag between columns (drop = move). */
function BoardColumn({ stage, recruitment, search, positionId, onView, mover }: {
  stage: Stage; recruitment: Recruitment; search: string; positionId: string; onView: (id: number) => void; mover: Mover;
}) {
  const { can } = useAuth();
  const { date } = useDates();
  const canManage = can('recruitment.candidate.manage');
  const [over, setOver] = useState(false);
  const query = useMemo(() => ({ recruitmentId: recruitment.id, stageId: stage.id, search: search || undefined, jobPositionId: positionId || undefined, page: 1, limit: GRID_PAGE, sort: 'recent' }), [recruitment.id, stage.id, search, positionId]);
  const apps = useApplications(query);
  return (
    <section aria-label={stage.name} className={cn('w-72 shrink-0 rounded-lg border bg-slate-50/70', over ? 'border-primary bg-primary-soft/50' : 'border-line')}
      onDragOver={(e) => { if (canManage) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault(); setOver(false);
        try {
          const d = JSON.parse(e.dataTransfer.getData('application/x-candidate'));
          if (d.stageId !== stage.id) mover.move({ id: d.id, updatedAt: d.updatedAt, name: d.name }, stage);
        } catch { /* not ours */ }
      }}>
      <h3 className="flex items-center gap-2 border-b border-line px-3 py-2 text-sm font-medium text-ink">
        <span className="tabular flex min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">{stage.count}</span>{stage.name}
      </h3>
      <ul className="max-h-[60vh] space-y-2 overflow-y-auto p-2">
        {apps.isPending && <li><LoadingBlock rows={2} /></li>}
        {apps.isError && <li className="p-2 text-xs text-danger">Could not load</li>}
        {apps.data?.items.length === 0 && <li className="px-2 py-4 text-center text-xs text-muted">Empty</li>}
        {apps.data?.items.map((a) => (
          <li key={a.id} draggable={canManage}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-candidate', JSON.stringify({ id: a.id, updatedAt: a.updatedAt, name: a.candidate.name, stageId: stage.id })); e.dataTransfer.effectAllowed = 'move'; }}
            className={cn('rounded-lg border border-line bg-surface p-2.5 shadow-xs', canManage && 'cursor-grab active:cursor-grabbing')}>
            <button type="button" onClick={() => onView(a.id)} className="flex w-full items-center gap-2 text-left">
              <Avatar name={a.candidate.name} src={a.photoUrl} size="sm" />
              <span className="min-w-0"><span className="block truncate text-sm font-medium text-ink">{a.candidate.name}</span><span className="block truncate text-xs text-muted">{a.position?.title ?? a.candidate.email}</span></span>
            </button>
            <div className="mt-2 flex items-center justify-between text-xs text-muted"><span>{date(a.appliedAt)}</span>{a.rating ? <Stars value={a.rating} /> : null}</div>
            {canManage && (
              <Select aria-label={`Move ${a.candidate.name} to stage`} className="mt-2 h-8 text-xs" value={a.stage.id} disabled={mover.busy}
                onChange={(e) => { const s = recruitment.stages.find((x) => x.id === Number(e.target.value)); if (s) mover.move({ id: a.id, updatedAt: a.updatedAt, name: a.candidate.name }, s); }}>
                {recruitment.stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

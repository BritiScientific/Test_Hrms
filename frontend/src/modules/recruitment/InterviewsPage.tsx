import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, MapPin, Phone, Video } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Field, Select } from '@/components/ui/Field';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { usePageTitle } from '@/hooks/usePageTitle';
import { DataTable, Pager, QueryState, type Column } from '@/modules/leave/components/shared';
import { INTERVIEW_STATUS, MODE_LABEL, useDates } from './common';
import { useInterviews, useRecruitments } from './hooks';
import { InterviewDetailDialog } from './InterviewDialogs';
import type { Interview } from './types';

const PAGE = 25;
type Scope = 'upcoming' | 'past' | 'all';
const ICON = { video: Video, in_person: MapPin, phone: Phone } as const;

/**
 * Interview schedule. Anyone with interview.view sees every interview; an
 * interviewer sees only the ones they are named on (the API enforces this).
 */
export default function InterviewsPage() {
  usePageTitle('Interviews');
  const { can } = useAuth();
  const { dateTime } = useDates();
  const seeAll = can('recruitment.interview.view') || can('recruitment.interview.manage');
  const [scope, setScope] = useState<Scope>('upcoming');
  const [mine, setMine] = useState(!seeAll);
  const [status, setStatus] = useState('all');
  const [recruitmentId, setRecruitmentId] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const recruitments = useRecruitments({ status: 'all' });
  useEffect(() => setPage(1), [scope, mine, status, recruitmentId]);

  // "now" is fixed per filter change so the query key is stable between renders.
  const now = useMemo(() => new Date().toISOString(), [scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const query = useMemo(() => ({
    from: scope === 'upcoming' ? now : undefined, to: scope === 'past' ? now : undefined,
    status, mine: mine || undefined, recruitmentId: recruitmentId || undefined, page, limit: PAGE,
  }), [scope, now, status, mine, recruitmentId, page]);
  const q = useInterviews(query);

  const columns: Column<Interview>[] = [
    { key: 'when', header: 'When', bare: true, render: (i) => (
      <button type="button" className="text-left" onClick={() => setOpen(i.id)}>
        <span className="block font-medium text-ink">{dateTime(i.startsAt)}</span>
        <span className="block text-xs text-muted">{i.title}</span>
      </button>
    ) },
    { key: 'cand', header: 'Candidate', render: (i) => <span><span className="block text-ink">{i.application.candidate.name}</span><span className="block text-xs text-muted">{i.application.recruitment.title}</span></span> },
    { key: 'mode', header: 'Mode', render: (i) => { const I = ICON[i.mode]; return <span className="inline-flex items-center gap-1.5 text-slate-600"><I className="size-4" aria-hidden />{MODE_LABEL[i.mode]}</span>; } },
    { key: 'who', header: 'Interviewers', render: (i) => <span className="text-slate-600">{i.interviewers.map((p) => p.name).join(', ')}</span> },
    { key: 'status', header: 'Status', render: (i) => <Badge tone={INTERVIEW_STATUS[i.status].tone}>{INTERVIEW_STATUS[i.status].label}</Badge> },
  ];

  return (
    <>
      <PageHeader title="Interviews" description="Schedules and feedback for every interview round. Schedule one from a candidate in the pipeline." />
      <Card className="overflow-hidden">
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Interview period" idBase="iv" active={scope} onChange={(k) => setScope(k as Scope)}
            tabs={[{ key: 'upcoming', label: 'Upcoming' }, { key: 'past', label: 'Past' }, { key: 'all', label: 'All' }]} />
        </div>
        <TabPanel active={scope} idBase="iv">
          <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-3">
            <Field label="Status" hideLabel>
              {({ id }) => (
                <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="all">All statuses</option>
                  {Object.entries(INTERVIEW_STATUS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Recruitment" hideLabel>
              {({ id }) => (
                <Select id={id} value={recruitmentId} onChange={(e) => setRecruitmentId(e.target.value)}>
                  <option value="">All recruitments</option>
                  {recruitments.data?.items.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </Select>
              )}
            </Field>
            {seeAll && (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" className="size-4 accent-primary" checked={mine} onChange={(e) => setMine(e.target.checked)} />Only interviews I take part in
              </label>
            )}
          </div>
          <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<CalendarClock />}
            emptyTitle={scope === 'upcoming' ? 'No upcoming interviews' : 'No interviews found'} emptyText="Interviews you schedule or are invited to appear here.">
            {(d) => (
              <>
                <DataTable caption="Interviews" columns={columns} rows={d.items} rowKey={(r) => r.id} minWidth="52rem" onRowClick={(r) => setOpen(r.id)} />
                <Pager total={d.total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(o) => setPage(Math.floor(o / PAGE) + 1)} />
              </>
            )}
          </QueryState>
        </TabPanel>
      </Card>
      {open !== null && <InterviewDetailDialog interviewId={open} onClose={() => setOpen(null)} />}
    </>
  );
}

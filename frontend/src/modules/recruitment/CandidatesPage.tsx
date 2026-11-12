import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Search, Users } from 'lucide-react';
import { PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Field, Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { DataTable, Pager, QueryState, type Column } from '@/modules/leave/components/shared';
import { SOURCE_LABEL, useDates } from './common';
import { useCandidates, useRecruitments } from './hooks';
import type { CandidateRow } from './types';

const PAGE = 25;

/** Central candidate directory: everyone who ever applied or was added, across recruitments. */
export default function CandidatesPage() {
  usePageTitle('Candidates');
  const { date } = useDates();
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('');
  const [recruitmentId, setRecruitmentId] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [page, setPage] = useState(1);
  const debounced = useDebounced(search.trim(), 300);
  useEffect(() => setPage(1), [debounced, source, recruitmentId, sort]);
  const recruitments = useRecruitments({ status: 'all' });
  const query = useMemo(() => ({ search: debounced || undefined, source: source || undefined, recruitmentId: recruitmentId || undefined, sort, page, limit: PAGE }), [debounced, source, recruitmentId, sort, page]);
  const q = useCandidates(query);

  const columns: Column<CandidateRow>[] = [
    { key: 'name', header: 'Candidate', bare: true, render: (c) => (
      <Link to={`/recruitment/candidates/${c.id}`} className="flex items-center gap-3 font-medium text-ink hover:text-primary">
        <Avatar name={c.fullName} size="sm" />
        <span className="min-w-0"><span className="block truncate">{c.fullName}</span><span className="block truncate text-xs font-normal text-muted">{c.email}</span></span>
      </Link>
    ) },
    { key: 'role', header: 'Current role', render: (c) => <span className="text-slate-600">{[c.currentTitle, c.currentCompany].filter(Boolean).join(' at ') || '—'}</span> },
    { key: 'exp', header: 'Experience', render: (c) => <span className="tabular text-slate-600">{c.experienceYears != null ? `${c.experienceYears} yrs` : '—'}</span> },
    { key: 'apps', header: 'Applications', render: (c) => (
      <span className="inline-flex items-center gap-2"><span className="tabular">{c.applicationCount}</span>{c.activeCount > 0 && <Badge tone="primary">{c.activeCount} active</Badge>}</span>
    ) },
    { key: 'source', header: 'Source', render: (c) => <span className="text-slate-600">{SOURCE_LABEL[c.source] ?? c.source}</span> },
    { key: 'added', header: 'Added', render: (c) => <span className="text-slate-600">{date(c.createdAt)}</span> },
  ];

  const filtered = !!(debounced || source || recruitmentId);
  return (
    <>
      <PageHeader title="Candidates" description="Everyone who has applied or been added, in one place." />
      <Card className="overflow-hidden">
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_12rem_16rem_10rem]">
          <Field label="Search candidates" hideLabel>
            {({ id }) => (
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                <Input id={id} type="search" className="pl-9" placeholder="Name, email, phone or role" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
            )}
          </Field>
          <Field label="Source" hideLabel>
            {({ id }) => (
              <Select id={id} value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">All sources</option>
                {Object.entries(SOURCE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
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
          <Field label="Sort" hideLabel>
            {({ id }) => (
              <Select id={id} value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'name')}>
                <option value="recent">Newest first</option><option value="name">Name A–Z</option>
              </Select>
            )}
          </Field>
        </div>
        <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={<Users />}
          emptyTitle={filtered ? 'No candidates match' : 'No candidates yet'} emptyText={filtered ? 'Try another search or filter.' : 'Candidates appear here when they apply or are added to a recruitment.'}>
          {(d) => (
            <>
              <DataTable caption="Candidates" columns={columns} rows={d.items} rowKey={(r) => r.id} minWidth="52rem" />
              <Pager total={d.total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(o) => setPage(Math.floor(o / PAGE) + 1)} />
            </>
          )}
        </QueryState>
      </Card>
    </>
  );
}

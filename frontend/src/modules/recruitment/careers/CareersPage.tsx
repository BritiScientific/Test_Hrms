import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight, Briefcase, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { LoadingBlock } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Input, Select } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { formatDate } from '@/utils/format';
import { careersApi } from '../api';
import { CareersMessage, useCareersOrg } from './CareersLayout';

/** /careers — every job currently open for applications. */
export default function CareersPage() {
  const [params, setParams] = useSearchParams();
  const org = params.get('org') ?? undefined;
  const { setOrg } = useCareersOrg();
  const [search, setSearch] = useState('');
  const department = params.get('department') ?? '';
  const debounced = useDebounced(search.trim(), 300);
  const q = useQuery({
    queryKey: ['careers', 'list', org, debounced, department],
    queryFn: () => careersApi.list({ org, search: debounced || undefined, department: department || undefined }),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const orgInfo = q.data?.organization;
  useEffect(() => { if (orgInfo) setOrg(orgInfo); }, [orgInfo, setOrg]);
  usePageTitle(orgInfo ? `Careers at ${orgInfo.name}` : 'Careers');

  if (q.isError) {
    const e = q.error;
    return e instanceof ApiError && (e.code === 'ORG_REQUIRED' || e.status === 404)
      ? <CareersMessage title={e.code === 'ORG_REQUIRED' ? 'Which company?' : 'Careers page not found'}>
        {e.code === 'ORG_REQUIRED' ? 'Open the careers link your recruiter shared with you.' : 'This careers page does not exist or is not available right now.'}
      </CareersMessage>
      : <CareersMessage title="We couldn’t load the jobs" action={<button type="button" className="text-sm font-medium text-primary hover:underline" onClick={() => q.refetch()}>Try again</button>}>
        {e instanceof ApiError ? e.message : 'Please try again in a moment.'}
      </CareersMessage>;
  }
  if (q.isPending) return <div className="mx-auto max-w-3xl"><LoadingBlock rows={6} label="Loading jobs" /></div>;

  const d = q.data;
  const filtered = !!(debounced || department);
  return (
    <div className="space-y-8">
      <section className="max-w-3xl">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{d.organization.headline ?? `Careers at ${d.organization.name}`}</h1>
        <p className="mt-2 text-muted">{d.organization.intro ?? 'Find a role that fits you and apply in a few minutes.'}</p>
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <Input type="search" aria-label="Search jobs" className="pl-9" placeholder="Search by title or skill" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {d.departments.length > 0 && (
          <Select aria-label="Department" className="sm:w-56" value={department}
            onChange={(e) => setParams((p) => { if (e.target.value) p.set('department', e.target.value); else p.delete('department'); return p; }, { replace: true })}>
            <option value="">All departments</option>
            {d.departments.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        )}
      </div>

      {d.jobs.length === 0 ? (
        <CareersMessage title={filtered ? 'No jobs match your search' : 'No open positions right now'}>
          {filtered ? 'Try different keywords or clear the department.' : 'Please check back soon.'}
        </CareersMessage>
      ) : (
        <ul className="space-y-3" aria-label="Open jobs">
          {d.jobs.map((j) => (
            <li key={j.slug}>
              <Link to={`/careers/${j.slug}`} className="group block rounded-xl border border-line bg-surface p-5 shadow-card transition-colors hover:border-primary/40">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-ink group-hover:text-primary">{j.title}</h2>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                      <span className="inline-flex items-center gap-1"><Briefcase className="size-3.5" aria-hidden />{j.positionTitles.join(', ')}</span>
                      {j.departments.length > 0 && <span>{j.departments.join(', ')}</span>}
                      <span>{j.openPlaces} {j.openPlaces === 1 ? 'opening' : 'openings'}</span>
                      {j.endDate && <span>Apply by {formatDate(j.endDate)}</span>}
                    </p>
                  </div>
                  <ArrowRight className="mt-1 size-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" aria-hidden />
                </div>
                {j.excerpt && <p className="mt-3 line-clamp-2 text-sm text-slate-600">{j.excerpt}</p>}
                {j.skills.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{j.skills.slice(0, 8).map((s) => <Badge key={s} tone="primary">{s}</Badge>)}</div>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

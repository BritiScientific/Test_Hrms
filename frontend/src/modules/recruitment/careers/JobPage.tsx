import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, Briefcase, CalendarDays } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { LoadingBlock } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { formatDate } from '@/utils/format';
import { careersApi } from '../api';
import { RichText } from '../common';
import { CareersMessage, useCareersOrg } from './CareersLayout';

/** /careers/:jobSlug — the full job description. */
export default function JobPage() {
  const slug = useParams().jobSlug ?? '';
  const { setOrg } = useCareersOrg();
  const q = useQuery({
    queryKey: ['careers', 'job', slug], queryFn: () => careersApi.job(slug),
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const org = q.data?.organization;
  useEffect(() => { if (org) setOrg(org); }, [org, setOrg]);
  usePageTitle(q.data ? `${q.data.job.title} · ${q.data.organization.name}` : 'Job');

  if (q.isPending) return <div className="mx-auto max-w-3xl"><LoadingBlock rows={8} label="Loading job" /></div>;
  if (q.isError) {
    const gone = q.error instanceof ApiError && q.error.status === 404;
    return (
      <CareersMessage title={gone ? 'This job is no longer open' : 'We couldn’t load this job'}
        action={<ButtonLink to="/careers" variant="outline">See all jobs</ButtonLink>}>
        {gone ? 'The position may have been filled or closed.' : 'Please try again in a moment.'}
      </CareersMessage>
    );
  }
  const { job, organization } = q.data;
  const back = `/careers?org=${encodeURIComponent(organization.slug)}`;
  return (
    <article className="mx-auto max-w-3xl">
      <Link to={back} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink"><ArrowLeft className="size-4" aria-hidden />All jobs</Link>
      <div className="rounded-xl border border-line bg-surface p-5 shadow-card sm:p-8">
        <h1 className="text-2xl font-semibold tracking-tight">{job.title}</h1>
        <ul className="mt-3 space-y-1.5 text-sm text-muted">
          {job.positions.map((p) => (
            <li key={p.id} className="flex items-center gap-2"><Briefcase className="size-4 shrink-0" aria-hidden />
              <span><span className="font-medium text-slate-700">{p.title}</span>{p.department ? ` · ${p.department}` : ''} · {p.openPlaces} {p.openPlaces === 1 ? 'opening' : 'openings'}</span></li>
          ))}
          <li className="flex items-center gap-2"><CalendarDays className="size-4 shrink-0" aria-hidden />{job.endDate ? `Apply by ${formatDate(job.endDate)}` : `Posted ${formatDate(job.startDate)}`}</li>
        </ul>
        {job.skills.length > 0 && <div className="mt-4 flex flex-wrap gap-1.5" aria-label="Skills">{job.skills.map((s) => <Badge key={s} tone="primary">{s}</Badge>)}</div>}
        <div className="mt-6 border-t border-line pt-6"><RichText text={job.description} className="text-[0.95rem]" /></div>
        <div className="mt-8"><ButtonLink to={`/careers/${job.slug}/apply`} size="lg">Apply now</ButtonLink></div>
      </div>
    </article>
  );
}

import { useLocation, useParams } from 'react-router';
import { CheckCircle2 } from 'lucide-react';
import { ButtonLink } from '@/components/ui/Button';
import { usePageTitle } from '@/hooks/usePageTitle';
import { useCareersOrg } from './CareersLayout';

interface AppliedState { reference?: string; jobTitle?: string; message?: string | null; org?: string }

/** /careers/:jobSlug/applied — confirmation. Reading it directly (no state) still shows a safe, generic message. */
export default function AppliedPage() {
  const slug = useParams().jobSlug ?? '';
  const s = (useLocation().state ?? {}) as AppliedState;
  const { org } = useCareersOrg();
  usePageTitle('Application received');
  const orgSlug = s.org ?? org?.slug;
  return (
    <div className="mx-auto max-w-lg rounded-xl border border-line bg-surface px-6 py-12 text-center shadow-card" role="status">
      <CheckCircle2 className="mx-auto size-12 text-success" aria-hidden />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Application received</h1>
      <p className="mt-2 text-sm text-slate-600">
        {s.jobTitle ? <>Thank you for applying for <strong>{s.jobTitle}</strong>.</> : 'Thank you for applying.'}{' '}
        {s.message ?? 'We will review your application and contact you if there is a match.'}
      </p>
      {s.reference && (
        <p className="mt-4 text-sm text-muted">Your reference: <span className="font-mono font-medium text-ink select-all">{s.reference}</span></p>
      )}
      <div className="mt-7 flex flex-col justify-center gap-2 sm:flex-row">
        <ButtonLink to={orgSlug ? `/careers?org=${encodeURIComponent(orgSlug)}` : '/careers'} variant="primary">See other jobs</ButtonLink>
        <ButtonLink to={`/careers/${slug}`} variant="outline">Back to this job</ButtonLink>
      </div>
    </div>
  );
}

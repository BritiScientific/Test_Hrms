import { Lock } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatDateTime } from '@/utils/format';
import { LogoUploader } from './components/LogoUploader';
import { ProfileForm } from './components/ProfileForm';
import { useOrgProfile } from './hooks';

const STATUS: Record<string, { tone: 'success' | 'warning' | 'neutral'; label: string }> = {
  active: { tone: 'success', label: 'Active' },
  onboarding: { tone: 'warning', label: 'Onboarding' },
  inactive: { tone: 'neutral', label: 'Inactive' },
};

export default function OrganizationProfilePage() {
  usePageTitle('Organization profile');
  const { can } = useAuth();
  const me = useMe();
  const q = useOrgProfile();
  const readOnly = !can('organization.update');

  return (
    <div>
      <PageHeader title="Organization profile" description="Identity, contact details, address and branding for your organization." />
      {q.isPending && <Card><CardBody><LoadingBlock rows={8} /></CardBody></Card>}
      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.data && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_20rem] 3xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-5 xl:order-2">
            <Card>
              <CardBody className="flex items-start gap-4">
                <Avatar name={q.data.displayName} src={q.data.logo?.url} square size="lg" />
                <div className="min-w-0">
                  <p className="truncate font-semibold text-ink">{q.data.displayName}</p>
                  <p className="truncate text-sm text-muted">{q.data.legalName ?? 'Legal name not set'}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={STATUS[q.data.status].tone}>{STATUS[q.data.status].label}</Badge>
                  </div>
                </div>
              </CardBody>
              <dl className="grid gap-3 border-t border-line px-4 py-4 text-sm sm:px-5">
                <div>
                  <dt className="text-xs text-muted">Tenant reference</dt>
                  <dd className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-ink">
                    {q.data.slug} <Lock className="size-3 text-slate-400" aria-label="read-only" />
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Last updated</dt>
                  <dd className="mt-0.5 text-ink">{formatDateTime(q.data.updatedAt, me.tenant.preferences)}</dd>
                </div>
              </dl>
            </Card>
            <Card>
              <CardHeader title="Branding" as="h3" />
              <CardBody><LogoUploader profile={q.data} readOnly={readOnly} /></CardBody>
            </Card>
          </div>
          <div className="min-w-0 xl:order-1">
            {readOnly && (
              <div className="mb-4"><InlineAlert tone="info">You can view this profile. Editing needs the <code>organization.update</code> permission.</InlineAlert></div>
            )}
            <ProfileForm profile={q.data} readOnly={readOnly} />
          </div>
        </div>
      )}
    </div>
  );
}

import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Card, CardBody } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { formatDateTime } from '@/utils/format';
import { PreferencesForm } from './components/PreferencesForm';
import { useOrgSettings } from './hooks';

export default function OrganizationPreferencesPage() {
  usePageTitle('Organization settings');
  const { can } = useAuth();
  const me = useMe();
  const q = useOrgSettings();
  const readOnly = !can('organization.settings.update');
  return (
    <div className="max-w-5xl 3xl:max-w-6xl">
      <PageHeader
        title="Organization settings"
        description="Timezone, language, date format, currency, financial year and working week."
        eyebrow={q.data?.updatedAt ? `Last updated ${formatDateTime(q.data.updatedAt, me.tenant.preferences)}` : undefined}
      />
      {readOnly && <div className="mb-4"><InlineAlert tone="info">You can view these settings. Changing them needs <code>organization.settings.update</code>.</InlineAlert></div>}
      {q.isPending && <Card><CardBody><LoadingBlock rows={8} /></CardBody></Card>}
      {q.isError && <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>}
      {q.data && <PreferencesForm settings={q.data} readOnly={readOnly} />}
    </div>
  );
}

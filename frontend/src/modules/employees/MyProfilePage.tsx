import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Sparkles, UserRound } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { employeesApi } from '@/services/employees-api';
import { formatDate } from '@/utils/format';
import { EmployeeForm } from './EmployeeForm';
import { ProfileChecklist, STATUS_LABEL, empKeys, employmentLabel } from './shared';

/** D — Self-service: the employee completes their own details; job details stay with HR. */
export default function MyProfilePage() {
  usePageTitle('My profile');
  const me = useMe();
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const q = useQuery({ queryKey: empKeys.mine, queryFn: employeesApi.mine, retry: false });

  if (q.isPending) return <Card><CardBody><LoadingBlock rows={10} /></CardBody></Card>;
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.code === 'NO_EMPLOYEE_RECORD') {
      return <Card><EmptyState icon={<UserRound />} title="No employee record" description="Your account is not linked to an employee record in this organization. HR can add one for you." /></Card>;
    }
    return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  }
  const e = q.data;
  const welcome = params.get('welcome') === '1' && !e.profile.completed;

  return (
    <div>
      <PageHeader title={welcome ? `Welcome to ${me.tenant.displayName}, ${e.fullName.split(' ')[0]}` : 'My profile'}
        description="Keep your personal details up to date. Job details are managed by HR." />
      {!e.profile.completed && (
        <div className="mb-5">
          <InlineAlert tone="info" title={welcome ? 'One last step' : 'Your profile is incomplete'}>
            Add the {e.profile.total - e.profile.done} missing detail{e.profile.total - e.profile.done === 1 ? '' : 's'} below — it takes about two minutes.
          </InlineAlert>
        </div>
      )}
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 space-y-5 xl:order-2">
          <Card>
            <CardHeader title="Your progress" as="h2" actions={e.profile.completed ? <Badge tone="success" icon={<Sparkles className="size-3" aria-hidden />}>Complete</Badge> : undefined} />
            <CardBody><ProfileChecklist employee={e} audience="self" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Job details" as="h2" description="Ask HR to change these." />
            <dl className="grid gap-3 px-4 py-4 text-sm sm:px-5">
              {[
                ['Employee code', e.employeeCode],
                ['Job title', e.jobTitle ?? '—'],
                ['Department', e.department?.name ?? '—'],
                ['Reports to', e.manager?.name ?? '—'],
                ['Joined', formatDate(e.dateOfJoining, me.tenant.preferences)],
                ['Employment', `${STATUS_LABEL[e.status]} · ${employmentLabel(e.employmentType)}`],
                ['Work email', e.workEmail],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="break-words text-ink">{v}</dd></div>
              ))}
            </dl>
          </Card>
        </div>
        <div className="min-w-0 xl:order-1">
          <EmployeeForm employee={e} mode="self"
            onSave={async (patch) => {
              const saved = await employeesApi.updateMine(patch);
              qc.setQueryData(empKeys.mine, saved);
              await refresh();
              return saved;
            }} />
        </div>
      </div>
    </div>
  );
}

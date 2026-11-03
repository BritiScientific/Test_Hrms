import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { ArrowRight, CheckCircle2, Circle, ClipboardCheck, KeyRound, ShieldCheck, Users } from 'lucide-react';
import { PERMS, useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader, Skeleton } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { employeesApi } from '@/services/employees-api';
import { rbacApi } from '@/services/rbac-api';
import { auditActionLabel, groupByModule } from '@/utils/permissions';
import { greeting, relativeTime } from '@/utils/format';
import { useOnboardingStatus } from '../organization/hooks';

/**
 * Only metrics backed by implemented APIs are shown. Attendance, payroll and
 * other module widgets arrive with those modules — nothing here is invented.
 */
export default function DashboardPage() {
  usePageTitle('Dashboard');
  const me = useMe();
  const { canAny } = useAuth();
  const canRoles = canAny(...PERMS.rolesView);
  const canAudit = canAny(...PERMS.audit);

  const tasks = useQuery({ queryKey: ['workflows', 'my-tasks'], queryFn: rbacApi.myTasks });
  const { can } = useAuth();
  const canEmployees = can('employee.view');
  const members = useQuery({ queryKey: ['users', 'count'], queryFn: () => rbacApi.users({ limit: 1 }), enabled: canRoles && !canEmployees });
  const employees = useQuery({ queryKey: ['employees', 'count'], queryFn: () => employeesApi.list({ limit: 1 }), enabled: canEmployees });
  const pending = useQuery({ queryKey: ['employees', 'pending-activation'], queryFn: () => employeesApi.list({ limit: 1, access: 'invited' }), enabled: canEmployees });
  const roles = useQuery({ queryKey: ['roles'], queryFn: rbacApi.roles, enabled: canRoles });
  const firstName = me.user.fullName.split(' ')[0];

  return (
    <div>
      <PageHeader
        title={`${greeting(me.tenant.preferences.timezone)}, ${firstName}`}
        description={`Here is what’s happening at ${me.tenant.displayName}.`}
      />

      {!me.tenant.onboardingCompleted && <SetupBanner />}
      {me.employee && !me.employee.profileCompleted && (
        <div className="mb-5 flex flex-col gap-3 rounded-card border border-amber-200 bg-warning-soft px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <div className="min-w-0 flex-1">
            <p className="font-medium text-amber-950">Complete your profile</p>
            <p className="text-sm text-amber-900/80">
              {me.employee.profileProgress.total - me.employee.profileProgress.done} of your personal details are still missing.
            </p>
          </div>
          <ButtonLink to="/my-profile" variant="outline" icon={<ArrowRight className="size-4" />}>Open my profile</ButtonLink>
        </div>
      )}

      <section aria-label="Key figures" className="grid grid-cols-1 gap-4 xs:grid-cols-2 xl:grid-cols-4 2xl:gap-5">
        <Kpi icon={<ClipboardCheck />} label="Pending approvals" hint="Waiting for your action"
          value={tasks.data?.length} loading={tasks.isPending} error={tasks.isError} />
        {canEmployees ? (
          <Kpi icon={<Users />} label="Employees" hint={pending.data?.total ? `${pending.data.total} awaiting activation` : 'Current staff'}
            value={employees.data?.total} loading={employees.isPending} error={employees.isError} to="/employees" />
        ) : canRoles && (
          <Kpi icon={<Users />} label="Organization members" hint="People with portal access"
            value={members.data?.total} loading={members.isPending} error={members.isError} to="/settings/access/assignments" />
        )}
        {canRoles && (
          <Kpi icon={<ShieldCheck />} label="Active roles" hint={roles.data ? `${roles.data.filter((r) => !r.is_system_role).length} custom` : undefined}
            value={roles.data?.filter((r) => r.is_active).length} loading={roles.isPending} error={roles.isError} to="/settings/access/roles" />
        )}
        <Kpi icon={<KeyRound />} label="Your permissions" hint="Effective right now" value={me.permissions.length}
          to={`/settings/access/users/${me.userId}/permissions`} />
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-3 2xl:mt-6 2xl:gap-6">
        <div className="min-w-0 xl:col-span-2">
          {canAudit ? <RecentActivity /> : <YourAccess />}
        </div>
        <div className="min-w-0 space-y-5">
          <SetupProgress />
          {canAudit && <YourAccess />}
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, hint, loading, error, to }: {
  icon: ReactNode; label: string; value?: number; hint?: string; loading?: boolean; error?: boolean; to?: string;
}) {
  const body = (
    <CardBody className="flex items-start gap-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&>svg]:size-5" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        {loading ? <Skeleton className="mt-1.5 h-7 w-14" /> : (
          <p className="mt-0.5 text-2xl font-semibold tracking-tight text-ink tabular 3xl:text-3xl">{error ? '—' : value ?? 0}</p>
        )}
        {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
      </div>
    </CardBody>
  );
  return (
    <Card className={to ? 'transition-shadow hover:shadow-pop' : undefined}>
      {to ? <Link to={to} className="block rounded-card">{body}</Link> : body}
    </Card>
  );
}

function SetupBanner() {
  const { can } = useAuth();
  return (
    <div className="mb-5 flex flex-col gap-3 rounded-card border border-blue-200 bg-primary-soft px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-blue-950">Finish setting up your organization</p>
        <p className="text-sm text-blue-900/80">Add your organization details and regional preferences so the portal works the way you do.</p>
      </div>
      {can('organization.update') && <ButtonLink to="/onboarding" icon={<ArrowRight className="size-4" />}>Continue setup</ButtonLink>}
    </div>
  );
}

function SetupProgress() {
  const status = useOnboardingStatus();
  const { can } = useAuth();
  return (
    <Card>
      <CardHeader title="Organization setup" as="h2"
        actions={status.data?.completed ? <Badge tone="success">Complete</Badge> : status.data ? <Badge tone="warning">In progress</Badge> : undefined} />
      <CardBody>
        {status.isPending && <LoadingBlock rows={4} />}
        {status.isError && <ErrorState error={status.error} onRetry={() => status.refetch()} />}
        {status.data && (
          <>
            <div className="mb-4">
              <div className="mb-1.5 flex justify-between text-xs text-muted">
                <span>{status.data.progress.done} of {status.data.progress.total} items</span>
                <span className="tabular">{Math.round((status.data.progress.done / status.data.progress.total) * 100)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Setup progress"
                aria-valuemin={0} aria-valuemax={status.data.progress.total} aria-valuenow={status.data.progress.done}>
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(status.data.progress.done / status.data.progress.total) * 100}%` }} />
              </div>
            </div>
            <ul className="space-y-2.5">
              {status.data.steps.map((s) => (
                <li key={s.key} className="flex items-center gap-2.5 text-sm">
                  {s.done ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-slate-300" aria-label="Not done" />}
                  <span className={s.done ? 'text-slate-600' : 'text-ink'}>{s.label}</span>
                  {s.optional && <span className="text-xs text-muted">optional</span>}
                </li>
              ))}
            </ul>
            {!status.data.completed && can('organization.update') && (
              <ButtonLink to="/onboarding" variant="outline" size="sm" className="mt-4 w-full">Continue setup</ButtonLink>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

function RecentActivity() {
  const me = useMe();
  const q = useQuery({ queryKey: ['audit', 'recent'], queryFn: () => rbacApi.auditEvents({ limit: 8 }) });
  return (
    <Card className="h-full">
      <CardHeader title="Recent administrative activity" description="Role, access and organization changes"
        actions={<Link to="/settings/security" className="text-sm font-medium text-primary hover:underline">View all</Link>} />
      {q.isPending && <CardBody><LoadingBlock rows={6} /></CardBody>}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.items.length === 0 && <EmptyState title="No activity yet" description="Changes to roles, access and the organization profile will appear here." />}
      {q.data && q.data.items.length > 0 && (
        <ul className="divide-y divide-line">
          {q.data.items.map((e) => (
            <li key={`${e.category}-${e.id}`} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <span className={`mt-1.5 size-2 shrink-0 rounded-full ${e.category === 'rbac' ? 'bg-violet-500' : e.category === 'employee' ? 'bg-success' : 'bg-primary'}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink">
                  <span className="font-medium">{auditActionLabel(e.action)}</span>
                  {describeTarget(e.after_state ?? e.before_state)}
                </p>
                <p className="text-xs text-muted">
                  {e.actor_name ?? 'System'}{e.actor_user_id === me.userId && ' (you)'} · <time dateTime={e.at} title={e.at}>{relativeTime(e.at)}</time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function describeTarget(state: Record<string, unknown> | null): string {
  if (!state) return '';
  const name = state.name ?? state.displayName ?? state.email;
  return typeof name === 'string' ? ` · ${name}` : '';
}

function YourAccess() {
  const me = useMe();
  const groups = groupByModule(me.permissions.map((code) => ({ code, module: code.split('.')[0], description: '' })));
  return (
    <Card>
      <CardHeader title="Your access" description="What your current roles allow, by area"
        actions={<Link to={`/settings/access/users/${me.userId}/permissions`} className="text-sm font-medium text-primary hover:underline">Details</Link>} />
      <CardBody>
        {groups.length === 0 ? (
          <p className="text-sm text-muted">You have no permissions yet. Ask an administrator to assign you a role.</p>
        ) : (
          <ul className="space-y-2">
            {groups.map((g) => (
              <li key={g.module} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">{g.label}</span>
                <Badge tone="neutral" className="tabular">{g.permissions.length}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

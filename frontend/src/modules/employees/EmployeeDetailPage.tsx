import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { KeyRound, Link2, Mail } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { employeesApi } from '@/services/employees-api';
import { rbacApi } from '@/services/rbac-api';
import { formatDate, formatDateTime } from '@/utils/format';
import { auditActionLabel } from '@/utils/permissions';
import { AuditDiff } from '../security/AuditDiff';
import { EmployeeForm } from './EmployeeForm';
import { InviteLink } from './InviteLink';
import { AccessBadge, ProfileChecklist, STATUS_LABEL, empKeys, employmentLabel, useInvalidateEmployees } from './shared';

export default function EmployeeDetailPage() {
  const id = Number(useParams().employeeId);
  const me = useMe();
  const { can, canAny } = useAuth();
  const qc = useQueryClient();
  const invalidate = useInvalidateEmployees();
  const { notify } = useToast();
  const q = useQuery({ queryKey: empKeys.one(id), queryFn: () => employeesApi.get(id) });
  const audit = useQuery({
    queryKey: ['audit', 'employee', id],
    queryFn: () => rbacApi.auditEvents({ category: 'employee', targetType: 'employee', targetId: id, limit: 15 }),
    enabled: can('employee.view'),
  });
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [issuing, setIssuing] = useState(false);
  usePageTitle(q.data?.fullName ?? 'Employee');

  if (q.isPending) return <Card><CardBody><LoadingBlock rows={10} /></CardBody></Card>;
  if (q.isError) return <Card><ErrorState error={q.error} onRetry={() => q.refetch()} /></Card>;
  const e = q.data;
  const canInvite = can('employee.create') && e.status !== 'exited' && ['invited', 'invite_expired'].includes(e.access.status);

  const issue = async () => {
    setIssuing(true);
    try {
      setLink(await employeesApi.reissueInvitation(e.id));
      await invalidate();
    } catch (err) {
      notify({ tone: 'error', title: 'Could not create a link', description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setIssuing(false);
    }
  };

  return (
    <div>
      <Dialog open={!!link} onClose={() => setLink(null)} title="New activation link" size="lg"
        description="Any earlier link for this person has stopped working."
        footer={<Button onClick={() => setLink(null)}>Done</Button>}>
        {link && <InviteLink url={link.url} expiresAt={link.expiresAt} name={e.fullName} />}
      </Dialog>

      <PageHeader
        eyebrow={<Link to="/employees" className="hover:text-ink">Employees</Link>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Avatar name={e.fullName} size="lg" />
            <span className="min-w-0">
              <span className="block">{e.fullName}{e.preferredName && <span className="ml-2 text-base font-normal text-muted">“{e.preferredName}”</span>}</span>
              <span className="block text-sm font-normal text-muted">{e.employeeCode}{e.jobTitle && ` · ${e.jobTitle}`}{e.department && ` · ${e.department.name}`}</span>
            </span>
          </span>
        }
        actions={
          <>
            {canInvite && <Button variant="outline" icon={<Link2 className="size-4" />} loading={issuing} onClick={issue}>New activation link</Button>}
            {e.userId && canAny('roles.view', 'roles.assign') && (
              <ButtonLink variant="outline" to={`/settings/access/assignments?user=${e.userId}`} icon={<KeyRound className="size-4" />}>Roles</ButtonLink>
            )}
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0 xl:order-2 space-y-5">
          <Card>
            <CardHeader title="Profile completeness" as="h2" actions={e.profile.completed ? <Badge tone="success">Complete</Badge> : undefined} />
            <CardBody><ProfileChecklist employee={e} audience="hr" /></CardBody>
          </Card>
          <Card>
            <CardHeader title="Access" as="h2" actions={<AccessBadge status={e.access.status} />} />
            <dl className="grid gap-3 px-4 py-4 text-sm sm:px-5">
              <div><dt className="text-xs text-muted">Work email (sign-in)</dt><dd className="flex items-center gap-1.5 break-all"><Mail className="size-3.5 shrink-0 text-slate-400" aria-hidden />{e.workEmail}</dd></div>
              {e.access.inviteExpiresAt && (
                <div><dt className="text-xs text-muted">Activation link expires</dt><dd>{formatDateTime(e.access.inviteExpiresAt, me.tenant.preferences)}</dd></div>
              )}
              <div><dt className="text-xs text-muted">Employment</dt><dd>{STATUS_LABEL[e.status]} · {employmentLabel(e.employmentType)}</dd></div>
              <div><dt className="text-xs text-muted">Joined</dt><dd>{formatDate(e.dateOfJoining, me.tenant.preferences)}</dd></div>
              <div><dt className="text-xs text-muted">Reports to</dt><dd>{e.manager ? <Link className="text-primary hover:underline" to={`/employees/${e.manager.id}`}>{e.manager.name}</Link> : '—'}</dd></div>
            </dl>
          </Card>
          {can('employee.view') && (
            <Card>
              <CardHeader title="History" as="h2" />
              {audit.isPending && <CardBody><LoadingBlock rows={3} /></CardBody>}
              {audit.data && audit.data.items.length === 0 && <EmptyState title="No changes recorded" />}
              {audit.data && audit.data.items.length > 0 && (
                <ul className="max-h-[28rem] divide-y divide-line overflow-y-auto">
                  {audit.data.items.map((ev) => (
                    <li key={ev.id} className="px-4 py-3 sm:px-5">
                      <p className="text-sm font-medium">{auditActionLabel(ev.action)}</p>
                      <p className="text-xs text-muted">{ev.actor_name ?? 'System'} · {formatDateTime(ev.at, me.tenant.preferences)}</p>
                      <AuditDiff before={ev.before_state} after={ev.after_state} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
        <div className="min-w-0 xl:order-1">
          <EmployeeForm employee={e} mode="hr" readOnly={!can('employee.update')}
            onSave={async (patch) => {
              const saved = await employeesApi.update(e.id, patch);
              qc.setQueryData(empKeys.one(e.id), saved);
              await invalidate();
              return saved;
            }} />
        </div>
      </div>
    </div>
  );
}

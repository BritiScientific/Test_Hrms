import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Copy, KeyRound, Pencil, Power, ShieldCheck, Users } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { rbacApi } from '@/services/rbac-api';
import { formatDate, formatDateTime } from '@/utils/format';
import { auditActionLabel, groupByModule } from '@/utils/permissions';
import { AuditDiff } from '../security/AuditDiff';
import { TypeBadge } from './RolesListPage';
import { rbacKeys, useRole } from './hooks';
import { useRoleActions } from './useRoleActions';

export default function RoleDetailPage() {
  const id = Number(useParams().roleId);
  const me = useMe();
  const { can, canAny } = useAuth();
  const role = useRole(id);
  const members = useQuery({ queryKey: rbacKeys.members(id), queryFn: () => rbacApi.roleMembers(id) });
  const audit = useQuery({
    queryKey: rbacKeys.audit({ targetType: 'role', targetId: id }),
    queryFn: () => rbacApi.auditEvents({ targetType: 'role', targetId: id, limit: 20 }),
  });
  const actions = useRoleActions();
  usePageTitle(role.data?.name ?? 'Role');
  const canManage = can('roles.manage');

  if (role.isPending) return <Card><CardBody><LoadingBlock rows={8} /></CardBody></Card>;
  if (role.isError) return <Card><ErrorState error={role.error} onRetry={() => role.refetch()} /></Card>;
  const r = role.data;
  const groups = groupByModule(r.permissions);
  const roleLike = { ...r };

  return (
    <div>
      {actions.dialogs}
      <PageHeader
        eyebrow={<Link to="/settings/access/roles" className="hover:text-ink">Roles</Link>}
        title={<span className="flex flex-wrap items-center gap-2">{r.name} <TypeBadge system={r.is_system_role} /> <StatusBadge active={r.is_active} /></span>}
        description={r.description ?? 'No description'}
        actions={canManage && (
          <>
            {!r.is_system_role && <Button variant="outline" icon={<Pencil className="size-4" />} onClick={() => actions.edit(roleLike)}>Edit</Button>}
            <Button variant="outline" icon={<Copy className="size-4" />} onClick={() => actions.duplicate(roleLike)}>Duplicate</Button>
            {!r.is_system_role && (r.is_active
              ? <Button variant="outline" icon={<Power className="size-4" />} className="text-danger" onClick={() => actions.deactivate(roleLike)}>Deactivate</Button>
              : <Button variant="outline" icon={<Power className="size-4" />} onClick={() => actions.activate(roleLike)}>Re-activate</Button>)}
          </>
        )}
      />

      {r.is_system_role && (
        <div className="mb-5"><InlineAlert tone="info">This is a protected system role. Its name and permissions are managed by the platform and cannot be changed here.</InlineAlert></div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 space-y-5 xl:col-span-2">
          <Card>
            <CardHeader
              title="Permissions"
              description={`${r.permission_count} permission${r.permission_count === 1 ? '' : 's'} across ${groups.length} area${groups.length === 1 ? '' : 's'}`}
              actions={canAny('roles.view', 'roles.manage') && (
                <ButtonLink to={`/settings/access/roles/${r.id}/permissions`} size="sm" variant={canManage && !r.is_system_role ? 'primary' : 'outline'}
                  icon={<KeyRound className="size-4" />}>
                  {canManage && !r.is_system_role ? 'Manage permissions' : 'View matrix'}
                </ButtonLink>
              )}
            />
            {groups.length === 0 ? (
              <EmptyState icon={<KeyRound />} title="No permissions yet" description="People with only this role cannot do anything yet." />
            ) : (
              <div className="divide-y divide-line">
                {groups.map((g) => (
                  <div key={g.module} className="px-4 py-3.5 sm:px-5">
                    <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{g.label}</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {g.permissions.map((p) => (
                        <li key={p.code}><Badge tone="primary" className="font-normal"><span title={p.code}>{p.description}</span></Badge></li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Activity" description="Changes to this role" />
            {audit.isPending && <CardBody><LoadingBlock rows={3} /></CardBody>}
            {audit.isError && <ErrorState error={audit.error} />}
            {audit.data && audit.data.items.length === 0 && <EmptyState title="No recorded changes" />}
            {audit.data && audit.data.items.length > 0 && (
              <ul className="divide-y divide-line">
                {audit.data.items.map((e) => (
                  <li key={e.id} className="px-4 py-3 sm:px-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-medium">{auditActionLabel(e.action)}</p>
                      <time className="text-xs text-muted" dateTime={e.at}>{formatDateTime(e.at, me.tenant.preferences)}</time>
                    </div>
                    <p className="text-xs text-muted">by {e.actor_name ?? 'System'}</p>
                    <AuditDiff before={e.before_state} after={e.after_state} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Members" description={`${r.member_count} with this role today`}
              actions={can('roles.assign') && <ButtonLink to="/settings/access/assignments" size="sm" variant="outline" icon={<Users className="size-4" />}>Assign</ButtonLink>} />
            {members.isPending && <CardBody><LoadingBlock rows={3} /></CardBody>}
            {members.isError && <ErrorState error={members.error} />}
            {members.data && members.data.length === 0 && <EmptyState icon={<Users />} title="Nobody has this role" />}
            {members.data && members.data.length > 0 && (
              <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                {members.data.map((m) => (
                  <li key={m.assignment_id}>
                    <Link to={`/settings/access/assignments?user=${m.user_id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 sm:px-5">
                      <Avatar name={m.full_name} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{m.full_name}</span>
                        <span className="block truncate text-xs text-muted">{m.email}</span>
                      </span>
                      {m.scheduled && <Badge tone="warning">From {formatDate(m.effective_from, me.tenant.preferences)}</Badge>}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card>
            <CardHeader title="Details" as="h3" />
            <dl className="grid gap-3 px-4 py-4 text-sm sm:px-5">
              <div><dt className="text-xs text-muted">Created</dt><dd>{formatDateTime(r.created_at, me.tenant.preferences)}{r.created_by_name && ` by ${r.created_by_name}`}</dd></div>
              <div><dt className="text-xs text-muted">Last updated</dt><dd>{formatDateTime(r.updated_at, me.tenant.preferences)}</dd></div>
              <div><dt className="text-xs text-muted">Role ID</dt><dd className="font-mono text-[13px]">{r.id}</dd></div>
            </dl>
          </Card>
          <p className="flex items-start gap-2 px-1 text-xs text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Changes to a role apply to its members on their next request — no sign-out needed.
          </p>
        </div>
      </div>
    </div>
  );
}

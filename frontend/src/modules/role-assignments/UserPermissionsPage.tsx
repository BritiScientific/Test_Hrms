import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { Info, KeyRound, Search } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody } from '@/components/ui/Card';
import { Input } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { rbacApi } from '@/services/rbac-api';
import { groupByModule, matchesPermission } from '@/utils/permissions';
import { rbacKeys } from '../roles/hooks';

/**
 * Effective permission preview with the role(s) granting each permission.
 * Served by the same database view the API authorises with, so it cannot
 * drift from what the backend actually enforces.
 */
export default function UserPermissionsPage() {
  const userId = Number(useParams().userId);
  const me = useMe();
  const { canAny } = useAuth();
  const isSelf = userId === me.userId;
  const canSeeOthers = canAny('roles.view', 'roles.manage', 'roles.assign');
  const [query, setQuery] = useState('');

  const user = useQuery({ queryKey: rbacKeys.user(userId), queryFn: () => rbacApi.user(userId), enabled: canSeeOthers });
  const perms = useQuery({ queryKey: rbacKeys.effective(userId), queryFn: () => rbacApi.effectivePermissions(userId) });
  const name = isSelf ? me.user.fullName : user.data?.full_name;
  usePageTitle(name ? `${name} · effective permissions` : 'Effective permissions');

  const groups = useMemo(() => groupByModule((perms.data ?? []).filter((p) => matchesPermission(p, query))), [perms.data, query]);
  const roleCount = new Set((perms.data ?? []).flatMap((p) => p.sources.map((s) => s.roleId))).size;

  return (
    <div>
      <PageHeader
        eyebrow={canSeeOthers ? <Link to={`/settings/access/assignments?user=${userId}`} className="hover:text-ink">Role assignment</Link> : undefined}
        title={<span className="flex items-center gap-3">{name && <Avatar name={name} size="md" />}{isSelf ? 'Your effective permissions' : `Effective permissions${name ? ` · ${name}` : ''}`}</span>}
        description="Everything this person can do right now, and which role grants it."
      />
      <div className="mb-5 flex flex-col gap-3 rounded-card border border-blue-100 bg-primary-soft/60 p-4 text-sm text-blue-950 sm:flex-row">
        <Info className="size-4 shrink-0 text-primary" aria-hidden />
        <p>
          Effective permissions are the union of all roles that are active today. A permission granted by several roles stays until every one
          of them is removed. Inactive roles and future-dated assignments grant nothing yet.
        </p>
      </div>
      {perms.data && (
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative max-w-md flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter permissions" aria-label="Filter permissions" className="pl-9" />
          </div>
          <p className="text-sm text-muted tabular">{perms.data.length} permissions from {roleCount} role{roleCount === 1 ? '' : 's'}</p>
        </div>
      )}
      {perms.isPending && <Card><CardBody><LoadingBlock rows={8} /></CardBody></Card>}
      {perms.isError && <Card><ErrorState error={perms.error} onRetry={() => perms.refetch()} /></Card>}
      {perms.data && perms.data.length === 0 && (
        <Card><EmptyState icon={<KeyRound />} title="No effective permissions" description="Assign a role to give this person access." /></Card>
      )}
      <div className="grid gap-5 2xl:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.module}>
            <div className="flex items-center justify-between border-b border-line px-4 py-3 sm:px-5">
              <h2 className="font-semibold">{g.label}</h2>
              <Badge tone="primary" className="tabular">{g.permissions.length}</Badge>
            </div>
            <ul className="divide-y divide-line">
              {g.permissions.map((p) => (
                <li key={p.code} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:px-5">
                  <div className="min-w-0">
                    <p className="text-sm text-ink">{p.description}</p>
                    <code className="font-mono text-xs break-all text-muted">{p.code}</code>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-1 sm:justify-end" aria-label="Granted by">
                    {p.sources.map((s) => (
                      canSeeOthers
                        ? <Link key={s.roleId} to={`/settings/access/roles/${s.roleId}`}><Badge tone="violet">{s.roleName}</Badge></Link>
                        : <Badge key={s.roleId} tone="violet">{s.roleName}</Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}

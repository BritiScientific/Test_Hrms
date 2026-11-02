import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, KeyRound, Plus, Search, UserRound, X } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, InlineAlert, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Combobox } from '@/components/ui/Combobox';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Field, Input } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { rbacApi } from '@/services/rbac-api';
import type { DirectoryUser, UserRoleChip } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatDate } from '@/utils/format';
import { rbacKeys, useInvalidateRbac, useRoles } from '../roles/hooks';

const PAGE = 20;

function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * Assign roles to EXISTING members of this organization. Creating or editing
 * employees is Milestone 3 and intentionally not offered here.
 */
export default function AssignmentsPage() {
  usePageTitle('Role assignment');
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('user')) || null;
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const debounced = useDebounced(search);
  useEffect(() => setOffset(0), [debounced]);

  const users = useQuery({
    queryKey: rbacKeys.users({ search: debounced, offset }),
    queryFn: () => rbacApi.users({ search: debounced || undefined, limit: PAGE, offset }),
    placeholderData: keepPreviousData,
  });
  const select = (id: number | null) => setParams(id ? { user: String(id) } : {});

  return (
    <div>
      <PageHeader title="Role assignment" description="Find a member of your organization, then add or remove roles. Changes apply on their next request." />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {/* Directory: hidden on small screens while a user is open */}
        <Card className={cn('flex min-h-0 flex-col', !!selectedId && 'hidden lg:flex')}>
          <div className="border-b border-line p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name, email or employee code" aria-label="Search members" className="pl-9" />
            </div>
          </div>
          {users.isPending && <div className="p-4"><LoadingBlock rows={6} /></div>}
          {users.isError && <ErrorState error={users.error} onRetry={() => users.refetch()} />}
          {users.data && users.data.items.length === 0 && (
            <EmptyState icon={<UserRound />} title="No members found" description="Only existing members of this organization are listed." />
          )}
          {users.data && users.data.items.length > 0 && (
            <ul className="divide-y divide-line overflow-y-auto lg:max-h-[calc(100dvh-16rem)]" aria-label="Members">
              {users.data.items.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => select(u.id)}
                    aria-current={u.id === selectedId || undefined}
                    className={cn('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50',
                      u.id === selectedId && 'bg-primary-soft/60 hover:bg-primary-soft/60')}
                  >
                    <Avatar name={u.full_name} size="md" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{u.full_name}</span>
                        {u.membership_status !== 'active' && <Badge tone="warning">{u.membership_status}</Badge>}
                      </span>
                      <span className="block truncate text-xs text-muted">{u.email}{u.employee_code && ` · ${u.employee_code}`}</span>
                      <span className="mt-1.5 flex flex-wrap gap-1">
                        {u.roles.length === 0 && <span className="text-xs text-muted">No roles</span>}
                        {u.roles.map((r) => <Badge key={r.assignmentId} tone={r.roleActive ? 'neutral' : 'warning'}>{r.roleName}</Badge>)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {users.data && users.data.total > PAGE && (
            <div className="mt-auto flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs text-muted">
              <span className="tabular">{offset + 1}–{Math.min(offset + PAGE, users.data.total)} of {users.data.total}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" aria-label="Previous page" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
                  <ChevronLeft className="size-4" aria-hidden />
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next page" disabled={offset + PAGE >= users.data.total} onClick={() => setOffset((o) => o + PAGE)}>
                  <ChevronRight className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          )}
        </Card>

        <div className={cn('min-w-0', !selectedId && 'hidden lg:block')}>
          {selectedId
            ? <UserPanel key={selectedId} userId={selectedId} fromList={users.data?.items.find((u) => u.id === selectedId)} onBack={() => select(null)} />
            : (
              <Card><EmptyState icon={<UserRound />} title="Select a member" description="Choose someone from the list to see and change their roles." /></Card>
            )}
        </div>
      </div>
    </div>
  );
}

function UserPanel({ userId, fromList, onBack }: { userId: number; fromList?: DirectoryUser; onBack: () => void }) {
  const me = useMe();
  const { can } = useAuth();
  const canAssign = can('roles.assign');
  const roles = useRoles();
  const invalidate = useInvalidateRbac();
  const { notify } = useToast();
  const held = useMemo(() => new Set(me.permissions), [me.permissions]);

  const user = useQuery({
    queryKey: rbacKeys.user(userId),
    queryFn: () => rbacApi.user(userId),
    placeholderData: fromList,
  });

  const [roleId, setRoleId] = useState<string | null>(null);
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<UserRoleChip | null>(null);

  const current = user.data?.roles ?? [];
  const assignedRoleIds = new Set(current.map((c) => c.roleId));
  const options = (roles.data ?? [])
    .filter((r) => r.is_active && !assignedRoleIds.has(r.id))
    .map((r) => {
      const blocked = r.permissions.some((c) => !held.has(c));
      return { value: String(r.id), label: r.name, hint: blocked ? 'exceeds your access' : `${r.permission_count} perms`, disabled: blocked };
    });

  const add = async () => {
    if (!roleId) return;
    setBusy(true);
    setError(null);
    try {
      await rbacApi.assignRole(userId, { roleId: Number(roleId), effectiveFrom: from || undefined });
      await invalidate();
      notify({ tone: 'success', title: 'Role assigned' });
      setRoleId(null);
      setFrom('');
    } catch (e) {
      setError(e instanceof ApiError
        ? e.code === 'OVERLAP' ? 'This person already has that role for an overlapping period.'
          : e.code === 'PRIVILEGE_ESCALATION' ? 'You can only assign roles whose permissions you hold yourself.' : e.message
        : 'Could not assign the role.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await rbacApi.revokeRole(userId, removing.assignmentId);
      await invalidate();
      notify({ tone: 'success', title: `Removed “${removing.roleName}”` });
      setRemoving(null);
    } catch (e) {
      setRemoving(null);
      setError(e instanceof ApiError
        ? e.code === 'LOCKOUT' ? 'This would leave nobody able to manage roles, so the role was kept.' : e.message
        : 'Could not remove the role.');
    } finally {
      setBusy(false);
    }
  };

  if (user.isPending) return <Card><CardBody><LoadingBlock rows={6} /></CardBody></Card>;
  if (user.isError) return <Card><ErrorState error={user.error} onRetry={() => user.refetch()} /></Card>;
  const u = user.data;

  return (
    <div className="space-y-5">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink lg:hidden">
        <ArrowLeft className="size-4" aria-hidden /> All members
      </button>
      <Card>
        <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar name={u.full_name} size="lg" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-lg font-semibold">{u.full_name}{u.id === me.userId && <span className="ml-2 text-sm font-normal text-muted">(you)</span>}</h2>
            <p className="truncate text-sm text-muted">{u.email}{u.employee_code && ` · Employee ${u.employee_code}`}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <StatusBadge active={u.membership_status === 'active' && u.is_active} activeLabel="Active member" inactiveLabel={u.membership_status} />
            </div>
          </div>
          <ButtonLink to={`/settings/access/users/${u.id}/permissions`} variant="outline" size="sm" icon={<KeyRound className="size-4" />}>
            Effective permissions
          </ButtonLink>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Roles" description="A person’s access is the combination of all their active roles." />
        <CardBody className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          {current.length === 0 && <p className="text-sm text-muted">No roles assigned. This person can sign in but cannot do anything yet.</p>}
          <ul className="flex flex-wrap gap-2" aria-label="Assigned roles">
            {current.map((c) => (
              <li key={c.assignmentId} className={cn('inline-flex items-center gap-1.5 rounded-full border py-1 pl-3 text-sm',
                canAssign ? 'pr-1' : 'pr-3', c.roleActive ? 'border-line bg-slate-50' : 'border-amber-200 bg-warning-soft')}>
                <Link to={`/settings/access/roles/${c.roleId}`} className="font-medium hover:text-primary">{c.roleName}</Link>
                {!c.roleActive && <span className="text-xs text-amber-700">(role inactive)</span>}
                {c.scheduled && <span className="text-xs text-muted">from {formatDate(c.effectiveFrom, me.tenant.preferences)}</span>}
                {c.effectiveTo && <span className="text-xs text-muted">until {formatDate(c.effectiveTo, me.tenant.preferences)}</span>}
                {canAssign && (
                  <button type="button" onClick={() => setRemoving(c)} aria-label={`Remove ${c.roleName}`}
                    className="inline-flex size-6 items-center justify-center rounded-full text-slate-500 hover:bg-danger-soft hover:text-danger pointer-coarse:size-8">
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>

          {canAssign && (
            <div className="grid gap-3 border-t border-line pt-4 md:grid-cols-[minmax(0,1fr)_11rem_auto] md:items-end">
              <Field label="Add a role">
                {({ id }) => (
                  <Combobox id={id} value={roleId} onChange={setRoleId} options={options} placeholder="Search roles"
                    emptyText="No other active roles available" disabled={roles.isPending} />
                )}
              </Field>
              <Field label="Starts on" hint="Optional">
                {({ id, describedBy }) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-describedby={describedBy} />}
              </Field>
              <Button onClick={add} disabled={!roleId} loading={busy && !removing} icon={<Plus className="size-4" />} className="md:mb-[1.375rem]">Assign</Button>
            </div>
          )}
          {!canAssign && <InlineAlert tone="info">You can view roles here. Assigning roles needs the <code>roles.assign</code> permission.</InlineAlert>}
        </CardBody>
      </Card>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={remove}
        loading={busy}
        tone="destructive"
        title={`Remove “${removing?.roleName ?? ''}” from ${u.full_name}?`}
        confirmLabel="Remove role"
      >
        <p className="text-sm text-slate-700">
          {u.full_name} loses the permissions that come only from this role on their next request. The change is recorded in the audit log.
        </p>
      </ConfirmDialog>
    </div>
  );
}

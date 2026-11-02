import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Copy, Eye, KeyRound, Lock, MoreHorizontal, Pencil, Plus, Power, Search, ShieldCheck } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge, StatusBadge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select } from '@/components/ui/Field';
import { Menu, type MenuItem } from '@/components/ui/Menu';
import { usePageTitle } from '@/hooks/usePageTitle';
import type { RoleSummary } from '@/types/api';
import { formatDate } from '@/utils/format';
import { useRoles } from './hooks';
import { useRoleActions } from './useRoleActions';

export default function RolesListPage() {
  usePageTitle('Roles');
  const me = useMe();
  const { can } = useAuth();
  const canManage = can('roles.manage');
  const q = useRoles();
  const actions = useRoleActions();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | 'system' | 'custom'>('all');
  const [status, setStatus] = useState<'all' | 'active' | 'inactive'>('all');

  const roles = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((r) =>
      (!s || r.name.toLowerCase().includes(s) || (r.description ?? '').toLowerCase().includes(s))
      && (type === 'all' || (type === 'system') === r.is_system_role)
      && (status === 'all' || (status === 'active') === r.is_active));
  }, [q.data, search, type, status]);

  const summary = useMemo(() => {
    const all = q.data ?? [];
    return {
      active: all.filter((r) => r.is_active).length,
      custom: all.filter((r) => !r.is_system_role).length,
      assignments: all.reduce((n, r) => n + r.member_count, 0),
    };
  }, [q.data]);

  const menuFor = (r: RoleSummary): MenuItem[] => {
    const items: MenuItem[] = [
      { key: 'view', label: 'View details', icon: <Eye />, onSelect: () => navigate(`/settings/access/roles/${r.id}`) },
    ];
    if (canManage && !r.is_system_role) {
      items.push(
        { key: 'edit', label: 'Edit', icon: <Pencil />, onSelect: () => actions.edit(r) },
        { key: 'perms', label: 'Manage permissions', icon: <KeyRound />, onSelect: () => navigate(`/settings/access/roles/${r.id}/permissions`) },
      );
    }
    if (canManage) items.push({ key: 'dup', label: 'Duplicate', icon: <Copy />, onSelect: () => actions.duplicate(r) });
    if (canManage && !r.is_system_role) {
      items.push(r.is_active
        ? { key: 'deact', label: 'Deactivate', icon: <Power />, tone: 'danger', onSelect: () => actions.deactivate(r) }
        : { key: 'act', label: 'Re-activate', icon: <Power />, onSelect: () => actions.activate(r) });
    }
    return items;
  };

  return (
    <div>
      {actions.dialogs}
      <PageHeader
        title="Roles & permissions"
        description="Roles bundle permissions. Assign roles to people to control what they can see and do."
        actions={canManage && <ButtonLink to="/settings/access/roles/new" icon={<Plus className="size-4" />}>Create role</ButtonLink>}
      />

      {q.data && (
        <dl className="mb-5 grid grid-cols-1 gap-3 xs:grid-cols-3">
          {[['Active roles', summary.active], ['Custom roles', summary.custom], ['Role assignments', summary.assignments]].map(([label, value]) => (
            <div key={label} className="rounded-card border border-line bg-surface px-4 py-3 shadow-card">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="mt-0.5 text-xl font-semibold tabular">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <Card>
        <div className="flex flex-col gap-3 border-b border-line p-4 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search roles"
              aria-label="Search roles by name or description" className="pl-9" />
          </div>
          <div className="grid grid-cols-2 gap-3 md:w-80">
            <Select value={type} onChange={(e) => setType(e.target.value as typeof type)} aria-label="Filter by type">
              <option value="all">All types</option>
              <option value="custom">Custom</option>
              <option value="system">System</option>
            </Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Filter by status">
              <option value="all">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </Select>
          </div>
        </div>

        {q.isPending && <div className="p-4"><LoadingBlock rows={6} /></div>}
        {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && roles.length === 0 && (
          <EmptyState icon={<ShieldCheck />} title={q.data.length ? 'No roles match these filters' : 'No roles yet'}
            description={q.data.length ? 'Try clearing the search or filters.' : 'Create a role to start granting access.'} />
        )}

        {roles.length > 0 && (
          <>
            {/* Desktop / tablet: table */}
            <div className="relative hidden overflow-x-auto md:block">
              <table className="w-full min-w-[56rem] text-left text-sm">
                <caption className="sr-only">Roles in your organization</caption>
                <thead className="border-b border-line bg-slate-50/70 text-xs font-medium tracking-wide text-muted uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-2.5">Role</th>
                    <th scope="col" className="px-4 py-2.5">Type</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Members</th>
                    <th scope="col" className="px-4 py-2.5 text-right">Permissions</th>
                    <th scope="col" className="px-4 py-2.5">Status</th>
                    <th scope="col" className="px-4 py-2.5">Updated</th>
                    <th scope="col" className="px-4 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {roles.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/60">
                      <td className="max-w-md px-4 py-3">
                        <Link to={`/settings/access/roles/${r.id}`} className="font-medium text-ink hover:text-primary">{r.name}</Link>
                        {r.description && <p className="mt-0.5 line-clamp-1 text-xs text-muted">{r.description}</p>}
                      </td>
                      <td className="px-4 py-3"><TypeBadge system={r.is_system_role} /></td>
                      <td className="px-4 py-3 text-right tabular">{r.member_count}</td>
                      <td className="px-4 py-3 text-right tabular">{r.permission_count}</td>
                      <td className="px-4 py-3"><StatusBadge active={r.is_active} /></td>
                      <td className="px-4 py-3 whitespace-nowrap text-muted">{formatDate(r.updated_at, me.tenant.preferences)}</td>
                      <td className="px-2 py-2 text-right"><RowMenu role={r} items={menuFor(r)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Phones: cards */}
            <ul className="divide-y divide-line md:hidden">
              {roles.map((r) => (
                <li key={r.id} className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <Link to={`/settings/access/roles/${r.id}`} className="font-medium text-ink">{r.name}</Link>
                    {r.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{r.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <TypeBadge system={r.is_system_role} />
                      <StatusBadge active={r.is_active} />
                      <Badge tone="neutral">{r.member_count} members</Badge>
                      <Badge tone="neutral">{r.permission_count} permissions</Badge>
                    </div>
                  </div>
                  <RowMenu role={r} items={menuFor(r)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>
    </div>
  );
}

export function TypeBadge({ system }: { system: boolean }) {
  return system
    ? <Badge tone="violet" icon={<Lock className="size-3" aria-hidden />}>System</Badge>
    : <Badge tone="neutral">Custom</Badge>;
}

function RowMenu({ role, items }: { role: RoleSummary; items: MenuItem[] }) {
  return (
    <Menu
      label={`Actions for ${role.name}`}
      items={items}
      trigger={(p) => (
        <button {...p} type="button" aria-label={`Actions for ${role.name}`}
          className="inline-flex size-9 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-ink pointer-coarse:size-11">
          <MoreHorizontal className="size-4" aria-hidden />
        </button>
      )}
    />
  );
}

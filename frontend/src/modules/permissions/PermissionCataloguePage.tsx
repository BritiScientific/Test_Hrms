import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody } from '@/components/ui/Card';
import { Input } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { groupByModule, matchesPermission } from '@/utils/permissions';
import { usePermissionCatalogue, useRoles } from '../roles/hooks';

/** Read-only, platform-managed permission catalogue with the roles that use each permission. */
export default function PermissionCataloguePage() {
  usePageTitle('Permission catalogue');
  const catalogue = usePermissionCatalogue();
  const roles = useRoles();
  const [query, setQuery] = useState('');

  const usedBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of roles.data ?? []) if (r.is_active) for (const c of r.permissions) m.set(c, [...(m.get(c) ?? []), r.name]);
    return m;
  }, [roles.data]);
  const groups = useMemo(
    () => groupByModule((catalogue.data ?? []).filter((p) => matchesPermission(p, query))),
    [catalogue.data, query],
  );

  return (
    <div>
      <PageHeader
        title="Permission catalogue"
        description="Every permission the platform defines, grouped by area. Permissions are managed by the platform; roles combine them."
        actions={catalogue.data && <Badge tone="neutral" className="tabular">{catalogue.data.length} permissions</Badge>}
      />
      <div className="relative mb-5 max-w-xl">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search permissions"
          aria-label="Search permissions" className="pl-9" />
      </div>
      {catalogue.isPending && <Card><CardBody><LoadingBlock rows={10} /></CardBody></Card>}
      {catalogue.isError && <Card><ErrorState error={catalogue.error} onRetry={() => catalogue.refetch()} /></Card>}
      {catalogue.data && groups.length === 0 && <Card><EmptyState icon={<Search />} title="No permissions match" /></Card>}
      <div className="grid gap-5 2xl:grid-cols-2">
        {groups.map((g) => (
          <Card key={g.module}>
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
              <h2 className="font-semibold">{g.label}</h2>
              <Badge tone="neutral" className="tabular">{g.permissions.length}</Badge>
            </div>
            {/* Wide screens: table. Narrow: stacked rows. */}
            <div className="relative overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{g.label} permissions</caption>
                <thead className="hidden bg-slate-50/70 text-xs tracking-wide text-muted uppercase sm:table-header-group">
                  <tr>
                    <th scope="col" className="px-5 py-2 font-medium">Permission</th>
                    <th scope="col" className="px-5 py-2 font-medium">Used by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {g.permissions.map((p) => {
                    const roleNames = usedBy.get(p.code) ?? [];
                    return (
                      <tr key={p.code} className="flex flex-col gap-1.5 px-4 py-3 sm:table-row sm:px-0 sm:py-0">
                        <td className="sm:px-5 sm:py-3">
                          <p className="text-ink">{p.description}</p>
                          <code className="font-mono text-xs break-all text-muted">{p.code}</code>
                        </td>
                        <td className="sm:px-5 sm:py-3">
                          {roleNames.length === 0
                            ? <span className="text-xs text-muted">No active role</span>
                            : <div className="flex flex-wrap gap-1">{roleNames.map((n) => <Badge key={n} tone="neutral">{n}</Badge>)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

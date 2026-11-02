import { useMemo, useState } from 'react';
import { Lock, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Checkbox, Input } from '@/components/ui/Field';
import { EmptyState } from '@/components/feedback/States';
import type { Permission } from '@/types/api';
import { cn } from '@/utils/cn';
import { groupByModule, matchesPermission } from '@/utils/permissions';

/**
 * Permission matrix grouped by module. The catalogue comes from the API —
 * nothing is invented here. Module "select all" only affects the permissions
 * currently visible (after search) that the user is allowed to grant.
 *
 * `grantable(code)` reflects the server's anti-escalation rule (you can only
 * grant permissions you hold). Already-granted permissions can always be
 * removed. The server re-checks everything on save.
 */
export function PermissionMatrix({ catalogue, selected, onChange, grantable, readOnly, original }: {
  catalogue: Permission[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
  grantable: (code: string) => boolean;
  readOnly?: boolean;
  /** Saved state, to mark changed rows. */
  original?: ReadonlySet<string>;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => catalogue.filter((p) => matchesPermission(p, query)), [catalogue, query]);
  const groups = useMemo(() => groupByModule(visible), [visible]);

  const canToggle = (code: string) => !readOnly && (selected.has(code) || grantable(code));

  const toggle = (code: string) => {
    if (!canToggle(code)) return;
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };

  const toggleModule = (perms: Permission[], on: boolean) => {
    const next = new Set(selected);
    for (const p of perms) {
      if (on && !next.has(p.code) && grantable(p.code)) next.add(p.code);
      if (!on && next.has(p.code)) next.delete(p.code);
    }
    onChange(next);
  };

  return (
    <div>
      <div className="relative mb-4">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by code, description or module"
          aria-label="Search permissions"
          className="pl-9"
        />
      </div>

      {groups.length === 0 && <EmptyState icon={<Search />} title="No permissions match" description="Try a different search term." />}

      <div className="grid gap-4 2xl:grid-cols-2">
        {groups.map((g) => {
          const selectable = g.permissions.filter((p) => canToggle(p.code));
          const onCount = g.permissions.filter((p) => selected.has(p.code)).length;
          const all = onCount === g.permissions.length;
          const some = onCount > 0 && !all;
          const headerId = `perm-mod-${g.module}`;
          return (
            <section key={g.module} aria-labelledby={headerId} className="min-w-0 overflow-hidden rounded-card border border-line bg-surface shadow-card">
              <div className="flex items-center gap-3 border-b border-line bg-slate-50/70 px-4 py-3">
                <Checkbox
                  checked={all}
                  indeterminate={some}
                  disabled={readOnly || selectable.length === 0}
                  onChange={(e) => toggleModule(g.permissions, e.target.checked)}
                  aria-label={`Select all visible ${g.label} permissions`}
                />
                <h3 id={headerId} className="min-w-0 flex-1 truncate text-sm font-semibold">{g.label}</h3>
                <Badge tone={onCount ? 'primary' : 'neutral'} className="tabular">{onCount}/{g.permissions.length}</Badge>
              </div>
              <ul className="divide-y divide-line">
                {g.permissions.map((p) => {
                  const on = selected.has(p.code);
                  const locked = !canToggle(p.code);
                  const changed = original ? original.has(p.code) !== on : false;
                  return (
                    <li key={p.code}>
                      <label className={cn(
                        'flex items-start gap-3 px-4 py-3 pointer-coarse:py-3.5',
                        locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-slate-50',
                        changed && 'bg-amber-50/60',
                      )}>
                        <Checkbox checked={on} disabled={locked} onChange={() => toggle(p.code)} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-ink">{p.description}</span>
                          <code className="mt-0.5 block break-all font-mono text-xs text-muted">{p.code}</code>
                        </span>
                        {changed && <Badge tone="warning" className="text-[10px]">{on ? 'Adding' : 'Removing'}</Badge>}
                        {locked && !readOnly && (
                          <span title="You can only grant permissions you hold yourself" className="mt-0.5 text-slate-400">
                            <Lock className="size-3.5" aria-hidden />
                            <span className="sr-only">You can only grant permissions you hold yourself</span>
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Search } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardHeader } from '@/components/ui/Card';
import type { OrgChartNode } from '@/types/api';
import { cn } from '@/utils/cn';
import { formatDate } from '@/utils/format';
import { ISSUE_LABEL } from './EmployeeChartCard';

const PAGE = 48;

export function UnassignedEmployees({ employees, onSelect, matchIds, activeMatchId }: {
  employees: OrgChartNode[];
  onSelect: (id: number) => void;
  matchIds: ReadonlySet<number>;
  activeMatchId: number | null;
}) {
  const me = useMe();
  const [limit, setLimit] = useState(PAGE);
  const activeRef = useRef<HTMLButtonElement>(null);

  // A search result beyond the current page must still be reachable.
  const activePosition = activeMatchId === null ? -1 : employees.findIndex((e) => e.id === activeMatchId);
  const shownCount = Math.max(limit, activePosition + 1);

  useEffect(() => {
    if (activePosition >= 0) activeRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [activePosition]);

  return (
    <Card>
      <CardHeader
        title={`No reporting manager (${employees.length})`}
        description="People with no current manager and no team. Assign a manager on their employee record to place them in the hierarchy."
      />
      <ul className="grid gap-2 p-3 sm:grid-cols-2 sm:p-4 xl:grid-cols-3 3xl:grid-cols-4">
        {employees.slice(0, shownCount).map((e) => {
          const isActive = e.id === activeMatchId;
          const isMatch = matchIds.has(e.id);
          return (
            <li key={e.id} className="min-w-0">
              <button
                ref={isActive ? activeRef : undefined}
                type="button"
                data-highlight={isActive ? 'active' : isMatch ? 'match' : 'none'}
                onClick={() => onSelect(e.id)}
                className={cn(
                  'flex w-full min-w-0 items-center gap-3 rounded-lg border p-2.5 text-left hover:bg-slate-50',
                  isActive ? 'border-amber-500 bg-amber-50 ring-4 ring-amber-400'
                    : isMatch ? 'border-amber-400 bg-surface ring-2 ring-amber-300'
                      : 'border-line bg-surface',
                )}
              >
                <Avatar name={e.fullName} src={e.photoUrl} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-sm font-medium text-ink">{e.fullName}</span>
                    {isMatch && <Search className="size-3.5 shrink-0 text-amber-600" aria-label="Search match" />}
                  </span>
                  <span className="block truncate text-xs text-muted">
                    {e.employeeCode}{e.jobTitle && ` · ${e.jobTitle}`}{e.department && ` · ${e.department.name}`}
                  </span>
                  {e.issue && (
                    <Badge tone="warning" className="mt-1" icon={<AlertTriangle className="size-3" aria-hidden />}>{ISSUE_LABEL[e.issue]}</Badge>
                  )}
                  {e.upcomingManager && (
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      Reports to {e.upcomingManager.name} from {formatDate(e.upcomingManager.effectiveFrom, me.tenant.preferences)}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {shownCount < employees.length && (
        <div className="border-t border-line p-2 text-center">
          <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
            Show more ({employees.length - shownCount} left)
          </Button>
        </div>
      )}
    </Card>
  );
}

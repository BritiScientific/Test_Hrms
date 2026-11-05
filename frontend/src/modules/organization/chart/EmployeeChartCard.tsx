import { memo } from 'react';
import { AlertTriangle, Building2, ChevronDown, ChevronUp, Search, Users } from 'lucide-react';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { STATUS_LABEL } from '@/modules/employees/shared';
import type { OrgChartIssue, OrgChartNode } from '@/types/api';
import { cn } from '@/utils/cn';
import { CARD_H, CARD_W } from './chart-layout';

export const ISSUE_LABEL: Record<OrgChartIssue, string> = {
  manager_exited: 'Manager has left',
  manager_missing: 'Manager not found',
  cycle: 'Circular reporting line',
};

export type CardHighlight = 'none' | 'match' | 'active';

export const reportsLabel = (n: number) => `${n} direct ${n === 1 ? 'report' : 'reports'}`;

export const EmployeeChartCard = memo(function EmployeeChartCard({ node, x, y, isRoot, expanded, highlight, onSelect, onToggle }: {
  node: OrgChartNode;
  x: number;
  y: number;
  isRoot: boolean;
  expanded: boolean;
  highlight: CardHighlight;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
}) {
  const hasChildren = node.children.length > 0;
  const issue = node.issue ? ISSUE_LABEL[node.issue] : null;
  const summary = [
    node.fullName, node.employeeCode, node.jobTitle, node.department?.name, reportsLabel(node.directReportCount),
    isRoot && 'top of hierarchy', !node.matched && 'shown for context', highlight !== 'none' && 'search match', issue,
  ].filter(Boolean).join(', ');

  return (
    <div
      data-node-id={node.id}
      data-highlight={highlight}
      data-root={isRoot || undefined}
      className="absolute"
      style={{ left: x, top: y, width: CARD_W, height: CARD_H }}
    >
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        aria-label={`${summary}. Open details`}
        className={cn(
          'flex size-full flex-col rounded-card border p-3 pb-4 text-left shadow-card transition-shadow hover:shadow-pop',
          !node.matched && highlight === 'none' && 'border-dashed opacity-75',
          highlight === 'active' ? 'border-amber-500 bg-amber-50 ring-4 ring-amber-400'
            : highlight === 'match' ? 'border-amber-400 bg-surface ring-2 ring-amber-300'
              : isRoot ? 'border-primary/60 bg-primary-soft ring-1 ring-primary/40'
                : 'border-line bg-surface',
        )}
      >
        <span className="flex w-full min-w-0 items-center gap-2.5">
          <Avatar name={node.fullName} src={node.photoUrl} size="md" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-ink">{node.fullName}</span>
            <span className="block truncate text-xs text-muted">{node.employeeCode}</span>
          </span>
          {highlight !== 'none' && <Search className="size-3.5 shrink-0 text-amber-600" aria-hidden />}
          {issue && <span title={issue}><AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden /></span>}
        </span>
        <span className="mt-2 block truncate text-sm text-slate-700">{node.jobTitle ?? <span className="text-muted">No job title</span>}</span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <Building2 className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{node.department?.name ?? 'No department'}</span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <Users className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate tabular">{reportsLabel(node.directReportCount)}</span>
          {node.status !== 'active' && (
            <Badge tone={node.status === 'exited' ? 'neutral' : 'warning'} className="ml-auto px-1.5 py-0 text-[11px]">
              {STATUS_LABEL[node.status]}
            </Badge>
          )}
        </span>
      </button>

      {hasChildren && (
        <button
          type="button"
          onClick={() => onToggle(node.id)}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.fullName}’s team (${node.children.length})`}
          className="absolute -bottom-3 left-1/2 z-[1] inline-flex h-7 min-w-11 -translate-x-1/2 items-center justify-center gap-0.5 rounded-full border border-line bg-surface px-2 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 hover:text-ink pointer-coarse:h-9 pointer-coarse:min-w-14"
        >
          <span className="tabular" aria-hidden>{node.children.length}</span>
          {expanded ? <ChevronUp className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
        </button>
      )}
    </div>
  );
});

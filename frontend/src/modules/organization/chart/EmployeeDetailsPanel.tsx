import type { ReactNode } from 'react';
import { AlertTriangle, ExternalLink, LocateFixed, Network } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { STATUS_LABEL, employmentLabel } from '@/modules/employees/shared';
import type { OrgChartNode } from '@/types/api';
import { formatDate } from '@/utils/format';
import { ISSUE_LABEL } from './EmployeeChartCard';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

/**
 * Built from the chart data on purpose: someone holding only
 * organization.chart.view has no access to GET /employees/:id, and the panel
 * shows nothing beyond what the chart endpoint already allows them to see.
 */
export function EmployeeDetailsPanel({ employee, inChart, onClose, onSelect, onLocate, onViewHierarchy, hierarchyActive }: {
  employee: OrgChartNode | null;
  /** Is this employee (or their manager) on the current chart, so a link to them can work? */
  inChart: (id: number) => boolean;
  onClose: () => void;
  onSelect: (id: number) => void;
  /** Absent for people outside the drawn hierarchy (the “no reporting manager” list). */
  onLocate?: (id: number) => void;
  onViewHierarchy: (id: number) => void;
  hierarchyActive: boolean;
}) {
  const me = useMe();
  const { can } = useAuth();
  if (!employee) return <Dialog open={false} onClose={onClose} title="" />;

  const canOpenRecord = can('employee.view') || me.employeeId === employee.id;
  const canViewHierarchy = employee.directReportCount > 0 && !hierarchyActive;
  const hiddenReports = employee.directReportCount - employee.children.length;

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={employee.fullName}
      description={employee.jobTitle ?? 'No job title'}
      footer={(canOpenRecord || canViewHierarchy || onLocate) && (
        <>
          {canOpenRecord && (
            <ButtonLink variant="outline" to={`/employees/${employee.id}`} icon={<ExternalLink className="size-4" aria-hidden />}>
              Full profile
            </ButtonLink>
          )}
          {canViewHierarchy && (
            <Button variant="outline" onClick={() => onViewHierarchy(employee.id)} icon={<Network className="size-4" aria-hidden />}>
              View reporting hierarchy
            </Button>
          )}
          {onLocate && <Button onClick={() => onLocate(employee.id)} icon={<LocateFixed className="size-4" aria-hidden />}>Show on chart</Button>}
        </>
      )}
    >
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={employee.fullName} src={employee.photoUrl} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{employee.employeeCode}</p>
          <p className="truncate text-sm text-muted">{employee.department?.name ?? 'No department'}</p>
        </div>
      </div>

      {employee.issue && (
        <div className="mb-3">
          <InlineAlert tone="warning" title={ISSUE_LABEL[employee.issue]}>
            {employee.issue === 'cycle'
              ? 'This reporting line loops back on itself. Change the manager on the employee record to correct it.'
              : 'This person’s reporting line needs a new manager.'}
          </InlineAlert>
        </div>
      )}

      <dl className="divide-y divide-line">
        <Row label="Status">{STATUS_LABEL[employee.status]}</Row>
        <Row label="Employment type">{employmentLabel(employee.employmentType)}</Row>
        <Row label="Work location">{employee.workLocation ?? <span className="text-muted">—</span>}</Row>
        <Row label="Joined">{formatDate(employee.dateOfJoining, me.tenant.preferences)}</Row>
        <Row label="Reports to">
          {employee.manager ? (
            inChart(employee.manager.id) ? (
              <button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => onSelect(employee.manager!.id)}>
                {employee.manager.name}
              </button>
            ) : (
              <span>
                {employee.manager.name}
                {employee.manager.status === 'exited' && <span className="text-muted"> (has left)</span>}
              </span>
            )
          ) : employee.upcomingManager ? (
            <span>
              No manager yet. {employee.upcomingManager.name} from {formatDate(employee.upcomingManager.effectiveFrom, me.tenant.preferences)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-muted"><AlertTriangle className="size-3.5" aria-hidden />No reporting manager</span>
          )}
        </Row>
        <Row label="Direct reports"><span className="tabular">{employee.directReportCount}</span></Row>
        <Row label="Total team"><span className="tabular">{employee.totalReportCount}</span></Row>
      </dl>

      {employee.children.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium text-ink">Direct reports</h3>
          <ul className="space-y-1">
            {employee.children.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => onSelect(c.id)} className="flex w-full min-w-0 items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-slate-50">
                  <Avatar name={c.fullName} src={c.photoUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-sm text-ink">{c.fullName}</span>
                  <span className="max-w-[45%] truncate text-xs text-muted">{c.jobTitle}</span>
                </button>
              </li>
            ))}
          </ul>
          {hiddenReports > 0 && <p className="mt-2 text-xs text-muted">{hiddenReports} more hidden by the current filters.</p>}
        </div>
      )}
    </Dialog>
  );
}

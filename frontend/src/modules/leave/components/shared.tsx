import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody } from '@/components/ui/Card';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Textarea } from '@/components/ui/Field';
import type { TenantPreferences } from '@/types/api';
import type { CompOffClaim, CompOffStatus, LeaveStatus, RuleStatus } from '@/types/leave';
import { cn } from '@/utils/cn';
import { formatDate } from '@/utils/format';
import { COMP_OFF_STATUS, RULE_STATUS, STATUS_LABEL, dateRange, days } from '../leave-format';

export function LeaveStatusBadge({ status }: { status: LeaveStatus }) {
  const s = STATUS_LABEL[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function CompOffStatusBadge({ status }: { status: CompOffStatus }) {
  const s = COMP_OFF_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** Where an open comp off claim is in approval, or the decision note once decided. */
export function ClaimProgress({ claim, prefs }: { claim: CompOffClaim; prefs: Pick<TenantPreferences, 'dateFormat' | 'timezone'> }) {
  if (claim.status === 'pending' && claim.currentStep) {
    return <span className="text-xs text-muted">{claim.currentStep}{claim.waitingOn && `: waiting on ${claim.waitingOn}`}</span>;
  }
  if (claim.status === 'approved') {
    return <span className="text-xs text-muted">{claim.decisionNote ?? 'Credited'}{claim.expiresOn && ` · expires ${formatDate(claim.expiresOn, prefs)}`}</span>;
  }
  return <span className="text-xs text-muted">{claim.decisionNote ?? '—'}</span>;
}

export function RuleStatusBadge({ status }: { status: RuleStatus }) {
  const s = RULE_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function StatCard({ icon, label, value, hint, loading, to }: {
  icon: ReactNode; label: string; value?: ReactNode; hint?: string; loading?: boolean; to?: string;
}) {
  const body = (
    <CardBody className="flex items-start gap-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&>svg]:size-5" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        {loading ? <Skeleton className="mt-1.5 h-7 w-14" /> : (
          <p className="mt-0.5 text-2xl font-semibold tracking-tight text-ink tabular">{value ?? 0}</p>
        )}
        {hint && <p className="mt-0.5 truncate text-xs text-muted">{hint}</p>}
      </div>
    </CardBody>
  );
  return (
    <Card className={to ? 'transition-shadow hover:shadow-pop' : undefined}>
      {to ? <Link to={to} className="block rounded-card">{body}</Link> : body}
    </Card>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  className?: string;
  /** Hide the label on the phone layout (for the row's main title or its actions). */
  bare?: boolean;
}

/** A table at md and up, and a stack of cards below, so nothing scrolls sideways on a phone. */
export function DataTable<T>({ columns, rows, rowKey, caption, onRowClick, minWidth = '48rem' }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  caption: string;
  onRowClick?: (row: T) => void;
  minWidth?: string;
}) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm" style={{ minWidth }}>
          <caption className="sr-only">{caption}</caption>
          <thead className="border-b border-line bg-slate-50/70 text-xs font-medium tracking-wide text-muted uppercase">
            <tr>{columns.map((c) => <th key={c.key} scope="col" className={cn('px-4 py-2.5', c.className)}>{c.header}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={rowKey(r)} className={cn('hover:bg-slate-50/60', onRowClick && 'cursor-pointer')} onClick={onRowClick ? () => onRowClick(r) : undefined}>
                {columns.map((c) => <td key={c.key} className={cn('px-4 py-3 align-top', c.className)}>{c.render(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className={cn('space-y-1.5 p-4 text-sm', onRowClick && 'cursor-pointer')} onClick={onRowClick ? () => onRowClick(r) : undefined}>
            {columns.map((c) => (
              c.bare ? <div key={c.key}>{c.render(r)}</div> : (
                <div key={c.key} className="flex items-start justify-between gap-3">
                  <span className="shrink-0 text-xs text-muted">{c.header}</span>
                  <span className="min-w-0 text-right">{c.render(r)}</span>
                </div>
              )
            ))}
          </li>
        ))}
      </ul>
    </>
  );
}

export function Pager({ total, limit, offset, onChange }: { total: number; limit: number; offset: number; onChange: (offset: number) => void }) {
  if (total === 0) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-muted">
      <span className="tabular">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
      <div className="flex gap-1">
        <Button variant="ghost" size="icon" aria-label="Previous page" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <Button variant="ghost" size="icon" aria-label="Next page" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
      </div>
    </div>
  );
}

/** The three states every data section has, in one place. */
export function QueryState<T>({ query, emptyTitle, emptyText, isEmpty, loadingRows = 5, children, emptyIcon, emptyAction }: {
  query: { isPending: boolean; isError: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  emptyTitle?: string;
  emptyText?: ReactNode;
  emptyIcon?: ReactNode;
  emptyAction?: ReactNode;
  isEmpty?: (d: T) => boolean;
  loadingRows?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <div className="p-4"><LoadingBlock rows={loadingRows} /></div>;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => query.refetch()} />;
  if (query.data === undefined) return null;
  if (isEmpty?.(query.data)) return <EmptyState icon={emptyIcon} title={emptyTitle ?? 'Nothing here yet'} description={emptyText} action={emptyAction} />;
  return <>{children(query.data)}</>;
}

/** Horizontal bars: label, value and a bar scaled to the largest value. */
export function BarList({ items, unit = 'days' }: { items: { label: string; value: number; hint?: string }[]; unit?: string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-3">
      {items.map((i) => (
        <li key={i.label}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink">{i.label}</span>
            <span className="shrink-0 text-muted tabular">{days(i.value)} {unit}{i.hint ? ` · ${i.hint}` : ''}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
            <div className="h-full rounded-full bg-primary" style={{ width: `${(i.value / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LeaveList({ items, onOpen, showEmployee }: {
  items: { id: number; employeeName?: string; leaveTypeName: string; startDate: string; endDate: string; halfDaySession?: any; totalDays: number; status?: LeaveStatus }[];
  onOpen?: (id: number) => void;
  showEmployee?: boolean;
}) {
  const me = useMe();
  return (
    <ul className="divide-y divide-line">
      {items.map((r) => {
        const body = (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-ink">{showEmployee ? r.employeeName : r.leaveTypeName}</span>
              <span className="block truncate text-xs text-muted">
                {showEmployee && `${r.leaveTypeName} · `}{dateRange(r, me.tenant.preferences)} · {days(r.totalDays)} d
              </span>
            </span>
            {r.status && <LeaveStatusBadge status={r.status} />}
          </>
        );
        return (
          <li key={r.id}>
            {onOpen ? (
              <button type="button" onClick={() => onOpen(r.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5">{body}</button>
            ) : <div className="flex items-center gap-3 px-4 py-3 sm:px-5">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/** Ask for a comment before a decision. The text is required unless `optional`. */
export function ReasonDialog({ open, title, description, label, confirmLabel, tone = 'primary', optional, loading, onClose, onConfirm }: {
  open: boolean;
  title: string;
  description?: ReactNode;
  label: string;
  confirmLabel: string;
  tone?: 'primary' | 'destructive';
  optional?: boolean;
  loading?: boolean;
  onClose: () => void;
  onConfirm: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (!optional && text.trim().length < 3) return setError('Please write at least a few words.');
    setError(undefined);
    onConfirm(text.trim());
  };
  const close = () => { setText(''); setError(undefined); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={title} description={description} size="sm"
      footer={
        <>
          <Button variant="outline" onClick={close} disabled={loading}>Back</Button>
          <Button variant={tone === 'destructive' ? 'destructive' : 'primary'} onClick={submit} loading={loading}>{confirmLabel}</Button>
        </>
      }>
      <Field label={label} required={!optional} error={error}>
        {({ id, invalid, describedBy }) => (
          <Textarea id={id} data-autofocus value={text} onChange={(e) => setText(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy} maxLength={1000} />
        )}
      </Field>
    </Dialog>
  );
}

import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'violet';

const tones: Record<BadgeTone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  primary: 'bg-primary-soft text-primary-dark ring-blue-200',
  success: 'bg-success-soft text-green-700 ring-green-200',
  warning: 'bg-warning-soft text-amber-700 ring-amber-200',
  danger: 'bg-danger-soft text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};

/** Status badge: always carries text, never colour alone. */
export function Badge({ tone = 'neutral', icon, children, className }: {
  tone?: BadgeTone; icon?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset',
      tones[tone], className,
    )}>
      {icon}
      {children}
    </span>
  );
}

export function StatusBadge({ active, activeLabel = 'Active', inactiveLabel = 'Inactive' }: {
  active: boolean; activeLabel?: string; inactiveLabel?: string;
}) {
  return (
    <Badge tone={active ? 'success' : 'neutral'}>
      <span className={cn('size-1.5 rounded-full', active ? 'bg-success' : 'bg-slate-400')} aria-hidden />
      {active ? activeLabel : inactiveLabel}
    </Badge>
  );
}

import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/utils/cn';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0 rounded-card border border-line bg-surface shadow-card', className)} {...rest} />;
}

export function CardHeader({ title, description, actions, className, as: Heading = 'h2' }: {
  title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; as?: 'h2' | 'h3';
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5', className)}>
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-ink">{title}</Heading>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-4 py-4 sm:px-5 sm:py-5', className)} {...rest} />;
}

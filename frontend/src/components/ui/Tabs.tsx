import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface TabItem<K extends string = string> {
  key: K;
  label: string;
  count?: number;
  icon?: ReactNode;
}

/** WAI-ARIA tabs: arrow keys move between tabs, and the row scrolls sideways on phones. */
export function Tabs<K extends string>({ tabs, active, onChange, label, idBase = 'tab' }: {
  tabs: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  label: string;
  idBase?: string;
}) {
  const refs = useRef<Partial<Record<K, HTMLButtonElement | null>>>({});
  const onKey = (e: KeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    onChange(next.key);
    refs.current[next.key]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t, i) => (
        <button
          key={t.key}
          ref={(el) => { refs.current[t.key] = el; }}
          type="button"
          role="tab"
          id={`${idBase}-${t.key}`}
          aria-selected={t.key === active}
          aria-controls={`${idBase}-panel`}
          tabIndex={t.key === active ? 0 : -1}
          onClick={() => onChange(t.key)}
          onKeyDown={(e) => onKey(e, i)}
          className={cn(
            '-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
            t.key === active ? 'border-primary text-primary-dark' : 'border-transparent text-slate-600 hover:border-slate-300 hover:text-ink',
          )}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && (
            <span className="tabular rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({ active, idBase = 'tab', className, children }: { active: string; idBase?: string; className?: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-${active}`} className={className}>
      {children}
    </div>
  );
}

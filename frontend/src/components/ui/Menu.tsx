import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface MenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  hint?: string;
}

/**
 * Accessible action menu (menu button pattern): Enter/Space/ArrowDown opens,
 * arrows move, Esc closes and returns focus, click-outside closes.
 */
export function Menu({ trigger, items, label, align = 'right', header }: {
  trigger: (props: { ref: React.Ref<HTMLButtonElement>; 'aria-haspopup': 'menu'; 'aria-expanded': boolean; 'aria-controls': string; onClick: () => void; onKeyDown: (e: React.KeyboardEvent) => void }) => ReactNode;
  items: MenuItem[];
  label: string;
  align?: 'left' | 'right';
  header?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    const first = list.current?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])');
    first?.focus();
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const close = (focus = true) => {
    setOpen(false);
    if (focus) btn.current?.focus();
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const els = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); }
    if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') close(false);
  };

  return (
    <div className="relative">
      {trigger({
        ref: btn,
        'aria-haspopup': 'menu',
        'aria-expanded': open,
        'aria-controls': id,
        onClick: () => setOpen((o) => !o),
        onKeyDown: (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); }
        },
      })}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onListKey}
          className={cn(
            'absolute z-50 mt-1.5 min-w-52 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-pop',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {header && <div className="border-b border-line px-3 py-2.5">{header}</div>}
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              title={item.hint}
              onClick={() => {
                close();
                item.onSelect();
              }}
              className={cn(
                'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm outline-none pointer-coarse:py-2.5',
                'hover:bg-slate-50 focus:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50',
                item.tone === 'danger' ? 'text-danger' : 'text-ink',
              )}
            >
              {item.icon && <span className="text-slate-500 [&>svg]:size-4" aria-hidden>{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

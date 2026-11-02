import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Searchable single-select (WAI-ARIA combobox with listbox popup) for long
 * lists such as timezones, currencies, countries, roles.
 */
export function Combobox({
  id, value, onChange, options, placeholder = 'Search…', disabled, invalid, describedBy, emptyText = 'No matches',
}: {
  id?: string;
  value: string | null;
  onChange: (value: string) => void;
  options: ComboOption[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  emptyText?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const selected = options.find((o) => o.value === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q))
      : options;
    return list.slice(0, 200);
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (o: ComboOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={wrap} className="relative min-w-0">
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        autoComplete="off"
        value={open ? query : selected?.label ?? ''}
        placeholder={selected ? selected.label : placeholder}
        onFocus={() => { setOpen(true); setActive(0); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === 'Enter') { if (open) { e.preventDefault(); choose(filtered[active]); } }
          else if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          else if (e.key === 'Tab') setOpen(false);
        }}
        className={cn(
          'block h-10 w-full min-w-0 rounded-lg border border-line bg-surface pl-3 pr-9 text-sm text-ink shadow-xs pointer-coarse:h-11',
          'placeholder:text-slate-500 focus:border-primary focus:outline-none focus:ring-3 focus:ring-primary/15',
          'disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-500',
          invalid && 'border-danger',
          !open && selected && 'placeholder:text-ink',
        )}
      />
      <ChevronsUpDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
      {open && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-pop"
        >
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted">{emptyText}</li>}
          {filtered.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              data-index={i}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
              className={cn(
                'flex cursor-pointer items-center gap-2 px-3 py-2 text-sm',
                i === active && 'bg-slate-100',
                o.disabled && 'cursor-not-allowed opacity-50',
              )}
            >
              <Check className={cn('size-4 shrink-0 text-primary', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Bold, Heading2, Italic, Link2, List, ListOrdered, Search, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { useDebounced } from '@/hooks/useDebounced';
import { cn } from '@/utils/cn';
import { formatDate, formatDateTime } from '@/utils/format';
import { recruitmentApi } from './api';
import { recKeys } from './hooks';
import type { ApplicationStatus, EmployeeOption, InterviewMode, InterviewStatus, StageType } from './types';

// ---------------------------------------------------------------- formatting ---

export function usePrefs() {
  const { me } = useAuth();
  const p = me?.tenant.preferences;
  return useMemo(() => (p ? { dateFormat: p.dateFormat, timezone: p.timezone } : undefined), [p]);
}
export function useDates() {
  const prefs = usePrefs();
  return { date: (v: string | null | undefined) => formatDate(v, prefs), dateTime: (v: string | null | undefined) => formatDateTime(v, prefs) };
}

export const MODE_LABEL: Record<InterviewMode, string> = { video: 'Video call', in_person: 'In person', phone: 'Phone' };
export const INTERVIEW_STATUS: Record<InterviewStatus, { label: string; tone: BadgeTone }> = {
  scheduled: { label: 'Scheduled', tone: 'primary' }, completed: { label: 'Completed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' }, no_show: { label: 'No-show', tone: 'danger' },
};
export const RECOMMENDATION_LABEL = { strong_yes: 'Strong yes', yes: 'Yes', no: 'No', strong_no: 'Strong no' } as const;
export const SOURCE_LABEL: Record<string, string> = { careers: 'Careers site', manual: 'Added by HR', referral: 'Referral', agency: 'Agency', other: 'Other' };

const STAGE_TONE: Record<StageType, BadgeTone> = {
  applied: 'neutral', initial: 'primary', test: 'violet', interview: 'primary', shortlisted: 'warning', hired: 'success', rejected: 'danger',
};
export function StageBadge({ name, type }: { name: string; type: StageType }) {
  return <Badge tone={STAGE_TONE[type]}>{name}</Badge>;
}
export function ApplicationStatusBadge({ status }: { status: ApplicationStatus }) {
  return <Badge tone={status === 'hired' ? 'success' : status === 'rejected' ? 'danger' : 'primary'}>{status === 'active' ? 'In pipeline' : status === 'hired' ? 'Hired' : 'Rejected'}</Badge>;
}

/** datetime-local value <-> ISO instant (the browser's local zone, which is what the user sees on screen). */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => new Date(v).toISOString();

// ------------------------------------------------- safe rich text (no HTML) ---

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).filter(Boolean).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer nofollow" className="text-primary underline">{link[1]}</a>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/**
 * Renders the simple formatting the editor produces (headings, bold, italic,
 * bullet and numbered lists, links) as React elements. Never uses innerHTML,
 * so a job description can never inject markup or script.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => {
    const out: ReactNode[] = [];
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    let key = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      const h = /^(#{1,3})\s+(.*)$/.exec(line);
      if (h) { out.push(<h3 key={key++} className="mt-4 text-base font-semibold text-ink first:mt-0">{inline(h[2])}</h3>); i++; continue; }
      if (/^\s*[-*]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
        out.push(<ul key={key++} className="my-2 list-disc space-y-1 pl-5">{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ul>);
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
        out.push(<ol key={key++} className="my-2 list-decimal space-y-1 pl-5">{items.map((t, n) => <li key={n}>{inline(t)}</li>)}</ol>);
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
      out.push(<p key={key++} className="my-2 first:mt-0">{inline(para.join(' '))}</p>);
    }
    return out;
  }, [text]);
  return <div className={cn('text-sm leading-relaxed text-slate-700 break-words', className)}>{blocks}</div>;
}

/** Textarea with a small formatting toolbar and a live preview. Stores plain text with light markup. */
export function RichTextEditor({ id, value, onChange, invalid, describedBy, rows = 8 }: {
  id?: string; value: string; onChange: (v: string) => void; invalid?: boolean; describedBy?: string; rows?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  const edit = (fn: (sel: string, before: string, after: string) => { text: string; select?: [number, number] }) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: s, selectionEnd: e } = el;
    const r = fn(value.slice(s, e), value.slice(0, s), value.slice(e));
    onChange(r.text);
    requestAnimationFrame(() => {
      el.focus();
      if (r.select) el.setSelectionRange(r.select[0], r.select[1]);
    });
  };
  const wrap = (mark: string, placeholder: string) => edit((sel, b, a) => {
    const inner = sel || placeholder;
    return { text: `${b}${mark}${inner}${mark}${a}`, select: [b.length + mark.length, b.length + mark.length + inner.length] };
  });
  const prefixLines = (prefix: (n: number) => string, placeholder: string) => edit((sel, b, a) => {
    const lines = (sel || placeholder).split('\n').map((l, n) => `${prefix(n)}${l.replace(/^\s*([-*]|\d+[.)])\s+/, '')}`).join('\n');
    const lead = b && !b.endsWith('\n') ? '\n' : '';
    return { text: `${b}${lead}${lines}${a}`, select: [b.length + lead.length, b.length + lead.length + lines.length] };
  });
  const link = () => {
    const url = window.prompt('Link address (https://…)');
    if (!url) return;
    if (!/^https?:\/\/\S+$/i.test(url)) { window.alert('Enter a full link starting with http:// or https://'); return; }
    edit((sel, b, a) => ({ text: `${b}[${sel || 'link text'}](${url})${a}` }));
  };

  const tools: { label: string; icon: ReactNode; run: () => void }[] = [
    { label: 'Heading', icon: <Heading2 className="size-4" />, run: () => prefixLines(() => '## ', 'Heading') },
    { label: 'Bold', icon: <Bold className="size-4" />, run: () => wrap('**', 'bold text') },
    { label: 'Italic', icon: <Italic className="size-4" />, run: () => wrap('*', 'italic text') },
    { label: 'Bulleted list', icon: <List className="size-4" />, run: () => prefixLines(() => '- ', 'List item') },
    { label: 'Numbered list', icon: <ListOrdered className="size-4" />, run: () => prefixLines((n) => `${n + 1}. `, 'List item') },
    { label: 'Link', icon: <Link2 className="size-4" />, run: link },
  ];

  return (
    <div className={cn('rounded-lg border bg-surface', invalid ? 'border-danger' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-slate-50/70 p-1">
        {tools.map((t) => (
          <Button key={t.label} size="icon" variant="ghost" className="size-8 pointer-coarse:size-9" aria-label={t.label} title={t.label}
            disabled={preview} onClick={t.run}>{t.icon}</Button>
        ))}
        <Button size="sm" variant={preview ? 'secondary' : 'ghost'} className="ml-auto" aria-pressed={preview} onClick={() => setPreview((p) => !p)}>
          {preview ? 'Edit' : 'Preview'}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-32 p-3">{value.trim() ? <RichText text={value} /> : <p className="text-sm text-muted">Nothing to preview yet.</p>}</div>
      ) : (
        <Textarea ref={ref} id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined}
          aria-describedby={describedBy} maxLength={20000} className="rounded-none border-0 shadow-none focus:ring-0" />
      )}
    </div>
  );
}

// ------------------------------------------------------------------- pickers ---

/** Multi-select of current employees with server-side search. Selected people stay as removable chips. */
export function EmployeePicker({ id, value, onChange, selected, max = 20, invalid, describedBy, placeholder = 'Search employees' }: {
  id?: string; value: number[]; onChange: (ids: number[], people: EmployeeOption[]) => void;
  /** People already known for `value` (so chips have names before any search). */
  selected?: { id: number; name: string }[];
  max?: number; invalid?: boolean; describedBy?: string; placeholder?: string;
}) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState<Record<number, string>>({});
  const debounced = useDebounced(search.trim(), 250);
  const wrap = useRef<HTMLDivElement>(null);
  const listId = useId();
  const q = useQuery({
    queryKey: recKeys.lookup('employees', { search: debounced }),
    queryFn: () => recruitmentApi.lookups.employees({ search: debounced || undefined }),
    enabled: open, staleTime: 15_000,
  });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const names: Record<number, string> = { ...Object.fromEntries((selected ?? []).map((p) => [p.id, p.name])), ...known };
  const options = (q.data ?? []).filter((p) => !value.includes(p.id));
  const add = (p: EmployeeOption) => {
    if (value.length >= max) return;
    setKnown((k) => ({ ...k, [p.id]: p.name }));
    onChange([...value, p.id], [p]);
    setSearch('');
  };

  return (
    <div ref={wrap} className="relative">
      <div className={cn('flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border bg-surface px-2 py-1.5 focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15',
        invalid ? 'border-danger' : 'border-line')}>
        {value.map((vid) => (
          <span key={vid} className="inline-flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pr-1 pl-2.5 text-xs font-medium text-slate-700">
            {names[vid] ?? `#${vid}`}
            <button type="button" aria-label={`Remove ${names[vid] ?? vid}`} className="rounded-full p-0.5 hover:bg-slate-200"
              onClick={() => onChange(value.filter((x) => x !== vid), [])}><X className="size-3" aria-hidden /></button>
          </span>
        ))}
        <div className="relative min-w-32 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-1 size-3.5 -translate-y-1/2 text-slate-400" aria-hidden />
          <input id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-describedby={describedBy}
            value={search} placeholder={value.length ? '' : placeholder} autoComplete="off"
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Backspace' && !search && value.length) onChange(value.slice(0, -1), []); }}
            className="h-7 w-full bg-transparent pl-6 text-sm outline-none placeholder:text-slate-400" />
        </div>
      </div>
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-line bg-surface py-1 shadow-pop">
          {q.isPending && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {q.isError && <li className="px-3 py-2 text-sm text-danger">Could not load employees</li>}
          {value.length >= max && <li className="px-3 py-2 text-sm text-muted">At most {max} people</li>}
          {!q.isPending && !q.isError && value.length < max && options.length === 0 && <li className="px-3 py-2 text-sm text-muted">No matching employees</li>}
          {value.length < max && options.map((p) => (
            <li key={p.id} role="option" aria-selected={false} className="cursor-pointer px-3 py-2 hover:bg-slate-50"
              onMouseDown={(e) => { e.preventDefault(); add(p); }}>
              <p className="text-sm font-medium text-ink">{p.name} <span className="font-normal text-muted">· {p.code}</span></p>
              {(p.jobTitle || p.department) && <p className="text-xs text-muted">{[p.jobTitle, p.department].filter(Boolean).join(' · ')}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Free-text tags: Enter or comma adds, Backspace on an empty box removes the last. */
export function TagsInput({ id, value, onChange, max = 30, placeholder = 'Type a skill and press Enter' }: {
  id?: string; value: string[]; onChange: (v: string[]) => void; max?: number; placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const parts = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (next.length < max && !next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p.slice(0, 50));
    onChange(next);
    setDraft('');
  };
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 focus-within:border-primary focus-within:ring-3 focus-within:ring-primary/15">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-full bg-primary-soft py-0.5 pr-1 pl-2.5 text-xs font-medium text-primary-dark">
          {t}
          <button type="button" aria-label={`Remove ${t}`} className="rounded-full p-0.5 hover:bg-blue-100" onClick={() => onChange(value.filter((x) => x !== t))}>
            <X className="size-3" aria-hidden />
          </button>
        </span>
      ))}
      <Input id={id} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={value.length ? '' : placeholder}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
          if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={commit} className="h-7 min-w-32 flex-1 border-0 px-1 shadow-none focus:ring-0" />
    </div>
  );
}

/** "3 of 5 filled" with a thin progress bar. */
export function FilledMeter({ filled, total }: { filled: number; total: number }) {
  const pct = total ? Math.min(100, Math.round((filled / total) * 100)) : 0;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-slate-700">
      <span className="tabular">{filled} / {total} filled</span>
      <span className="h-1.5 w-14 overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={filled} aria-valuemin={0} aria-valuemax={total} aria-label="Vacancies filled">
        <span className={cn('block h-full rounded-full', pct >= 100 ? 'bg-success' : 'bg-primary')} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}

export function Stars({ value, onChange, label = 'Rating' }: { value: number | null; onChange?: (v: number | null) => void; label?: string }) {
  return (
    <span role={onChange ? 'radiogroup' : 'img'} aria-label={onChange ? label : `${label}: ${value ?? 'not rated'} of 5`} className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => {
        const on = (value ?? 0) >= n;
        const star = <span aria-hidden className={cn('text-base leading-none', on ? 'text-amber-500' : 'text-slate-300')}>★</span>;
        return onChange ? (
          <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} of 5`} className="rounded px-0.5 hover:scale-110"
            onClick={() => onChange(value === n ? null : n)}>{star}</button>
        ) : <span key={n}>{star}</span>;
      })}
    </span>
  );
}

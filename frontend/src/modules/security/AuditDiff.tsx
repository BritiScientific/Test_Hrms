/** Compact before → after view of an audit entry's changed fields. */
export function AuditDiff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
    .filter((k) => !['id', 'tenant_id'].includes(k))
    .filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  if (!keys.length) return null;
  return (
    <dl className="mt-2 grid gap-1 rounded-lg bg-slate-50 px-3 py-2 text-xs">
      {keys.slice(0, 8).map((k) => (
        <div key={k} className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-slate-600">{k}</dt>
          <dd className="min-w-0 break-words text-slate-700">
            {before && k in before && <span className="text-red-700 line-through decoration-red-300">{show(before[k])}</span>}
            {before && k in before && after && k in after && <span className="mx-1 text-slate-400">→</span>}
            {after && k in after && <span className="text-green-800">{show(after[k])}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  if (Array.isArray(v)) return v.length > 6 ? `${v.slice(0, 6).join(', ')} … (+${v.length - 6})` : v.join(', ') || '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

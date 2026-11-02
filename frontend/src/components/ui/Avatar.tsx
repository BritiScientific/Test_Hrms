import { useState } from 'react';
import { cn } from '@/utils/cn';
import { initials } from '@/utils/format';

const PALETTE = ['bg-blue-100 text-blue-700', 'bg-violet-100 text-violet-700', 'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-800', 'bg-rose-100 text-rose-700', 'bg-cyan-100 text-cyan-800'];

function tone(seed: string) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Image with initials fallback (also used for organization logos). */
export function Avatar({ name, src, size = 'md', square, className }: {
  name: string; src?: string | null; size?: 'sm' | 'md' | 'lg' | 'xl'; square?: boolean; className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const dims = { sm: 'size-7 text-[11px]', md: 'size-9 text-xs', lg: 'size-12 text-sm', xl: 'size-20 text-xl' }[size];
  const shape = square ? 'rounded-lg' : 'rounded-full';
  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        onError={() => setFailed(true)}
        className={cn(dims, shape, 'shrink-0 border border-line bg-white object-contain', className)}
      />
    );
  }
  return (
    <span aria-hidden className={cn(dims, shape, tone(name), 'inline-flex shrink-0 items-center justify-center font-semibold', className)}>
      {initials(name)}
    </span>
  );
}

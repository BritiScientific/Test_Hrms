import { useState } from 'react';
import { Check, Copy, Link2 } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { formatDateTime } from '@/utils/format';

/**
 * One-time activation link, shown to HR exactly once (only a hash is stored).
 * There is no email delivery yet, so HR shares it over a trusted channel.
 */
export function InviteLink({ url, expiresAt, name }: { url: string; expiresAt: string; name: string }) {
  const me = useMe();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked: the field below can still be selected manually */
    }
  };
  return (
    <div className="rounded-xl border border-blue-200 bg-primary-soft/60 p-4">
      <p className="flex items-center gap-2 text-sm font-medium text-blue-950">
        <Link2 className="size-4" aria-hidden /> Activation link for {name}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <Input readOnly value={url} aria-label="Activation link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button variant={copied ? 'secondary' : 'primary'} onClick={copy} icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
          {copied ? 'Copied' : 'Copy link'}
        </Button>
      </div>
      <p className="mt-2 text-xs text-blue-900/80">
        Share it with {name.split(' ')[0]} privately. It works once and expires {formatDateTime(expiresAt, me.tenant.preferences)}.
        This is the only time it is shown — you can issue a new one later from their profile.
      </p>
    </div>
  );
}

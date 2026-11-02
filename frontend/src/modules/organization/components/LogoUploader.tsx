import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ImageUp, Trash2 } from 'lucide-react';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { organizationApi } from '@/services/organization-api';
import type { OrganizationProfile } from '@/types/api';
import { formatBytes } from '@/utils/format';
import { orgKeys } from '../hooks';

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 512 * 1024;

/**
 * Logo upload with preview. Type/size are pre-checked here for fast feedback;
 * the server re-validates by reading the file's actual bytes.
 */
export function LogoUploader({ profile, readOnly }: { profile: OrganizationProfile; readOnly?: boolean }) {
  const qc = useQueryClient();
  const { refresh } = useAuth();
  const { notify } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const after = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: orgKeys.profile }),
      qc.invalidateQueries({ queryKey: orgKeys.onboarding }),
      refresh(),
    ]);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    if (!ACCEPT.includes(file.type)) return setError('Choose a PNG, JPEG or WebP image. SVG is not accepted.');
    if (file.size > MAX) return setError(`The image is ${formatBytes(file.size)}. The maximum is 512 KB.`);
    setBusy(true);
    try {
      await organizationApi.uploadLogo(file);
      await after();
      notify({ tone: 'success', title: 'Logo updated' });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Upload failed. Please try again.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await organizationApi.removeLogo();
      await after();
      notify({ tone: 'success', title: 'Logo removed' });
      setConfirmRemove(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not remove the logo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <Avatar name={profile.displayName} src={profile.logo?.url} square size="xl" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-ink">Organization logo</p>
        <p className="mt-0.5 text-sm text-muted">
          {profile.logo ? `${profile.logo.contentType.replace('image/', '').toUpperCase()} · ${formatBytes(profile.logo.byteSize)}` : 'PNG, JPEG or WebP, up to 512 KB. A square image works best.'}
        </p>
        {error && <div className="mt-2"><InlineAlert>{error}</InlineAlert></div>}
        {!readOnly && (
          <div className="mt-3 flex flex-wrap gap-2">
            <input ref={input} type="file" accept={ACCEPT.join(',')} className="sr-only" id="logo-file"
              onChange={(e) => onFile(e.target.files?.[0])} />
            <Button variant="outline" size="sm" loading={busy} icon={<ImageUp className="size-4" />}
              onClick={() => input.current?.click()}>
              {profile.logo ? 'Replace logo' : 'Upload logo'}
            </Button>
            {profile.logo && (
              <Button variant="ghost" size="sm" disabled={busy} icon={<Trash2 className="size-4" />}
                onClick={() => setConfirmRemove(true)} className="text-danger hover:bg-danger-soft hover:text-danger">
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={remove}
        loading={busy}
        tone="destructive"
        title="Remove the logo?"
        description="The portal will show your organization’s initials instead."
        confirmLabel="Remove logo"
      />
    </div>
  );
}

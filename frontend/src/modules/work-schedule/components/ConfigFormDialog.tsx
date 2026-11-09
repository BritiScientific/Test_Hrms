import { useId, type FormEventHandler, type ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

/**
 * Modal shell shared by every work schedule form: the native dialog traps
 * focus and closes on Escape; submit is disabled while saving; a stale save
 * keeps the user's input and offers a Reload.
 */
export function ConfigFormDialog({
  title, description, size = 'md', onClose, onSubmit, saving, error, stale, onReload, submitLabel = 'Save', children,
}: {
  title: string;
  description?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  onClose: () => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  saving: boolean;
  /** A form-level error (field errors are shown on their own fields). */
  error?: string | null;
  /** The record changed on the server since this form was opened. */
  stale?: boolean;
  onReload?: () => void;
  submitLabel?: string;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <Dialog
      open
      onClose={saving ? () => undefined : onClose}
      title={title}
      description={description}
      size={size}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" form={formId} loading={saving} disabled={saving}>{submitLabel}</Button>
        </>
      }
    >
      <form id={formId} noValidate onSubmit={onSubmit} className="space-y-4">
        {stale && (
          <InlineAlert tone="warning" title="This record was changed by someone else">
            <p>Your changes are still here. Reload to load the latest version, then make your changes again.</p>
            {onReload && (
              <Button type="button" size="sm" variant="outline" className="mt-2" icon={<RotateCw className="size-4" />} onClick={onReload}>
                Reload
              </Button>
            )}
          </InlineAlert>
        )}
        {error && <InlineAlert>{error}</InlineAlert>}
        {children}
      </form>
    </Dialog>
  );
}

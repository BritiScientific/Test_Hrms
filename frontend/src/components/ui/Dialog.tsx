import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/utils/cn';
import { Button } from './Button';

/**
 * Modal dialog on the native <dialog> element: focus is moved into the dialog
 * and trapped by the browser, Esc closes it, and focus returns to the opener.
 * On phones it becomes a bottom sheet.
 */
export function Dialog({ open, onClose, title, description, children, footer, size = 'md' }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal?.();
      // showModal focuses the first control (the close button); prefer the field marked data-autofocus.
      requestAnimationFrame(() => d.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    }
    if (!open && d.open) d.close?.();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // click on backdrop
      }}
      className={cn(
        'm-0 mt-auto w-full max-w-none rounded-t-2xl border border-line bg-surface p-0 text-ink shadow-pop',
        'sm:m-auto sm:rounded-2xl',
        size === 'sm' && 'sm:max-w-md',
        size === 'md' && 'sm:max-w-lg',
        size === 'lg' && 'sm:max-w-2xl',
      )}
    >
      {open && (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-base font-semibold">{title}</h2>
              {description && <p id={descId} className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <Button variant="ghost" size="icon" className="-mr-2 -mt-1" onClick={onClose} aria-label="Close dialog">
              <X className="size-4" aria-hidden />
            </Button>
          </div>
          {children && <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>}
          {footer && (
            <div className="safe-bottom flex flex-col-reverse gap-2 border-t border-line bg-slate-50/60 px-5 py-3 sm:flex-row sm:justify-end">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog({
  open, onClose, onConfirm, title, description, children, confirmLabel = 'Confirm', tone = 'primary', loading,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'destructive';
  loading?: boolean;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={tone === 'destructive' ? 'destructive' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

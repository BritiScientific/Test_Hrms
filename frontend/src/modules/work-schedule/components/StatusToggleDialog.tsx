import { InlineAlert } from '@/components/feedback/States';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { ApiError } from '@/services/api-client';
import type { ResourceApi } from '../api';
import { useInvalidateWorkSchedule, useStatusMutation } from '../hooks';
import { BLOCKER_LABEL, type BaseRecord, type Blocker } from '../types';

/**
 * Confirm before activating or deactivating. When the server refuses because
 * active records still depend on this one, the blockers are listed so HR knows
 * exactly what to change first.
 */
export function StatusToggleDialog<T extends BaseRecord>({ record, label, client, onClose }: {
  record: T | null;
  label: string;
  client: ResourceApi<T>;
  onClose: () => void;
}) {
  const mutation = useStatusMutation(client, label);
  const invalidate = useInvalidateWorkSchedule();
  const deactivating = !!record?.isActive;
  const error = mutation.error;

  const close = () => {
    mutation.reset();
    onClose();
  };

  const blockers = error instanceof ApiError && error.code === 'HAS_ACTIVE_DEPENDENTS'
    ? (error.details as { total: number; items: Blocker[] })
    : null;
  const stale = error instanceof ApiError && error.code === 'STALE_VERSION';

  return (
    <ConfirmDialog
      open={!!record}
      onClose={close}
      onConfirm={() => {
        if (!record) return;
        if (stale) {
          // The row in the table is out of date: refresh it, then let the user try again.
          void invalidate().then(close);
          return;
        }
        mutation.mutate(record, { onSuccess: close });
      }}
      loading={mutation.isPending}
      title={record ? `${deactivating ? 'Deactivate' : 'Activate'} ${record.name}?` : ''}
      tone={deactivating && !stale ? 'destructive' : 'primary'}
      confirmLabel={stale ? 'Reload' : deactivating ? 'Deactivate' : 'Activate'}
      description={deactivating
        ? `It stays visible on existing records but can no longer be chosen for new ones. You can activate it again at any time.`
        : `It becomes available to choose again.`}
    >
      {blockers && (
        <InlineAlert tone="warning" title={`Still in use by ${blockers.total} active record${blockers.total === 1 ? '' : 's'}`}>
          <p>Deactivate or change these first:</p>
          <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5">
            {blockers.items.map((b) => (
              <li key={`${b.type}:${b.id}`}><span className="text-xs text-amber-800">{BLOCKER_LABEL[b.type]}:</span> {b.name}</li>
            ))}
          </ul>
          {blockers.total > blockers.items.length && (
            <p className="mt-1 text-xs">…and {blockers.total - blockers.items.length} more.</p>
          )}
        </InlineAlert>
      )}
      {stale && <InlineAlert tone="warning">This record was changed by someone else. Reload to see the latest version.</InlineAlert>}
      {error && !blockers && !stale && <InlineAlert>{error instanceof ApiError ? error.message : 'Could not change the status.'}</InlineAlert>}
    </ConfirmDialog>
  );
}

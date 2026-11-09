import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { leaveApi } from '@/services/leave-api';

/** Every leave query key starts with 'leave', so one invalidation refreshes all of them. */
export const leaveKey = (...parts: unknown[]) => ['leave', ...parts] as const;

export function useInvalidateLeave() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['leave'] }),
    qc.invalidateQueries({ queryKey: ['workflows'] }),
  ]);
}

export const useLookups = (enabled = true) =>
  useQuery({ queryKey: leaveKey('lookups'), queryFn: leaveApi.lookups, staleTime: 60_000, enabled });

export const errorMessage = (e: unknown, fallback = 'Something went wrong. Please try again.') =>
  e instanceof ApiError ? e.message : fallback;

/** A write with the standard success and failure notifications, then a refresh. */
export function useLeaveAction<V, R = unknown>(fn: (v: V) => Promise<R>, opts: { success?: string; onDone?: (r: R) => void } = {}) {
  const invalidate = useInvalidateLeave();
  const { notify } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r) => {
      await invalidate();
      if (opts.success) notify({ tone: 'success', title: opts.success });
      opts.onDone?.(r);
    },
    onError: (e) => notify({ tone: 'error', title: 'That didn’t work', description: errorMessage(e) }),
  });
}

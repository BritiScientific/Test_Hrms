import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { workScheduleApi, type ResourceApi } from './api';
import type { BaseRecord, ListParams } from './types';

/** Query keys: everything under ['work-schedule', ...] so one invalidation refreshes every tab and picker. */
export const wsKeys = {
  all: ['work-schedule'] as const,
  list: (resource: string, q: ListParams) => ['work-schedule', resource, 'list', q] as const,
  options: (what: 'shifts' | 'work-types') => ['work-schedule', 'options', what] as const,
};

export function useConfigList<T>(resource: string, client: ResourceApi<T>, q: ListParams) {
  return useQuery({
    queryKey: wsKeys.list(resource, q),
    queryFn: () => client.list(q),
    placeholderData: keepPreviousData,
  });
}

/**
 * Invalidate the whole module after a change (a shift rename shows up in the
 * schedules and rotations that use it), plus employee screens that show the
 * employee type, plus the audit feed.
 */
export function useInvalidateWorkSchedule() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: wsKeys.all }),
    qc.invalidateQueries({ queryKey: ['employees'] }),
    qc.invalidateQueries({ queryKey: ['audit'] }),
  ]);
}

/** Activate / deactivate with a toast. Errors are left to the caller (the dialog shows blockers). */
export function useStatusMutation<T extends BaseRecord>(client: ResourceApi<T>, label: string) {
  const invalidate = useInvalidateWorkSchedule();
  const { notify } = useToast();
  return useMutation({
    mutationFn: (r: T) => client.setStatus(r.id, { isActive: !r.isActive, updatedAt: r.updatedAt }),
    onSuccess: async (saved) => {
      await invalidate();
      notify({ tone: 'success', title: `${label} ${saved.isActive ? 'activated' : 'deactivated'}` });
    },
  });
}

export const useShiftOptions = (enabled = true) =>
  useQuery({ queryKey: wsKeys.options('shifts'), queryFn: workScheduleApi.shiftOptions, enabled, staleTime: 30_000 });

export const useWorkTypeOptions = (enabled = true) =>
  useQuery({ queryKey: wsKeys.options('work-types'), queryFn: workScheduleApi.workTypeOptions, enabled, staleTime: 30_000 });

/** Server field errors (zod or service) mapped for react-hook-form; nested zod keys are flattened by the API. */
export function serverFieldErrors(e: unknown): Record<string, string> {
  return e instanceof ApiError ? e.fieldErrors : {};
}

export const isStale = (e: unknown) => e instanceof ApiError && e.code === 'STALE_VERSION';

export const errorText = (e: unknown, fallback = 'Could not save. Please try again.') =>
  e instanceof ApiError ? e.message : fallback;

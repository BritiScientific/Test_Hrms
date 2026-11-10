import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/Toast';
import { api, ApiError } from '@/services/api-client';
import { pickerApi, type AssignmentApi } from './api';
import type { AssignmentFilters, Paged, PickerFilters } from './types';

export const asKeys = {
  list: (path: string, f: AssignmentFilters, page: number) => ['work-schedule', 'assignments', path, f, page] as const,
  picker: (kind: string, f: PickerFilters, page: number) => ['work-schedule', 'picker', kind, f, page] as const,
  pickerOptions: ['work-schedule', 'picker', 'options'] as const,
  patterns: (kind: string) => ['work-schedule', 'assignment-patterns', kind] as const,
};

export function useAssignmentList(path: string, client: AssignmentApi, f: AssignmentFilters, page: number, limit: number) {
  return useQuery({
    queryKey: [...asKeys.list(path, f, page), limit],
    queryFn: () => client.list(f, page, limit),
    placeholderData: keepPreviousData,
  });
}

export interface PatternOption {
  id: number; name: string; isActive: boolean; sequenceSummary: string;
}

/** Active patterns for the create form (the first 100, which is the pattern list's page cap). */
export function usePatternOptions(kind: 'rotating-shift' | 'rotating-work-type', enabled = true) {
  const resource = kind === 'rotating-shift' ? 'rotating-shifts' : 'rotating-work-types';
  return useQuery({
    queryKey: asKeys.patterns(kind),
    queryFn: () => api.get<Paged<PatternOption>>(`/work-schedule/${resource}?status=active&limit=100`),
    enabled,
    staleTime: 30_000,
    select: (p) => p.items,
  });
}

export const usePickerOptions = (enabled = true) =>
  useQuery({ queryKey: asKeys.pickerOptions, queryFn: pickerApi.options, enabled, staleTime: 60_000 });

export function usePickerList(kind: string, f: PickerFilters, page: number, limit: number, enabled: boolean) {
  return useQuery({
    queryKey: [...asKeys.picker(kind, f, page), limit],
    queryFn: () => pickerApi.list(kind, f, page, limit),
    enabled,
    placeholderData: keepPreviousData,
  });
}

/** After any change: every work schedule query (assignments, the patterns' "in use" counts) and the audit feed. */
export function useInvalidateAssignments() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['work-schedule'] }),
    qc.invalidateQueries({ queryKey: ['audit'] }),
  ]);
}

export const isStale = (e: unknown) => e instanceof ApiError && e.code === 'STALE_VERSION';

export function useAssignmentMutation<V>(fn: (v: V) => Promise<unknown>, success: string) {
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await invalidate();
      notify({ tone: 'success', title: success });
    },
  });
}

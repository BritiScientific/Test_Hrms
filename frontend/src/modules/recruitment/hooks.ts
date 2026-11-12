import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/services/api-client';
import { recruitmentApi } from './api';

/** Everything lives under ['recruitment', ...] so one invalidation refreshes pipeline, candidates and interviews together. */
export const recKeys = {
  all: ['recruitment'] as const,
  recruitments: (q: object) => ['recruitment', 'recruitments', q] as const,
  recruitment: (id: number) => ['recruitment', 'recruitment', id] as const,
  applications: (q: object) => ['recruitment', 'applications', q] as const,
  application: (id: number) => ['recruitment', 'application', id] as const,
  candidates: (q: object) => ['recruitment', 'candidates', q] as const,
  candidate: (id: number) => ['recruitment', 'candidate', id] as const,
  interviews: (q: object) => ['recruitment', 'interviews', q] as const,
  interview: (id: number) => ['recruitment', 'interview', id] as const,
  lookup: (name: string, q?: object) => ['recruitment', 'lookup', name, q ?? {}] as const,
  config: (name: string, q?: object) => ['recruitment', 'config', name, q ?? {}] as const,
};

export function useInvalidateRecruitment() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: recKeys.all });
}

export const useRecruitments = (q: { status?: string; search?: string } = {}) =>
  useQuery({ queryKey: recKeys.recruitments(q), queryFn: () => recruitmentApi.recruitments.list(q), placeholderData: keepPreviousData });

export const useRecruitment = (id: number | null) =>
  useQuery({ queryKey: recKeys.recruitment(id ?? 0), queryFn: () => recruitmentApi.recruitments.get(id!), enabled: id !== null });

export const useApplications = (q: Record<string, string | number | undefined>, enabled = true) =>
  useQuery({ queryKey: recKeys.applications(q), queryFn: () => recruitmentApi.applications.list(q), enabled, placeholderData: keepPreviousData });

export const useApplication = (id: number | null) =>
  useQuery({ queryKey: recKeys.application(id ?? 0), queryFn: () => recruitmentApi.applications.get(id!), enabled: id !== null });

export const useCandidates = (q: Record<string, string | number | undefined>) =>
  useQuery({ queryKey: recKeys.candidates(q), queryFn: () => recruitmentApi.candidates.list(q), placeholderData: keepPreviousData });

export const useCandidate = (id: number) =>
  useQuery({ queryKey: recKeys.candidate(id), queryFn: () => recruitmentApi.candidates.get(id) });

export const useInterviews = (q: Record<string, string | number | boolean | undefined>) =>
  useQuery({ queryKey: recKeys.interviews(q), queryFn: () => recruitmentApi.interviews.list(q), placeholderData: keepPreviousData });

export const useInterview = (id: number | null) =>
  useQuery({ queryKey: recKeys.interview(id ?? 0), queryFn: () => recruitmentApi.interviews.get(id!), enabled: id !== null });

export const useJobPositionOptions = (enabled = true) =>
  useQuery({ queryKey: recKeys.lookup('positions'), queryFn: recruitmentApi.lookups.jobPositions, enabled, staleTime: 30_000 });
export const useSurveyOptions = (enabled = true) =>
  useQuery({ queryKey: recKeys.lookup('surveys'), queryFn: recruitmentApi.lookups.surveyTemplates, enabled, staleTime: 30_000 });
export const useRejectionReasonOptions = (enabled = true) =>
  useQuery({ queryKey: recKeys.lookup('reasons'), queryFn: recruitmentApi.lookups.rejectionReasons, enabled, staleTime: 30_000 });
export const useDepartmentOptions = (enabled = true) =>
  useQuery({ queryKey: recKeys.lookup('departments'), queryFn: recruitmentApi.lookups.departments, enabled, staleTime: 60_000 });

export const errorText = (e: unknown, fallback = 'Could not save. Please try again.') => (e instanceof ApiError ? e.message : fallback);
export const isStale = (e: unknown) => e instanceof ApiError && e.code === 'STALE_VERSION';
export const fieldErrors = (e: unknown): Record<string, string> => (e instanceof ApiError ? e.fieldErrors : {});

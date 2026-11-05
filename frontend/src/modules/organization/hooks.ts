import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { organizationApi } from '@/services/organization-api';
import type { OrganizationChartQuery } from '@/types/api';

export const orgKeys = {
  profile: ['organization', 'profile'] as const,
  settings: ['organization', 'settings'] as const,
  options: ['organization', 'options'] as const,
  onboarding: ['organization', 'onboarding'] as const,
  // Under 'employees' on purpose: every employee change invalidates that prefix
  // (useInvalidateEmployees), so a new reporting manager refreshes the chart too.
  chart: (q: OrganizationChartQuery) => ['employees', 'org-chart', q] as const,
};

export const useOrgChart = (q: OrganizationChartQuery) =>
  useQuery({ queryKey: orgKeys.chart(q), queryFn: () => organizationApi.chart(q), placeholderData: keepPreviousData });

export const useOrgProfile = (enabled = true) =>
  useQuery({ queryKey: orgKeys.profile, queryFn: organizationApi.profile, enabled });

export const useOrgSettings = (enabled = true) =>
  useQuery({ queryKey: orgKeys.settings, queryFn: organizationApi.settings, enabled });

export const useOrgOptions = () =>
  useQuery({ queryKey: orgKeys.options, queryFn: organizationApi.options, staleTime: Infinity });

export const useOnboardingStatus = (enabled = true) =>
  useQuery({ queryKey: orgKeys.onboarding, queryFn: organizationApi.onboardingStatus, enabled });

import { useQuery } from '@tanstack/react-query';
import { organizationApi } from '@/services/organization-api';

export const orgKeys = {
  profile: ['organization', 'profile'] as const,
  settings: ['organization', 'settings'] as const,
  options: ['organization', 'options'] as const,
  onboarding: ['organization', 'onboarding'] as const,
};

export const useOrgProfile = (enabled = true) =>
  useQuery({ queryKey: orgKeys.profile, queryFn: organizationApi.profile, enabled });

export const useOrgSettings = (enabled = true) =>
  useQuery({ queryKey: orgKeys.settings, queryFn: organizationApi.settings, enabled });

export const useOrgOptions = () =>
  useQuery({ queryKey: orgKeys.options, queryFn: organizationApi.options, staleTime: Infinity });

export const useOnboardingStatus = (enabled = true) =>
  useQuery({ queryKey: orgKeys.onboarding, queryFn: organizationApi.onboardingStatus, enabled });

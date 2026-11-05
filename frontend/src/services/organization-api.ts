import type {
  OnboardingStatus, OrganizationChart, OrganizationChartQuery, OrganizationOptions, OrganizationProfile,
  OrganizationSettings, ProfilePatch,
} from '@/types/api';
import { api, apiRequest, qs } from './api-client';

export const organizationApi = {
  chart: (q: OrganizationChartQuery) => api.get<OrganizationChart>(`/organization/chart${qs({ ...q })}`),
  profile: () => api.get<OrganizationProfile>('/organization'),
  updateProfile: (patch: ProfilePatch & { version?: number }) => api.patch<OrganizationProfile>('/organization', patch),
  settings: () => api.get<OrganizationSettings>('/organization/settings'),
  updateSettings: (patch: Partial<OrganizationSettings>) => api.patch<OrganizationSettings>('/organization/settings', patch),
  options: () => api.get<OrganizationOptions>('/organization/options'),
  onboardingStatus: () => api.get<OnboardingStatus>('/organization/onboarding-status'),
  completeOnboarding: () => api.post<OnboardingStatus>('/organization/onboarding/complete'),
  uploadLogo: (file: File) =>
    apiRequest<{ url: string }>('/organization/logo', { method: 'POST', raw: file, contentType: file.type }),
  removeLogo: () => api.del('/organization/logo'),
};

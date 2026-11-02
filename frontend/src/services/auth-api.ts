import type { InvitationInfo, LoginSuccess, Me, SessionInfo } from '@/types/api';
import { api } from './api-client';

export const authApi = {
  me: () => api.get<Me>('/me', { silent401: true }),
  login: (email: string, password: string) => api.post<LoginSuccess>('/auth/login', { email, password }),
  selectTenant: (selectionToken: string, tenantId: number) =>
    api.post<LoginSuccess>('/auth/select-tenant', { selectionToken, tenantId }),
  switchTenant: (tenantId: number) => api.post<LoginSuccess>('/auth/switch-tenant', { tenantId }),
  logout: () => api.post<void>('/auth/logout', undefined, { silent401: true }),
  sessions: () => api.get<SessionInfo[]>('/auth/sessions'),
  revokeSession: (id: string) => api.del(`/auth/sessions/${encodeURIComponent(id)}`),
  invitation: (token: string) => api.get<InvitationInfo>(`/onboarding/invitations/${encodeURIComponent(token)}`, { silent401: true }),
  activate: (token: string, password: string, fullName?: string) =>
    api.post<LoginSuccess>('/onboarding/activate', { token, password, fullName }, { silent401: true }),
};

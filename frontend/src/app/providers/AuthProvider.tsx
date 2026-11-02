import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, onSessionLost } from '@/services/api-client';
import { authApi } from '@/services/auth-api';
import type { Me } from '@/types/api';

/**
 * Client-side session state. The source of truth is the server: GET /me says
 * who the user is, which organization the session belongs to and which
 * permissions are effective right now. Permission checks here only shape the
 * UI (menus, buttons, route guards); the API enforces every request.
 */

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous' | 'expired';

interface AuthContextValue {
  status: AuthStatus;
  me: Me | null;
  can: (code: string) => boolean;
  canAny: (...codes: string[]) => boolean;
  /** Re-load /me (after login, tenant switch, onboarding…). */
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
export const ME_KEY = ['me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [expired, setExpired] = useState(false);

  const meQuery = useQuery({
    queryKey: ME_KEY,
    queryFn: authApi.me,
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // Any API call that discovers the session is gone flips us to "expired".
  useEffect(() => onSessionLost(() => {
    setExpired(true);
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    qc.setQueryData(ME_KEY, null);
  }), [qc]);

  // A background /me refresh that fails with 401 after we had a session = session ended.
  const hadSession = !!meQuery.data;
  useEffect(() => {
    const e = meQuery.error;
    if (hadSession && e instanceof ApiError && e.status === 401) {
      setExpired(true);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
    }
  }, [meQuery.error, meQuery.errorUpdatedAt, hadSession, qc]);

  const me = meQuery.data ?? null;
  const status: AuthStatus = expired
    ? 'expired'
    : meQuery.isPending
      ? 'loading'
      : me
        ? 'authenticated'
        : 'anonymous';

  const refresh = useCallback(async () => {
    try {
      const fresh = await qc.fetchQuery({ queryKey: ME_KEY, queryFn: authApi.me, staleTime: 0 });
      setExpired(false);
      return fresh;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        qc.setQueryData(ME_KEY, null);
        return null;
      }
      throw e;
    }
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the cookie is cleared server-side; local state is cleared regardless */
    }
    qc.clear();
    qc.setQueryData(ME_KEY, null);
    setExpired(false);
  }, [qc]);

  const value = useMemo<AuthContextValue>(() => {
    const perms = new Set(me?.permissions ?? []);
    return {
      status,
      me,
      can: (code) => perms.has(code),
      canAny: (...codes) => codes.some((c) => perms.has(c)),
      refresh,
      logout,
    };
  }, [status, me, refresh, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

/** The authenticated user (only call below RequireAuth). */
export function useMe(): Me {
  const { me } = useAuth();
  if (!me) throw new Error('useMe called without a session');
  return me;
}

/** Permission groups used across the UI. */
export const PERMS = {
  rolesView: ['roles.view', 'roles.manage', 'roles.assign'],
  orgProfile: ['organization.view', 'organization.update'],
  orgSettings: ['organization.settings.view', 'organization.settings.update'],
  audit: ['roles.view', 'roles.manage', 'roles.assign', 'organization.view', 'organization.update',
    'organization.settings.view', 'organization.settings.update'],
} as const;

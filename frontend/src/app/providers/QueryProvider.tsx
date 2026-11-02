import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError } from '@/services/api-client';

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: true,
        // Never retry auth/permission/validation failures; retry transient ones once.
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 1,
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();

export function QueryProvider({ children, client = queryClient }: { children: ReactNode; client?: QueryClient }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

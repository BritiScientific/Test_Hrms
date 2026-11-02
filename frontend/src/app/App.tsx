import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { ToastProvider } from '@/components/ui/Toast';
import { AuthProvider } from './providers/AuthProvider';
import { QueryProvider } from './providers/QueryProvider';
import { createRouter } from './router';

export function App() {
  const [router] = useState(createRouter);
  return (
    <QueryProvider>
      <AuthProvider>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </AuthProvider>
    </QueryProvider>
  );
}

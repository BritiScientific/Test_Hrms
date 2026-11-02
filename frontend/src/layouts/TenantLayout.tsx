import { useEffect } from 'react';
import { useLocation } from 'react-router';
import { rememberPortalPath } from '@/utils/navigation';
import { AppShell } from './AppShell';

/** Main portal area (dashboard and future modules). */
export function TenantLayout() {
  const loc = useLocation();
  useEffect(() => rememberPortalPath(loc.pathname + loc.search), [loc.pathname, loc.search]);
  return <AppShell variant="main" />;
}

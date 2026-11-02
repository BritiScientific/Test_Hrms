import { useNavigate } from 'react-router';
import { portalReturnPath } from '@/utils/navigation';
import { AppShell } from './AppShell';

/**
 * Settings is its own area: a separate settings sidebar under the same top
 * bar. Back returns to the portal page the user came from (falls back to
 * /dashboard after a reload or when settings was opened directly).
 */
export function SettingsLayout() {
  const navigate = useNavigate();
  return <AppShell variant="settings" onBack={() => navigate(portalReturnPath())} />;
}

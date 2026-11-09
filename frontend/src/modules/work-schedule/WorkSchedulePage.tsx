import { Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Card } from '@/components/ui/Card';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { usePageTitle } from '@/hooks/usePageTitle';
import { WORK_SCHEDULE_TABS, tabPath, tabPermissions } from './tabs';

/**
 * Settings > Work Schedule: the layout around the six tabs. It stays mounted
 * while the user switches tabs (each tab is a child route with its own
 * permission guard and breadcrumb), so keyboard focus stays in the tab strip.
 * Only tabs the user may view are shown.
 */
export default function WorkSchedulePage() {
  const { canAny } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visible = WORK_SCHEDULE_TABS.filter((t) => canAny(...tabPermissions(t)));
  const active = WORK_SCHEDULE_TABS.find((t) => pathname.endsWith(`/${t.key}`));
  usePageTitle(active ? `${active.label} · Work Schedule` : 'Work Schedule');

  return (
    <>
      <PageHeader title="Work Schedule" description={active?.description} />
      <Card>
        {visible.length > 0 && active && (
          <div className="px-2 pt-2 sm:px-3">
            <Tabs
              label="Work schedule settings"
              idBase="ws"
              tabs={visible.map((t) => ({ key: t.key, label: t.label }))}
              active={active.key}
              onChange={(k) => navigate(tabPath(k))}
            />
          </div>
        )}
        <TabPanel active={active?.key ?? 'none'} idBase="ws">
          <Outlet />
        </TabPanel>
      </Card>
    </>
  );
}

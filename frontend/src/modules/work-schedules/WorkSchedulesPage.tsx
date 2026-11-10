import { Outlet, useLocation, useNavigate } from 'react-router';
import { useAuth } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Card } from '@/components/ui/Card';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ASSIGN_TABS, assignTabPath, assignTabPermissions } from './tabs';

/**
 * Settings > Work Schedule > Work Schedules: the layout around the two
 * assignment tabs. Each tab is a child route with its own permission guard;
 * only tabs the user may view are shown.
 */
export default function WorkSchedulesPage() {
  const { canAny } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visible = ASSIGN_TABS.filter((t) => canAny(...assignTabPermissions(t)));
  const active = ASSIGN_TABS.find((t) => pathname.endsWith(`/${t.key}`));
  usePageTitle(active ? `${active.label} · Work Schedules` : 'Work Schedules');

  return (
    <>
      <PageHeader title="Work Schedules" description={active?.description} />
      <Card>
        {visible.length > 0 && active && (
          <div className="px-2 pt-2 sm:px-3">
            <Tabs label="Work schedule assignments" idBase="wsa" tabs={visible.map((t) => ({ key: t.key, label: t.label }))}
              active={active.key} onChange={(k) => navigate(assignTabPath(k))} />
          </div>
        )}
        <TabPanel active={active?.key ?? 'none'} idBase="wsa"><Outlet /></TabPanel>
      </Card>
    </>
  );
}

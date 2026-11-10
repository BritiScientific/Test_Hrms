import { useLocation } from 'react-router';
import { useAuth } from '@/app/providers/AuthProvider';
import { AssignmentList } from './AssignmentList';
import { ASSIGN_TABS } from './tabs';

/** Child route for one assignment tab (the router wraps it in that tab's .view guard). */
export default function WorkSchedulesTab() {
  const { can } = useAuth();
  const { pathname } = useLocation();
  const tab = ASSIGN_TABS.find((t) => pathname.endsWith(`/${t.key}`));
  if (!tab) return null;
  // key: a fresh list (search, filters, page, selection) per tab.
  return <AssignmentList key={tab.key} tab={tab} canManage={can(tab.manage)} />;
}

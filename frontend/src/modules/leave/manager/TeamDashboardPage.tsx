import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarCheck, CalendarX2, ClipboardCheck, UserCheck, Users } from 'lucide-react';
import { PageHeader } from '@/components/feedback/States';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import { leaveKey } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { BarList, LeaveList, QueryState, StatCard } from '../components/shared';
import { days } from '../leave-format';

export default function TeamDashboardPage() {
  usePageTitle('Team Leave Dashboard');
  const q = useQuery({ queryKey: leaveKey('team-dashboard'), queryFn: leaveApi.teamDashboard });
  const d = q.data;
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="Leave Dashboard" description={d ? `Your team, direct and indirect reports, for ${d.year}` : undefined} />
      <section aria-label="Team figures" className="grid grid-cols-1 gap-4 xs:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<ClipboardCheck />} label="Pending approvals" value={d?.pendingApprovals} hint="Waiting for you" loading={q.isPending} to="/leave/team/requests" />
        <StatCard icon={<CalendarX2 />} label="On leave today" value={d?.availability.onLeave} hint={d ? `of ${d.teamSize} people` : undefined} loading={q.isPending} />
        <StatCard icon={<UserCheck />} label="Available today" value={d ? `${d.availability.availablePercent}%` : undefined}
          hint={d ? `${d.availability.available} people` : undefined} loading={q.isPending} />
        <StatCard icon={<CalendarCheck />} label="Approved this year" value={days(d?.approvedStats.days)} hint={d ? `days across ${d.approvedStats.requests} requests` : undefined} loading={q.isPending} />
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader title="On leave today" />
          <QueryState query={q} isEmpty={(x) => x.onLeaveToday.length === 0} emptyIcon={<Users />} emptyTitle="Everyone is in today">
            {(x) => <LeaveList items={x.onLeaveToday} onOpen={setOpenId} showEmployee />}
          </QueryState>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Upcoming absences" description="Next 30 days" actions={<Link to="/leave/team/requests?tab=all" className="text-sm font-medium text-primary hover:underline">All requests</Link>} />
          <QueryState query={q} isEmpty={(x) => x.upcomingAbsences.length === 0} emptyIcon={<CalendarCheck />} emptyTitle="No absences coming up">
            {(x) => <LeaveList items={x.upcomingAbsences} onOpen={setOpenId} showEmployee />}
          </QueryState>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Leave by type" description="Approved this year" />
          <QueryState query={q} isEmpty={(x) => x.byType.length === 0} emptyTitle="No approved leave yet">
            {(x) => <CardBody><BarList items={x.byType.map((t) => ({ label: t.leaveTypeName, value: Number(t.days) }))} /></CardBody>}
          </QueryState>
        </Card>
      </div>
    </div>
  );
}

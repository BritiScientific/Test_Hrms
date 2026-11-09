import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarCheck, CalendarX2, Hourglass, PartyPopper, Users, XCircle } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { EmptyState, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import { formatDate } from '@/utils/format';
import { leaveKey } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { BarList, LeaveList, QueryState, StatCard } from '../components/shared';

export default function AdminDashboardPage() {
  usePageTitle('Leave Dashboard');
  const me = useMe();
  const q = useQuery({ queryKey: leaveKey('admin-dashboard'), queryFn: leaveApi.adminDashboard });
  const d = q.data;
  const [openId, setOpenId] = useState<number | null>(null);

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="Leave Dashboard" description={d ? `The whole organization, leave year ${d.year}` : undefined} />
      <section aria-label="Organization figures" className="grid grid-cols-1 gap-4 xs:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <StatCard icon={<Users />} label="Total employees" value={d?.totalEmployees} loading={q.isPending} />
        <StatCard icon={<CalendarX2 />} label="On leave today" value={d?.onLeaveToday.length} loading={q.isPending} />
        <StatCard icon={<Hourglass />} label="Pending requests" value={d?.counts.pending} loading={q.isPending} to="/leave/admin/requests?status=pending" />
        <StatCard icon={<CalendarCheck />} label="Approved" value={d?.counts.approved} loading={q.isPending} to="/leave/admin/requests?status=approved" />
        <StatCard icon={<XCircle />} label="Rejected" value={d?.counts.rejected} loading={q.isPending} to="/leave/admin/requests?status=rejected" />
      </section>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader title="Leave by department" description="Days taken this year" />
          <QueryState query={q} isEmpty={(x) => x.byDepartment.length === 0} emptyTitle="No approved leave yet">
            {(x) => <CardBody><BarList items={x.byDepartment.map((r) => ({ label: r.departmentName, value: Number(r.days) }))} /></CardBody>}
          </QueryState>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Leave by type" description="Days taken this year" />
          <QueryState query={q} isEmpty={(x) => x.byType.length === 0} emptyTitle="No approved leave yet">
            {(x) => <CardBody><BarList items={x.byType.map((r) => ({ label: r.leaveTypeName, value: Number(r.days) }))} /></CardBody>}
          </QueryState>
        </Card>
        <Card className="min-w-0">
          <CardHeader title="Upcoming holidays" actions={<Link to="/leave/admin/calendar" className="text-sm font-medium text-primary hover:underline">Calendar</Link>} />
          {d && d.upcomingHolidays.length === 0 && <EmptyState icon={<PartyPopper />} title="None in the next few months" />}
          {d && d.upcomingHolidays.length > 0 && (
            <CardBody>
              <ul className="space-y-3">
                {d.upcomingHolidays.map((h) => (
                  <li key={h.holidayDate + h.name} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{h.name}</span>
                      <span className="text-xs text-muted">{formatDate(h.holidayDate, me.tenant.preferences)} · {h.calendarName}</span>
                    </span>
                    {h.isOptional && <Badge tone="violet">Optional</Badge>}
                  </li>
                ))}
              </ul>
            </CardBody>
          )}
        </Card>
        <Card className="min-w-0 lg:col-span-1 xl:col-span-1">
          <CardHeader title="On leave today" />
          <QueryState query={q} isEmpty={(x) => x.onLeaveToday.length === 0} emptyTitle="Nobody is on leave today">
            {(x) => <LeaveList items={x.onLeaveToday} onOpen={setOpenId} showEmployee />}
          </QueryState>
        </Card>
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader title="Upcoming approved leave" description="Next 30 days" />
          <QueryState query={q} isEmpty={(x) => x.upcomingLeaves.length === 0} emptyTitle="No approved leave coming up">
            {(x) => <LeaveList items={x.upcomingLeaves} onOpen={setOpenId} showEmployee />}
          </QueryState>
        </Card>
      </div>
    </div>
  );
}

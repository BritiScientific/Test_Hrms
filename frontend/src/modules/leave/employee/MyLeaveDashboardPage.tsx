import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { CalendarCheck, CalendarDays, CalendarPlus, Clock, Hourglass, PartyPopper, Wallet } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { ButtonLink } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import { formatDate } from '@/utils/format';
import { leaveKey } from '../hooks';
import { RequestDetailDialog } from '../components/RequestDetailDialog';
import { LeaveList, QueryState, StatCard } from '../components/shared';
import { days } from '../leave-format';

export default function MyLeaveDashboardPage() {
  usePageTitle('My Leave Dashboard');
  const me = useMe();
  const { can } = useAuth();
  const q = useQuery({ queryKey: leaveKey('my-dashboard'), queryFn: leaveApi.myDashboard });
  const [openId, setOpenId] = useState<number | null>(null);
  const t = q.data?.totals;

  return (
    <div>
      <RequestDetailDialog requestId={openId} onClose={() => setOpenId(null)} />
      <PageHeader title="My Leave Dashboard" description={q.data ? `Your leave for ${q.data.year}` : undefined}
        actions={can('leave.request.create_self') && <ButtonLink to="/leave/apply" icon={<CalendarPlus className="size-4" />}>Apply for leave</ButtonLink>} />

      <section aria-label="Leave totals" className="grid grid-cols-1 gap-4 xs:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={<CalendarDays />} label="Total entitlement" value={days(t?.entitlement)} hint="Paid leave this year" loading={q.isPending} />
        <StatCard icon={<Wallet />} label="Available" value={days(t?.available)} hint="Ready to use" loading={q.isPending} to="/leave/my-requests" />
        <StatCard icon={<CalendarCheck />} label="Used" value={days(t?.used)} hint="Approved and deducted" loading={q.isPending} />
        <StatCard icon={<Hourglass />} label="Pending" value={days(t?.pending)} hint="Held until a decision" loading={q.isPending} />
      </section>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <div className="min-w-0 space-y-5 xl:col-span-2">
          <Card>
            <CardHeader title="Balance by leave type" actions={<Link to="/leave/my-requests" className="text-sm font-medium text-primary hover:underline">Details</Link>} />
            <QueryState query={q} isEmpty={(d) => d.balances.length === 0} emptyTitle="No leave types yet"
              emptyText="HR hasn’t set up a leave policy for you. Contact them if this looks wrong.">
              {(d) => (
                <ul className="divide-y divide-line">
                  {d.balances.map((b) => {
                    const credited = b.opening + b.accrued + b.carriedForward + b.adjusted + b.compOff;
                    const total = Math.max(credited, b.annualEntitlement, 1);
                    return (
                      <li key={b.leaveTypeId} className="px-4 py-3 sm:px-5">
                        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3">
                          <span className="text-sm font-medium text-ink">
                            {b.leaveTypeName}{!b.isPaid && <Badge tone="neutral" className="ml-2">Unpaid</Badge>}
                          </span>
                          <span className="text-sm text-muted tabular">
                            {b.isPaid ? <><strong className="text-ink">{days(b.available)}</strong> available</> : `${days(b.used)} taken`}
                          </span>
                        </div>
                        {b.isPaid && (
                          <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" role="img"
                            aria-label={`${days(b.used)} used, ${days(b.pending)} pending, ${days(b.available)} available`}>
                            <div className="bg-slate-400" style={{ width: `${(b.used / total) * 100}%` }} />
                            <div className="bg-amber-400" style={{ width: `${(b.pending / total) * 100}%` }} />
                            <div className="bg-primary" style={{ width: `${(Math.max(b.available, 0) / total) * 100}%` }} />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </QueryState>
          </Card>
          <Card>
            <CardHeader title="Recent requests" actions={<Link to="/leave/my-requests?tab=requests" className="text-sm font-medium text-primary hover:underline">View all</Link>} />
            <QueryState query={q} isEmpty={(d) => d.recentRequests.length === 0} emptyIcon={<Clock />} emptyTitle="No requests yet" emptyText="Requests you submit will appear here.">
              {(d) => <LeaveList items={d.recentRequests} onOpen={setOpenId} />}
            </QueryState>
          </Card>
        </div>

        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader title="Upcoming approved leave" />
            <QueryState query={q} isEmpty={(d) => d.upcomingLeaves.length === 0} emptyIcon={<CalendarCheck />} emptyTitle="Nothing coming up">
              {(d) => <LeaveList items={d.upcomingLeaves} onOpen={setOpenId} />}
            </QueryState>
          </Card>
          <Card>
            <CardHeader title="Upcoming holidays" actions={<Link to="/leave/holidays" className="text-sm font-medium text-primary hover:underline">Calendar</Link>} />
            {q.data && q.data.upcomingHolidays.length === 0 && <EmptyState icon={<PartyPopper />} title="No holidays in the next few months" />}
            {q.data && q.data.upcomingHolidays.length > 0 && (
              <CardBody>
                <ul className="space-y-3">
                  {q.data.upcomingHolidays.map((h) => (
                    <li key={h.day + h.name} className="flex items-start justify-between gap-3 text-sm">
                      <span className="min-w-0">
                        <span className="block font-medium text-ink">{h.name}</span>
                        <span className="text-xs text-muted">{formatDate(h.day, me.tenant.preferences)}</span>
                      </span>
                      {h.isOptional && <Badge tone="violet">Optional</Badge>}
                    </li>
                  ))}
                </ul>
              </CardBody>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

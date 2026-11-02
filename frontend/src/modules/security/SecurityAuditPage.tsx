import { useState } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, LogOut, Monitor } from 'lucide-react';
import { PERMS, useAuth, useMe } from '@/app/providers/AuthProvider';
import { EmptyState, ErrorState, LoadingBlock, PageHeader } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { authApi } from '@/services/auth-api';
import { rbacApi } from '@/services/rbac-api';
import { describeUserAgent, formatDateTime, relativeTime } from '@/utils/format';
import { auditActionLabel } from '@/utils/permissions';
import { AuditDiff } from './AuditDiff';

export default function SecurityAuditPage() {
  usePageTitle('Security & audit');
  const { canAny } = useAuth();
  return (
    <div>
      <PageHeader title="Security & audit" description="Your active sessions, and the record of administrative changes in this organization." />
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <SessionsCard />
        {canAny(...PERMS.audit) ? <AuditLogCard /> : (
          <Card><EmptyState icon={<History />} title="Audit log not available" description="Viewing the audit log requires an administrative role." /></Card>
        )}
      </div>
    </div>
  );
}

function SessionsCard() {
  const me = useMe();
  const qc = useQueryClient();
  const { notify } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['sessions'], queryFn: authApi.sessions });

  const revoke = async (id: string) => {
    setBusy(id);
    try {
      await authApi.revokeSession(id);
      await qc.invalidateQueries({ queryKey: ['sessions'] });
      notify({ tone: 'success', title: 'Session signed out' });
    } catch (e) {
      notify({ tone: 'error', title: 'Could not sign out that session', description: e instanceof ApiError ? e.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="self-start">
      <CardHeader title="Your sessions" description={`Signed in to ${me.tenant.displayName}`} />
      {q.isPending && <CardBody><LoadingBlock rows={3} /></CardBody>}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <ul className="divide-y divide-line">
          {q.data.map((s) => (
            <li key={s.id} className="flex items-start gap-3 px-4 py-3 sm:px-5">
              <Monitor className="mt-0.5 size-5 shrink-0 text-slate-400" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {describeUserAgent(s.userAgent)} {s.current && <Badge tone="success">This device</Badge>}
                </p>
                <p className="text-xs text-muted">
                  Signed in {formatDateTime(s.createdAt, me.tenant.preferences)}{s.ip && ` · ${s.ip}`}
                </p>
                <p className="text-xs text-muted">Expires {relativeTime(s.expiresAt)}</p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" loading={busy === s.id} icon={<LogOut className="size-3.5" />} onClick={() => revoke(s.id)}>
                  Sign out
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <CardBody className="border-t border-line text-xs text-muted">
        Sessions end after 15 minutes without activity and always after 12 hours. Role changes apply immediately — no new sign-in is required.
      </CardBody>
    </Card>
  );
}

const PAGE = 25;

function AuditLogCard() {
  const me = useMe();
  const [category, setCategory] = useState<'' | 'rbac' | 'organization'>('');
  const q = useInfiniteQuery({
    queryKey: ['audit', 'log', category],
    queryFn: ({ pageParam }) => rbacApi.auditEvents({ limit: PAGE, offset: pageParam, category: category || undefined }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => (last.hasMore ? pages.length * PAGE : undefined),
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card>
      <CardHeader
        title="Audit log"
        description="Append-only record of role, access and organization changes"
        actions={
          <Select value={category} onChange={(e) => setCategory(e.target.value as typeof category)} aria-label="Filter audit events" className="w-44">
            <option value="">All events</option>
            <option value="rbac">Roles & access</option>
            <option value="organization">Organization</option>
          </Select>
        }
      />
      {q.isPending && <CardBody><LoadingBlock rows={8} /></CardBody>}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && items.length === 0 && <EmptyState icon={<History />} title="No events recorded yet" />}
      {items.length > 0 && (
        <ol className="divide-y divide-line">
          {items.map((e) => (
            <li key={`${e.category}-${e.id}`} className="px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {auditActionLabel(e.action)}
                  <Badge tone={e.category === 'rbac' ? 'violet' : 'primary'}>{e.category === 'rbac' ? 'Access' : 'Organization'}</Badge>
                </p>
                <time className="text-xs text-muted tabular" dateTime={e.at}>{formatDateTime(e.at, me.tenant.preferences)}</time>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                by {e.actor_name ?? 'System'} · {e.target_type}{e.target_id ? ` #${e.target_id}` : ''}
                {e.request_id && <> · <span className="font-mono">{e.request_id.slice(0, 8)}</span></>}
              </p>
              <AuditDiff before={e.before_state} after={e.after_state} />
            </li>
          ))}
        </ol>
      )}
      {q.hasNextPage && (
        <CardBody className="border-t border-line">
          <Button variant="outline" className="w-full" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button>
        </CardBody>
      )}
    </Card>
  );
}

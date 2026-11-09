import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Check, CornerUpLeft, Download, Paperclip, X } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { leaveApi } from '@/services/leave-api';
import type { LeaveRequestDetail } from '@/types/leave';
import { formatBytes, formatDate, formatDateTime } from '@/utils/format';
import { leaveKey, useLeaveAction } from '../hooks';
import { ACTION_LABEL, TXN_LABEL, dateRange, days, daysLabel } from '../leave-format';
import { LeaveStatusBadge, QueryState, ReasonDialog } from './shared';

type Prompt = 'approve' | 'reject' | 'return' | 'withdraw' | 'cancel' | 'hrCancel' | 'resubmit' | null;

const PROMPTS: Record<Exclude<Prompt, null>, { title: string; label: string; confirm: string; tone?: 'destructive'; optional?: boolean; description?: string }> = {
  approve: { title: 'Approve this request', label: 'Comment', confirm: 'Approve', optional: true },
  reject: { title: 'Reject this request', label: 'Reason for rejecting', confirm: 'Reject', tone: 'destructive', description: 'The held days go back to the employee’s balance.' },
  return: { title: 'Ask for more information', label: 'What do you need to know?', confirm: 'Send back', description: 'The request goes back to the employee. The days stay held until they answer.' },
  withdraw: { title: 'Withdraw this request', label: 'Reason', confirm: 'Withdraw', tone: 'destructive', optional: true, description: 'Approvers will no longer see it, and the held days go back to your balance.' },
  cancel: { title: 'Cancel approved leave', label: 'Reason for cancelling', confirm: 'Cancel leave', tone: 'destructive', description: 'The days are credited back to your balance.' },
  hrCancel: { title: 'Cancel on the employee’s behalf', label: 'Reason, kept in the audit log', confirm: 'Cancel request', tone: 'destructive', description: 'Any deducted or held days are returned, and the employee is notified.' },
  resubmit: { title: 'Answer and resubmit', label: 'Updated reason', confirm: 'Resubmit', description: 'The request starts approval again from the first step.' },
};

/** One request, for everyone who may see it. The server decides which actions are offered. */
export function RequestDetailDialog({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: leaveKey('request', requestId),
    queryFn: () => leaveApi.request(requestId!),
    enabled: requestId !== null,
  });
  const [prompt, setPrompt] = useState<Prompt>(null);
  const d = q.data;

  const act = useLeaveAction(async ({ kind, text }: { kind: Exclude<Prompt, null>; text: string }) => {
    const id = requestId!;
    const taskId = d?.myTask?.taskId;
    switch (kind) {
      case 'approve': case 'reject': case 'return':
        return leaveApi.actOnTask(taskId!, kind, text);
      case 'withdraw': return leaveApi.withdraw(id, text);
      case 'cancel': return leaveApi.cancel(id, text);
      case 'hrCancel': return leaveApi.hrCancel(id, text);
      case 'resubmit': return leaveApi.resubmit(id, { reason: text });
    }
  }, { success: 'Saved', onDone: () => setPrompt(null) });

  const p = prompt ? PROMPTS[prompt] : null;
  const footer = d && (
    <>
      <Button variant="outline" onClick={onClose}>Close</Button>
      {d.actions.canWithdraw && <Button variant="outline" onClick={() => setPrompt('withdraw')}>Withdraw</Button>}
      {d.actions.canCancel && <Button variant="outline" onClick={() => setPrompt('cancel')}>Cancel leave</Button>}
      {d.actions.canHrCancel && <Button variant="outline" onClick={() => setPrompt('hrCancel')}>Cancel request</Button>}
      {d.actions.canResubmit && <Button onClick={() => setPrompt('resubmit')}>Answer and resubmit</Button>}
      {d.myTask?.allowReturn && <Button variant="outline" icon={<CornerUpLeft className="size-4" />} onClick={() => setPrompt('return')}>Request information</Button>}
      {d.myTask?.allowReject && <Button variant="outline" icon={<X className="size-4" />} onClick={() => setPrompt('reject')}>Reject</Button>}
      {d.myTask && <Button icon={<Check className="size-4" />} onClick={() => setPrompt('approve')}>Approve</Button>}
    </>
  );

  return (
    <>
      <Dialog open={requestId !== null} onClose={onClose} size="lg" footer={footer}
        title={d ? `${d.leaveTypeName} · ${daysLabel(d.totalDays)}` : 'Leave request'}
        description={d ? d.employeeName : undefined}>
        <QueryState query={q} loadingRows={8}>{(r) => <DetailBody r={r} />}</QueryState>
      </Dialog>
      {p && prompt && (
        <ReasonDialog open title={p.title} label={p.label} description={p.description} confirmLabel={p.confirm} tone={p.tone}
          optional={p.optional} loading={act.isPending} onClose={() => setPrompt(null)}
          onConfirm={(text) => act.mutate({ kind: prompt, text })} />
      )}
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

function DetailBody({ r }: { r: LeaveRequestDetail }) {
  const me = useMe();
  const { canAny } = useAuth();
  const prefs = me.tenant.preferences;
  const nonCharged = r.days.filter((x) => Number(x.chargeableDays) === 0);
  const seesLedger = r.employeeId === me.employeeId || canAny('leave.request.view_all', 'leave.request.manage');

  return (
    <div className="space-y-5">
      {r.status === 'returned' && (
        <InlineAlert tone="warning" title="Sent back for more information">
          {r.workflow?.history.filter((h) => h.action === 'return').at(-1)?.comments ?? 'See the approval history below.'}
        </InlineAlert>
      )}
      <dl className="divide-y divide-line">
        <Row label="Status"><LeaveStatusBadge status={r.status} /></Row>
        <Row label="Dates">{dateRange(r, prefs)}</Row>
        <Row label="Chargeable days">{days(r.totalDays)}</Row>
        <Row label="Reason"><span className="whitespace-pre-wrap">{r.reason}</span></Row>
        {r.contactDetails && <Row label="Contact during leave">{r.contactDetails}</Row>}
        <Row label="Policy">{r.policyName}</Row>
        <Row label="Submitted">{formatDateTime(r.createdAt, prefs)}</Row>
        {r.departmentName && <Row label="Department">{r.departmentName}</Row>}
      </dl>

      {nonCharged.length > 0 && (
        <p className="text-xs text-muted">
          Not charged: {nonCharged.map((x) => `${formatDate(x.leaveDate, prefs)} (${x.holidayName ?? 'weekly off'})`).join(', ')}
        </p>
      )}

      {r.cancellation && (
        <InlineAlert tone="info" title={`Cancelled by ${r.cancellation.cancelledByName}${r.cancellation.isHrAction ? ' (HR)' : ''}`}>
          {r.cancellation.reason}{r.cancellation.daysReversed > 0 && ` · ${daysLabel(r.cancellation.daysReversed)} credited back`}
        </InlineAlert>
      )}

      {r.attachments.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Attachments</h3>
          <ul className="space-y-1">
            {r.attachments.map((a) => (
              <li key={a.id}>
                <a href={leaveApi.attachmentUrl(a.id)} className="inline-flex items-center gap-2 text-sm text-primary hover:underline">
                  <Paperclip className="size-4" aria-hidden />{a.fileName}
                  <span className="text-xs text-muted">{formatBytes(a.byteSize)}</span>
                  <Download className="size-3.5" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.balance && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Balance for {r.leaveYear}</h3>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {[
              ['Credited', r.balance.opening + r.balance.accrued + r.balance.carriedForward + r.balance.adjusted + r.balance.compOff],
              ['Used', r.balance.used],
              ['Pending', r.balance.pending],
              ['Available', r.balance.available],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg border border-line px-3 py-2">
                <p className="text-xs text-muted">{label}</p>
                <p className="font-semibold tabular">{days(value as number)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {seesLedger && r.ledger.length > 0 && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Balance transactions for this request</h3>
          <ul className="space-y-1 text-sm">
            {r.ledger.map((l) => (
              <li key={l.id} className="flex justify-between gap-3">
                <span className="text-slate-700">{TXN_LABEL[l.txnType] ?? l.txnType}</span>
                <span className="text-muted tabular">{days(l.days)} d · {formatDate(l.createdAt, prefs)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.workflow && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Approval history</h3>
          <ol className="space-y-3 border-l-2 border-line pl-4">
            {r.workflow.history.map((h) => (
              <li key={h.id} className="relative text-sm">
                <span className="absolute -left-[1.4rem] top-1.5 size-2 rounded-full bg-primary" aria-hidden />
                <p className="font-medium text-ink">
                  {ACTION_LABEL[h.action] ?? h.action}
                  {h.stepOrder !== null && r.workflow!.tasks.find((t) => t.stepOrder === h.stepOrder)
                    && <span className="font-normal text-muted"> · {r.workflow!.tasks.find((t) => t.stepOrder === h.stepOrder)!.stepName}</span>}
                </p>
                <p className="text-xs text-muted">
                  {h.actorName ?? 'System'}{h.onBehalfOfName && ` on behalf of ${h.onBehalfOfName}`} · {formatDateTime(h.at, prefs)}
                </p>
                {h.comments && <p className="mt-1 rounded-md bg-slate-50 px-2.5 py-1.5 text-slate-700">{h.comments}</p>}
              </li>
            ))}
          </ol>
          {r.status === 'pending' && r.workflow.tasks.some((t) => t.status === 'pending') && (
            <p className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              Waiting on:
              {r.workflow.tasks.filter((t) => t.status === 'pending').map((t) => <Badge key={t.id} tone="neutral">{t.assignedToName}</Badge>)}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

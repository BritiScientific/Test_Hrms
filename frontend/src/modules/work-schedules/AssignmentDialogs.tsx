import { useState, type ReactNode } from 'react';
import { UsersRound } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { ApiError } from '@/services/api-client';
import { formatDate } from '@/utils/format';
import type { AssignmentApi } from './api';
import { EmployeePickerDialog, type Selection } from './EmployeePickerDialog';
import { isStale, useInvalidateAssignments, usePatternOptions } from './hooks';
import type { AssignTab } from './tabs';
import { DEFAULT_RULE, RotationRuleFields, draftFromRule, ruleFromDraft, type RuleDraft } from './RotationRuleFields';
import type { Assignment, OverlapConflict } from './types';

/** Today's date in the organization's timezone, as YYYY-MM-DD. */
export function useTenantToday(): string {
  const tz = useMe().tenant.preferences.timezone;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Turn a failed call into form-level text, field errors and structured details. */
function describe(e: unknown) {
  if (!(e instanceof ApiError)) return { message: 'Something went wrong. Please try again.', fields: {} as Record<string, string>, stale: false };
  return { message: e.message, fields: e.fieldErrors, stale: isStale(e) };
}

/** The server reports nested errors as "rotation.weekday"; the form shows them under the rotation fields. */
function rotationErrors(fields: Record<string, string>): Record<string, string> {
  const out = { ...fields };
  for (const k of Object.keys(fields)) {
    if (k.startsWith('rotation.')) { out.rotation ??= fields[k]; delete out[k]; }
  }
  return out;
}

function Conflicts({ items, prefs }: { items: OverlapConflict[]; prefs: Parameters<typeof formatDate>[1] }) {
  return (
    <InlineAlert tone="warning" title="Nothing was saved">
      <p>These employees already have a rotation in this period:</p>
      <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5">
        {items.map((c) => (
          <li key={c.assignmentId}>
            <strong>{c.employeeName}</strong>: {c.patternName}, from {formatDate(c.startDate, prefs)}
            {c.endDate ? ` to ${formatDate(c.endDate, prefs)}` : ' (no end date)'}
          </li>
        ))}
      </ul>
    </InlineAlert>
  );
}

// ------------------------------------------------------------------ assign ---

/** Assign a pattern to one or many employees from a start date. */
export function AssignDialog({ tab, client, onClose }: { tab: AssignTab; client: AssignmentApi; onClose: () => void }) {
  const prefs = useMe().tenant.preferences;
  const todayIso = useTenantToday();
  const patterns = usePatternOptions(tab.key);
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  const [selection, setSelection] = useState<Selection>(new Map());
  const [picking, setPicking] = useState(false);
  const [patternId, setPatternId] = useState('');
  const [startDate, setStartDate] = useState(todayIso);
  const [rule, setRule] = useState<RuleDraft>(DEFAULT_RULE);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<OverlapConflict[]>([]);
  const [ineligible, setIneligible] = useState<{ id: number; name: string; reason: string }[]>([]);

  const pattern = patterns.data?.find((p) => String(p.id) === patternId);
  const past = !!startDate && startDate < todayIso;

  const save = async (another: boolean) => {
    const f: Record<string, string> = {};
    if (selection.size === 0) f.employeeIds = 'Choose at least one employee';
    if (!patternId) f.patternId = `Choose a ${tab.patternLabel.toLowerCase()}`;
    if (!startDate) f.startDate = 'Choose a start date';
    const parsed = ruleFromDraft(rule);
    if ('error' in parsed) f.rotation = parsed.error;
    if (past && !reason.trim()) f.reason = 'Give a reason for a past start date';
    setFields(f);
    setError(null); setConflicts([]); setIneligible([]);
    if (Object.keys(f).length || !('rule' in parsed)) return;
    setSaving(true);
    try {
      const r = await client.create({
        employeeIds: [...selection.keys()], patternId: Number(patternId), startDate, rotation: parsed.rule, reason: reason.trim() || null,
      });
      await invalidate();
      notify({ tone: 'success', title: `${r.total} employee${r.total === 1 ? '' : 's'} assigned` });
      if (another) { setSelection(new Map()); setReason(''); } else onClose();
    } catch (e) {
      const d = describe(e);
      setFields(rotationErrors(d.fields));
      if (e instanceof ApiError && e.code === 'ASSIGNMENT_OVERLAP') setConflicts(e.details?.conflicts ?? []);
      else if (e instanceof ApiError && e.details?.ineligible) setIneligible(e.details.ineligible);
      else if (!Object.keys(d.fields).length) setError(d.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open onClose={saving ? () => undefined : onClose} title={`Assign ${tab.patternLabel.toLowerCase()}`} size="md"
        footer={
          <>
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="outline" onClick={() => save(true)} disabled={saving}>Save and add another</Button>
            <Button onClick={() => save(false)} loading={saving}>Save</Button>
          </>
        }>
        <div className="space-y-4">
          {error && <InlineAlert>{error}</InlineAlert>}
          {conflicts.length > 0 && <Conflicts items={conflicts} prefs={prefs} />}
          {ineligible.length > 0 && (
            <InlineAlert tone="warning" title="Some employees cannot be assigned">
              <ul className="list-disc pl-5">{ineligible.map((i) => <li key={i.id}>{i.name}: {i.reason}</li>)}</ul>
            </InlineAlert>
          )}

          <Field label="Employees" required error={fields.employeeIds}>
            {({ id, describedBy, invalid }) => (
              <Button id={id} variant="outline" className="w-full justify-start" icon={<UsersRound className="size-4" />}
                aria-describedby={describedBy} aria-invalid={invalid} onClick={() => setPicking(true)}>
                {selection.size === 0 ? 'Choose employees…' : `${selection.size} employee${selection.size === 1 ? '' : 's'} selected`}
              </Button>
            )}
          </Field>

          <Field label={tab.patternLabel} required error={fields.patternId}>
            {({ id, describedBy, invalid }) => (
              <Select id={id} value={patternId} onChange={(e) => setPatternId(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid}>
                <option value="">{patterns.isPending ? 'Loading…' : patterns.data?.length ? `Choose a ${tab.patternLabel.toLowerCase()}…` : 'No active patterns yet'}</option>
                {patterns.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
          </Field>
          {pattern && (
            <p className="-mt-2 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700" data-testid="rotation-summary">
              Sequence: {pattern.sequenceSummary}
            </p>
          )}

          <Field label="Start date" required error={fields.startDate}>
            {({ id, describedBy, invalid }) => (
              <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} className="sm:w-48" />
            )}
          </Field>

          <RotationRuleFields value={rule} onChange={setRule} error={fields.rotation} />

          <Field label="Reason" required={past} error={fields.reason} hint={past ? 'Needed because the start date is in the past.' : 'Optional.'}>
            {({ id, describedBy, invalid }) => (
              <Textarea id={id} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={describedBy} aria-invalid={invalid} />
            )}
          </Field>
        </div>
      </Dialog>
      <EmployeePickerDialog open={picking} kind={tab.key} initial={selection} onClose={() => setPicking(false)}
        onConfirm={(s) => { setSelection(s); setPicking(false); setFields((f) => ({ ...f, employeeIds: '' })); }} />
    </>
  );
}

// -------------------------------------------------------------------- edit ---

/** Before the start date: pattern, start and end date, reason. After it: only the end date and reason. */
export function EditAssignmentDialog({ tab, client, assignment, onClose }: {
  tab: AssignTab; client: AssignmentApi; assignment: Assignment; onClose: () => void;
}) {
  const prefs = useMe().tenant.preferences;
  const todayIso = useTenantToday();
  const started = assignment.startDate <= todayIso;
  const patterns = usePatternOptions(tab.key, !started);
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  const [patternId, setPatternId] = useState(String(assignment.pattern.id));
  const [startDate, setStartDate] = useState(assignment.startDate);
  const [rule, setRule] = useState<RuleDraft>(draftFromRule(assignment.rotation));
  const [endDate, setEndDate] = useState(assignment.endDate ?? '');
  const [reason, setReason] = useState(assignment.reason ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [conflicts, setConflicts] = useState<OverlapConflict[]>([]);
  const [stale, setStale] = useState(false);

  const save = async () => {
    setError(null); setConflicts([]); setFields({});
    const body: Record<string, unknown> & { updatedAt: string } = {
      updatedAt: assignment.updatedAt, endDate: endDate || null, reason: reason.trim() || null,
    };
    if (!started) {
      const parsed = ruleFromDraft(rule);
      if ('error' in parsed) return setFields({ rotation: parsed.error });
      body.patternId = Number(patternId); body.startDate = startDate; body.rotation = parsed.rule;
    }
    setSaving(true);
    try {
      await client.update(assignment.id, body);
      await invalidate();
      notify({ tone: 'success', title: 'Assignment saved' });
      onClose();
    } catch (e) {
      const d = describe(e);
      setStale(d.stale);
      setFields(rotationErrors(d.fields));
      if (e instanceof ApiError && e.code === 'ASSIGNMENT_OVERLAP') setConflicts(e.details?.conflicts ?? []);
      else if (!d.stale && !Object.keys(d.fields).length) setError(d.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? () => undefined : onClose} title={`Edit ${assignment.employee.name}`}
      description={started ? 'This assignment has started, so only the end date and reason can change. To switch pattern or rotation, end it and assign a new one from tomorrow.' : undefined}
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving} disabled={stale}>Save changes</Button></>}>
      <div className="space-y-4">
        {stale && <InlineAlert tone="warning" title="This assignment was changed by someone else">Close this window; the list refreshes with the latest version.</InlineAlert>}
        {error && <InlineAlert>{error}</InlineAlert>}
        {conflicts.length > 0 && <Conflicts items={conflicts} prefs={prefs} />}
        <Field label={tab.patternLabel}>
          {({ id }) => (
            <Select id={id} value={patternId} disabled={started} onChange={(e) => setPatternId(e.target.value)}>
              {!patterns.data?.some((p) => String(p.id) === patternId) && <option value={patternId}>{assignment.pattern.name}</option>}
              {patterns.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Start date" error={fields.startDate}>
            {({ id, describedBy, invalid }) => <Input id={id} type="date" value={startDate} disabled={started} aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setStartDate(e.target.value)} />}
          </Field>
          <Field label="End date" error={fields.endDate} hint="Leave blank for no end date.">
            {({ id, describedBy, invalid }) => <Input id={id} type="date" value={endDate} aria-describedby={describedBy} aria-invalid={invalid} onChange={(e) => setEndDate(e.target.value)} />}
          </Field>
        </div>
        <RotationRuleFields value={rule} onChange={setRule} error={fields.rotation} disabled={started} />
        <Field label="Reason" error={fields.reason}>
          {({ id }) => <Textarea id={id} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

// -------------------------------------------------------------- end / cancel ---

function ActionDialog({ title, description, confirmLabel, destructive, onClose, onConfirm, children, ready = true }: {
  title: string; description: ReactNode; confirmLabel: string; destructive?: boolean; ready?: boolean;
  onClose: () => void; onConfirm: () => Promise<void>; children?: ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<{ id: number; employeeName: string; reason: string }[]>([]);
  const [stale, setStale] = useState(false);
  const run = async () => {
    setSaving(true); setError(null); setProblems([]);
    try { await onConfirm(); onClose(); } catch (e) {
      const d = describe(e);
      setStale(d.stale);
      if (e instanceof ApiError && e.details?.problems) setProblems(e.details.problems);
      if (!d.stale) setError(d.message);
    } finally { setSaving(false); }
  };
  return (
    <Dialog open onClose={saving ? () => undefined : onClose} title={title} description={description} size="sm"
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
        <Button variant={destructive ? 'destructive' : 'primary'} onClick={run} loading={saving} disabled={!ready || stale}>{confirmLabel}</Button></>}>
      <div className="space-y-3">
        {children}
        {stale && <InlineAlert tone="warning">This assignment was changed by someone else. Close this window to see the latest.</InlineAlert>}
        {error && !stale && <InlineAlert>{error}</InlineAlert>}
        {problems.length > 0 && (
          <ul className="max-h-40 list-disc space-y-0.5 overflow-y-auto pl-5 text-sm">
            {problems.map((p) => <li key={p.id}><strong>{p.employeeName}</strong>: {p.reason}</li>)}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** End a started assignment. The end date defaults to today. */
export function EndAssignmentDialog({ client, assignment, onClose }: { client: AssignmentApi; assignment: Assignment; onClose: () => void }) {
  const todayIso = useTenantToday();
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  const [endDate, setEndDate] = useState(todayIso);
  return (
    <ActionDialog title={`End ${assignment.employee.name}'s rotation?`} confirmLabel="End rotation" destructive onClose={onClose}
      description={`${assignment.pattern.name} stays in the history. They can be assigned a new rotation from the day after the end date.`}
      onConfirm={async () => {
        await client.end(assignment.id, { endDate: endDate || null, updatedAt: assignment.updatedAt });
        await invalidate();
        notify({ tone: 'success', title: 'Rotation ended' });
      }}>
      <Field label="End date" required>
        {({ id }) => <Input id={id} type="date" min={todayIso} value={endDate} onChange={(e) => setEndDate(e.target.value)} className="sm:w-48" />}
      </Field>
    </ActionDialog>
  );
}

/** Cancel an assignment that has not started. */
export function CancelAssignmentDialog({ client, assignment, onClose }: { client: AssignmentApi; assignment: Assignment; onClose: () => void }) {
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  const [reason, setReason] = useState('');
  return (
    <ActionDialog title={`Cancel ${assignment.employee.name}'s assignment?`} confirmLabel="Cancel assignment" destructive onClose={onClose}
      description="It has not started yet, so it never takes effect. It stays in the history."
      onConfirm={async () => {
        await client.cancel(assignment.id, { reason: reason.trim() || null, updatedAt: assignment.updatedAt });
        await invalidate();
        notify({ tone: 'success', title: 'Assignment cancelled' });
      }}>
      <Field label="Reason">{({ id }) => <Textarea id={id} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
    </ActionDialog>
  );
}

/** End every selected assignment at once; if any cannot be ended, none is. */
export function BulkEndDialog({ client, ids, onClose, onDone }: { client: AssignmentApi; ids: number[]; onClose: () => void; onDone: () => void }) {
  const todayIso = useTenantToday();
  const invalidate = useInvalidateAssignments();
  const { notify } = useToast();
  const [endDate, setEndDate] = useState(todayIso);
  return (
    <ActionDialog title={`End ${ids.length} rotation${ids.length === 1 ? '' : 's'}?`} confirmLabel="End rotations" destructive onClose={onClose}
      description="All or none: if any selected assignment cannot be ended (for example it has not started), nothing changes."
      onConfirm={async () => {
        await client.bulkEnd(ids, endDate || null);
        await invalidate();
        notify({ tone: 'success', title: `${ids.length} rotation${ids.length === 1 ? '' : 's'} ended` });
        onDone();
      }}>
      <Field label="End date" required>
        {({ id }) => <Input id={id} type="date" min={todayIso} value={endDate} onChange={(e) => setEndDate(e.target.value)} className="sm:w-48" />}
      </Field>
    </ActionDialog>
  );
}

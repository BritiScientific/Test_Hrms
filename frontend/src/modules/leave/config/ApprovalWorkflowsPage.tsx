import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ArrowDown, ArrowUp, CopyPlus, GitBranch, Pencil, Plus, Send, Trash2, X } from 'lucide-react';
import { useAuth, useMe } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ConfirmDialog, Dialog } from '@/components/ui/Dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/Field';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { usePageTitle } from '@/hooks/usePageTitle';
import { ApiError } from '@/services/api-client';
import { leaveApi, type WorkflowModule } from '@/services/leave-api';
import type { WorkflowDefinition, WorkflowOptions, WorkflowStep } from '@/types/leave';
import { formatDate } from '@/utils/format';
import { errorMessage, leaveKey, useInvalidateLeave, useLeaveAction } from '../hooks';
import { QueryState } from '../components/shared';

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  published: { label: 'Published', tone: 'success' },
  draft: { label: 'Draft', tone: 'warning' },
  archived: { label: 'Archived', tone: 'neutral' },
};

const APPROVER_TYPES = [
  { value: 'reporting_manager', label: 'Reporting manager' },
  { value: 'second_level_manager', label: 'Manager’s manager' },
  { value: 'department_head', label: 'Department head' },
  { value: 'role', label: 'Everyone in a role' },
  { value: 'specific_user', label: 'A specific person' },
];

const OPERATORS: Record<string, { value: string; label: string }[]> = {
  number: [{ value: 'gt', label: 'is more than' }, { value: 'gte', label: 'is at least' }, { value: 'lt', label: 'is less than' }, { value: 'lte', label: 'is at most' }, { value: 'eq', label: 'is' }],
  string: [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'in', label: 'is one of (comma separated)' }],
  boolean: [{ value: 'eq', label: 'is' }],
};

interface ConditionRow { field: string; op: string; value: string }

/** Simple rows here; anything richer that came from the API is kept and shown as read-only. */
function conditionToRows(c: any): ConditionRow[] | null {
  if (!c) return [];
  const list = c.all ?? [c];
  if (!Array.isArray(list) || list.some((x) => !x.field)) return null;
  return list.map((x: any) => ({ field: x.field, op: x.op, value: Array.isArray(x.value) ? x.value.join(', ') : String(x.value) }));
}

export function rowsToCondition(rows: ConditionRow[], fields: WorkflowOptions['conditionFields']) {
  const parts = rows.filter((r) => r.field && r.op).map((r) => {
    const type = fields.find((f) => f.field === r.field)?.type ?? 'string';
    const value: unknown = r.op === 'in' ? r.value.split(',').map((v) => v.trim()).filter(Boolean)
      : type === 'number' ? Number(r.value)
        : type === 'boolean' ? r.value === 'true' : r.value.trim();
    return { field: r.field, op: r.op, value };
  });
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : { all: parts };
}

const MODULES: { key: WorkflowModule; label: string; noun: string; blocked: string }[] = [
  { key: 'leave', label: 'Leave requests', noun: 'leave', blocked: 'Employees can’t apply for leave until a leave workflow is published.' },
  { key: 'comp_off', label: 'Comp off claims', noun: 'comp off claims', blocked: 'Employees can’t claim comp off until a comp off workflow is published.' },
];

export default function ApprovalWorkflowsPage() {
  usePageTitle('Approval Workflows');
  const [params, setParams] = useSearchParams();
  const module: WorkflowModule = params.get('module') === 'comp_off' ? 'comp_off' : 'leave';
  return (
    <div>
      <PageHeader title="Approval Workflows"
        description="Who approves, and in what order. Leave requests and comp off claims each have their own chain. Published versions can’t change: edit a draft and publish it as a new version." />
      <div className="mb-4">
        <Tabs label="Workflow" idBase="wf" tabs={MODULES.map((m) => ({ key: m.key, label: m.label }))} active={module}
          onChange={(k) => setParams({ module: k }, { replace: true })} />
      </div>
      <TabPanel idBase="wf" active={module}>
        <ModuleWorkflows key={module} module={module} />
      </TabPanel>
    </div>
  );
}

function ModuleWorkflows({ module }: { module: WorkflowModule }) {
  const me = useMe();
  const prefs = me.tenant.preferences;
  const { can } = useAuth();
  const canEdit = can('workflow.configure');
  const { notify } = useToast();
  const invalidate = useInvalidateLeave();
  const meta = MODULES.find((m) => m.key === module)!;
  const q = useQuery({ queryKey: leaveKey('config', 'workflows', module), queryFn: () => leaveApi.workflows(module) });
  const options = useQuery({ queryKey: leaveKey('config', 'workflow-options', module), queryFn: () => leaveApi.workflowOptions(module) });
  // A new comp off workflow can start from the leave chain, which is what most organizations want.
  const leaveVersions = useQuery({ queryKey: leaveKey('config', 'workflows', 'leave'), queryFn: () => leaveApi.workflows('leave'), enabled: module === 'comp_off' });
  const leavePublished = leaveVersions.data?.find((d) => d.status === 'published');
  const [copying, setCopying] = useState(false);
  const copyFromLeave = async () => {
    if (!leavePublished) return;
    setCopying(true);
    try {
      const src = await leaveApi.workflow(leavePublished.id);
      const created = await leaveApi.createWorkflow({
        module: 'comp_off',
        name: 'Comp Off Approval',
        steps: (src.steps ?? []).map((s) => ({
          name: s.name, approverType: s.approver_type, approverRoleId: s.approver_role_id, specificUserId: s.specific_user_id,
          requiredPermission: s.required_permission_code, approvalMode: s.approval_mode, allowReject: s.allow_reject,
          allowReturn: s.allow_return, onNoApprover: s.on_no_approver, fallbackRoleId: s.fallback_role_id,
          // Leave conditions use fields comp off claims don't have, so copied steps always apply.
          condition: null, slaHours: s.sla_hours,
        })),
      });
      await invalidate();
      setSelectedId(created.id);
      notify({ tone: 'success', title: 'Draft created from the leave workflow', description: 'Check the steps, then publish it.' });
    } catch (e) {
      notify({ tone: 'error', title: 'Could not copy the leave workflow', description: errorMessage(e) });
    } finally {
      setCopying(false);
    }
  };
  const published = q.data?.find((d) => d.status === 'published');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const activeId = selectedId ?? published?.id ?? q.data?.[0]?.id ?? null;
  const detail = useQuery({ queryKey: leaveKey('config', 'workflow', activeId), queryFn: () => leaveApi.workflow(activeId!), enabled: activeId !== null });
  const [editing, setEditing] = useState<WorkflowDefinition | 'new' | null>(null);
  const [deleting, setDeleting] = useState<WorkflowDefinition | null>(null);
  const [publishing, setPublishing] = useState<WorkflowDefinition | null>(null);
  const [publishErrors, setPublishErrors] = useState<string[]>([]);

  const clone = useLeaveAction((id: number) => leaveApi.cloneWorkflow(id), {
    success: 'Draft created from this version', onDone: (d) => { setSelectedId((d as WorkflowDefinition).id); setEditing(d as WorkflowDefinition); },
  });
  const remove = useLeaveAction((id: number) => leaveApi.deleteWorkflow(id), { success: 'Draft deleted', onDone: () => { setDeleting(null); setSelectedId(null); } });
  const publish = async (d: WorkflowDefinition) => {
    setPublishErrors([]);
    try {
      await leaveApi.publishWorkflow(d.id);
      await invalidate();
      setPublishing(null);
      notify({ tone: 'success', title: `Version ${d.version} published`, description: 'New requests use it. Requests already in approval stay on their version.' });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'INVALID_WORKFLOW') setPublishErrors(e.details?.errors ?? [e.message]);
      else setPublishErrors([errorMessage(e)]);
    }
  };

  const draftExists = q.data?.some((d) => d.status === 'draft');
  const d = detail.data;

  return (
    <div>
      {canEdit && !q.isPending && !q.data?.length && (
        <div className="mb-4 flex flex-wrap gap-2">
          {module === 'comp_off' && leavePublished && (
            <Button icon={<CopyPlus className="size-4" />} loading={copying} onClick={copyFromLeave}>Copy steps from the leave workflow</Button>
          )}
          <Button variant={module === 'comp_off' && leavePublished ? 'outline' : 'primary'} icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Create workflow</Button>
        </div>
      )}
      {q.data && !published && (
        <div className="mb-4"><InlineAlert tone="warning" title="No published workflow">{meta.blocked}</InlineAlert></div>
      )}
      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="min-w-0">
          <CardHeader title="Versions" />
          <QueryState query={q} isEmpty={(x) => x.length === 0} emptyIcon={<GitBranch />} emptyTitle="No workflow yet">
            {(list) => (
              <ul className="divide-y divide-line">
                {list.map((v) => (
                  <li key={v.id}>
                    <button type="button" onClick={() => setSelectedId(v.id)} aria-current={v.id === activeId}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 sm:px-5 ${v.id === activeId ? 'bg-primary-soft/60' : ''}`}>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-ink">Version {v.version} · {v.name}</span>
                        <span className="block text-xs text-muted">{v.published_at ? `Published ${formatDate(v.published_at, prefs)}` : `Created ${formatDate(v.created_at, prefs)}`}</span>
                      </span>
                      <Badge tone={STATUS[v.status].tone}>{STATUS[v.status].label}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </Card>

        <Card className="min-w-0 xl:col-span-2">
          {!d && <CardHeader title="Steps" />}
          {d && (
            <CardHeader title={`Version ${d.version}: ${d.name}`} description={d.description ?? undefined}
              actions={canEdit && (
                <>
                  {d.status === 'draft' && <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setEditing(d)}>Edit</Button>}
                  {d.status === 'draft' && <Button size="sm" icon={<Send className="size-3.5" />} onClick={() => { setPublishErrors([]); setPublishing(d); }}>Publish</Button>}
                  {d.status === 'draft' && <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" />} onClick={() => setDeleting(d)}>Delete</Button>}
                  {d.status !== 'draft' && !draftExists && <Button size="sm" variant="outline" icon={<CopyPlus className="size-3.5" />} loading={clone.isPending} onClick={() => clone.mutate(d.id)}>New version from this</Button>}
                </>
              )} />
          )}
          <QueryState query={detail} isEmpty={(x) => !x.steps?.length} emptyTitle="No steps">
            {(x) => (
              <CardBody>
                <ol className="space-y-3">
                  {x.steps!.map((s, i) => <StepSummary key={s.id ?? i} step={s} index={i} options={options.data} />)}
                </ol>
              </CardBody>
            )}
          </QueryState>
        </Card>
      </div>

      {editing && options.data && (
        <WorkflowEditor module={module} definition={editing === 'new' ? null : editing} options={options.data} onClose={() => setEditing(null)} onSaved={(id) => { setSelectedId(id); setEditing(null); }} />
      )}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && remove.mutate(deleting.id)} loading={remove.isPending}
        title="Delete this draft?" confirmLabel="Delete" tone="destructive" />
      {publishing && (
        <Dialog open onClose={() => setPublishing(null)} title={`Publish version ${publishing.version}?`} size="sm"
          footer={<><Button variant="outline" onClick={() => setPublishing(null)}>Back</Button><Button onClick={() => publish(publishing)}>Publish</Button></>}>
          <div className="space-y-3 text-sm">
            {publishErrors.map((e) => <InlineAlert key={e}>{e}</InlineAlert>)}
            <p className="text-muted">New requests use this version straight away. Requests already in approval stay on the version they started with.</p>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function describeCondition(c: any, fields: WorkflowOptions['conditionFields'] = []): string {
  if (!c) return 'Always applies';
  const one = (x: any) => {
    const label = fields.find((f) => f.field === x.field)?.label ?? x.field;
    const type = fields.find((f) => f.field === x.field)?.type ?? 'string';
    const op = OPERATORS[type]?.find((o) => o.value === x.op)?.label ?? x.op;
    return `${label} ${op} ${Array.isArray(x.value) ? x.value.join(', ') : String(x.value)}`;
  };
  if (c.all) return `Only when ${c.all.map(one).join(' and ')}`;
  if (c.any) return `Only when ${c.any.map(one).join(' or ')}`;
  if (c.field) return `Only when ${one(c)}`;
  return 'Only under a custom condition';
}

function StepSummary({ step, index, options }: { step: WorkflowStep; index: number; options?: WorkflowOptions }) {
  const role = options?.roles.find((r) => r.id === step.approver_role_id)?.name;
  const fallback = options?.roles.find((r) => r.id === step.fallback_role_id)?.name;
  return (
    <li className="flex gap-3 rounded-lg border border-line p-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-dark">{index + 1}</span>
      <div className="min-w-0 text-sm">
        <p className="font-medium text-ink">{step.name}</p>
        <p className="text-slate-700">
          {APPROVER_TYPES.find((a) => a.value === step.approver_type)?.label}{role && `: ${role}`}
          {step.approval_mode === 'all' && ', all must approve'}
        </p>
        <p className="text-xs text-muted">
          {describeCondition(step.condition, options?.conditionFields)}
          {step.sla_hours && ` · ${step.sla_hours} hour target`}
          {step.on_no_approver === 'skip' && ' · Skipped if nobody is available'}
          {step.on_no_approver === 'fallback_role' && ` · Falls back to ${fallback ?? 'a role'}`}
          {!step.allow_reject && ' · Can’t reject'}
          {!step.allow_return && ' · Can’t send back'}
        </p>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------- editor --

interface EditorStep {
  key: number;
  name: string;
  approverType: string;
  approverRoleId: string;
  specificUserId: string;
  approvalMode: 'any' | 'all';
  allowReject: boolean;
  allowReturn: boolean;
  onNoApprover: 'fail' | 'skip' | 'fallback_role';
  fallbackRoleId: string;
  slaHours: string;
  rows: ConditionRow[] | null;
  rawCondition: any;
}

let stepKey = 0;
const blankStep = (): EditorStep => ({
  key: ++stepKey, name: '', approverType: 'reporting_manager', approverRoleId: '', specificUserId: '', approvalMode: 'any',
  allowReject: true, allowReturn: true, onNoApprover: 'fail', fallbackRoleId: '', slaHours: '', rows: [], rawCondition: null,
});

function WorkflowEditor({ module, definition, options, onClose, onSaved }: {
  module: WorkflowModule;
  definition: WorkflowDefinition | null;
  options: WorkflowOptions;
  onClose: () => void;
  onSaved: (id: number) => void;
}) {
  const invalidate = useInvalidateLeave();
  const people = useQuery({ queryKey: leaveKey('employees', 'with-login'), queryFn: () => leaveApi.employees() });
  const [name, setName] = useState(definition?.name ?? (module === 'comp_off' ? 'Comp Off Approval' : 'Leave Approval'));
  const [steps, setSteps] = useState<EditorStep[]>([blankStep()]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!definition?.steps?.length) return;
    setSteps(definition.steps.map((s) => ({
      key: ++stepKey,
      name: s.name,
      approverType: s.approver_type,
      approverRoleId: s.approver_role_id ? String(s.approver_role_id) : '',
      specificUserId: s.specific_user_id ? String(s.specific_user_id) : '',
      approvalMode: s.approval_mode,
      allowReject: s.allow_reject,
      allowReturn: s.allow_return,
      onNoApprover: s.on_no_approver,
      fallbackRoleId: s.fallback_role_id ? String(s.fallback_role_id) : '',
      slaHours: s.sla_hours ? String(s.sla_hours) : '',
      rows: conditionToRows(s.condition),
      rawCondition: s.condition,
    })));
  }, [definition]);

  const patch = (key: number, p: Partial<EditorStep>) => setSteps((all) => all.map((s) => (s.key === key ? { ...s, ...p } : s)));
  const move = (i: number, d: number) => setSteps((all) => {
    const next = [...all];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    return next;
  });

  const save = async () => {
    setError(null);
    if (!name.trim()) return setError('Give the workflow a name.');
    for (const [i, s] of steps.entries()) {
      if (!s.name.trim()) return setError(`Step ${i + 1} needs a name.`);
      if (s.approverType === 'role' && !s.approverRoleId) return setError(`Step ${i + 1}: choose a role.`);
      if (s.approverType === 'specific_user' && !s.specificUserId) return setError(`Step ${i + 1}: choose a person.`);
      if (s.onNoApprover === 'fallback_role' && !s.fallbackRoleId) return setError(`Step ${i + 1}: choose the fallback role.`);
    }
    const body = {
      name: name.trim(),
      steps: steps.map((s) => ({
        name: s.name.trim(),
        approverType: s.approverType,
        approverRoleId: s.approverType === 'role' ? Number(s.approverRoleId) : null,
        specificUserId: s.approverType === 'specific_user' ? Number(s.specificUserId) : null,
        requiredPermission: options.requiredPermission,
        approvalMode: s.approverType === 'role' ? s.approvalMode : 'any',
        allowReject: s.allowReject,
        allowReturn: s.allowReturn,
        onNoApprover: s.onNoApprover,
        fallbackRoleId: s.onNoApprover === 'fallback_role' ? Number(s.fallbackRoleId) : null,
        condition: s.rows === null ? s.rawCondition : rowsToCondition(s.rows, options.conditionFields),
        slaHours: s.slaHours ? Number(s.slaHours) : null,
      })),
    };
    setSaving(true);
    try {
      const saved = definition
        ? await leaveApi.updateWorkflow(definition.id, body)
        : await leaveApi.createWorkflow({ ...body, module });
      await invalidate();
      onSaved(saved.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const withLogin = (people.data ?? []).filter((p) => p.userId);

  return (
    <Dialog open onClose={onClose} title={definition ? `Edit draft version ${definition.version}` : 'Create approval workflow'} size="lg"
      description="Saving doesn’t change anything for employees. Publish the draft when it’s ready."
      footer={<><Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button><Button onClick={save} loading={saving}>Save draft</Button></>}>
      <div className="space-y-4">
        {error && <InlineAlert>{error}</InlineAlert>}
        <Field label="Workflow name" required>{({ id }) => <Input id={id} data-autofocus value={name} maxLength={150} onChange={(e) => setName(e.target.value)} />}</Field>
        {steps.map((s, i) => (
          <fieldset key={s.key} className="space-y-3 rounded-xl border border-line p-4">
            <div className="flex items-center justify-between gap-2">
              <legend className="text-sm font-semibold">Step {i + 1}</legend>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" aria-hidden /></Button>
                <Button variant="ghost" size="icon" aria-label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" aria-hidden /></Button>
                <Button variant="ghost" size="icon" aria-label={`Remove step ${i + 1}`} disabled={steps.length === 1} onClick={() => setSteps((all) => all.filter((x) => x.key !== s.key))}><Trash2 className="size-4" aria-hidden /></Button>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Step name" required>{({ id }) => <Input id={id} value={s.name} maxLength={150} placeholder="Manager Approval" onChange={(e) => patch(s.key, { name: e.target.value })} />}</Field>
              <Field label="Who approves" required>{({ id }) => (
                <Select id={id} value={s.approverType} onChange={(e) => patch(s.key, { approverType: e.target.value })}>
                  {APPROVER_TYPES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </Select>
              )}</Field>
              {s.approverType === 'role' && (
                <>
                  <Field label="Role" required>{({ id }) => (
                    <Select id={id} value={s.approverRoleId} onChange={(e) => patch(s.key, { approverRoleId: e.target.value })}>
                      <option value="">Choose…</option>
                      {options.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                  )}</Field>
                  <Field label="How many must approve">{({ id }) => (
                    <Select id={id} value={s.approvalMode} onChange={(e) => patch(s.key, { approvalMode: e.target.value as 'any' | 'all' })}>
                      <option value="any">Any one person</option>
                      <option value="all">Everyone</option>
                    </Select>
                  )}</Field>
                </>
              )}
              {s.approverType === 'specific_user' && (
                <Field label="Person" required>{({ id }) => (
                  <Select id={id} value={s.specificUserId} onChange={(e) => patch(s.key, { specificUserId: e.target.value })}>
                    <option value="">Choose…</option>
                    {withLogin.map((p) => <option key={p.id} value={p.userId!}>{p.fullName}</option>)}
                  </Select>
                )}</Field>
              )}
              <Field label="If nobody can approve">{({ id }) => (
                <Select id={id} value={s.onNoApprover} onChange={(e) => patch(s.key, { onNoApprover: e.target.value as EditorStep['onNoApprover'] })}>
                  <option value="fail">Stop: the employee can’t submit</option>
                  <option value="skip">Skip this step</option>
                  <option value="fallback_role">Send to a role instead</option>
                </Select>
              )}</Field>
              {s.onNoApprover === 'fallback_role' && (
                <Field label="Fallback role" required>{({ id }) => (
                  <Select id={id} value={s.fallbackRoleId} onChange={(e) => patch(s.key, { fallbackRoleId: e.target.value })}>
                    <option value="">Choose…</option>
                    {options.roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </Select>
                )}</Field>
              )}
              <Field label="Target time (hours)" hint="Optional. Tasks past it show as overdue.">{({ id, describedBy }) => <Input id={id} type="number" min="1" step="1" aria-describedby={describedBy} value={s.slaHours} onChange={(e) => patch(s.key, { slaHours: e.target.value })} />}</Field>
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2"><Checkbox checked={s.allowReject} onChange={(e) => patch(s.key, { allowReject: e.target.checked })} />Can reject</label>
              <label className="flex items-center gap-2"><Checkbox checked={s.allowReturn} onChange={(e) => patch(s.key, { allowReturn: e.target.checked })} />Can send back for information</label>
            </div>
            <ConditionEditor step={s} options={options} onChange={(rows) => patch(s.key, { rows })} />
          </fieldset>
        ))}
        <Button variant="outline" size="sm" icon={<Plus className="size-3.5" />} disabled={steps.length >= 20} onClick={() => setSteps((all) => [...all, blankStep()])}>Add step</Button>
      </div>
    </Dialog>
  );
}

function ConditionEditor({ step, options, onChange }: { step: EditorStep; options: WorkflowOptions; onChange: (rows: ConditionRow[]) => void }) {
  if (step.rows === null) {
    return <p className="text-xs text-muted">This step has a custom condition that’s kept as it is: {JSON.stringify(step.rawCondition)}</p>;
  }
  const rows = step.rows;
  const set = (i: number, p: Partial<ConditionRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...p } : r)));
  return (
    <div>
      <p className="mb-2 text-sm font-medium text-slate-700">When does this step apply?</p>
      {rows.length === 0 && <p className="mb-2 text-xs text-muted">Always. Add a condition to apply it only to some requests.</p>}
      <ul className="space-y-2">
        {rows.map((r, i) => {
          const type = options.conditionFields.find((f) => f.field === r.field)?.type ?? 'number';
          return (
            <li key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
              <Select aria-label="Condition field" value={r.field} onChange={(e) => {
                const t = options.conditionFields.find((f) => f.field === e.target.value)?.type ?? 'string';
                set(i, { field: e.target.value, op: OPERATORS[t][0].value, value: t === 'boolean' ? 'true' : '' });
              }}>
                {options.conditionFields.map((f) => <option key={f.field} value={f.field}>{f.label}</option>)}
              </Select>
              <Select aria-label="Condition operator" value={r.op} onChange={(e) => set(i, { op: e.target.value })}>
                {OPERATORS[type].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
              {type === 'boolean' ? (
                <Select aria-label="Condition value" value={r.value} onChange={(e) => set(i, { value: e.target.value })}>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </Select>
              ) : (
                <Input aria-label="Condition value" type={type === 'number' ? 'number' : 'text'} value={r.value} onChange={(e) => set(i, { value: e.target.value })} />
              )}
              <Button variant="ghost" size="icon" aria-label="Remove this condition" onClick={() => onChange(rows.filter((_, n) => n !== i))}><X className="size-4" aria-hidden /></Button>
            </li>
          );
        })}
      </ul>
      <Button className="mt-2" variant="ghost" size="sm" icon={<Plus className="size-3.5" />} onClick={() => onChange([...rows, { field: 'totalDays', op: 'gt', value: '' }])}>Add condition</Button>
    </div>
  );
}

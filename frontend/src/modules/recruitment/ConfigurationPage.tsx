import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { ClipboardList, Copy, ListChecks, Pencil, Plus, Power, PowerOff, Search, Tag, Trash2 } from 'lucide-react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useAuth } from '@/app/providers/AuthProvider';
import { InlineAlert, PageHeader } from '@/components/feedback/States';
import { StatusBadge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { useToast } from '@/components/ui/Toast';
import { useDebounced } from '@/hooks/useDebounced';
import { usePageTitle } from '@/hooks/usePageTitle';
import { DataTable, Pager, QueryState, type Column } from '@/modules/leave/components/shared';
import { ConfigFormDialog } from '@/modules/work-schedule/components/ConfigFormDialog';
import { ApiError } from '@/services/api-client';
import { recruitmentApi, type ConfigApi } from './api';
import { errorText, fieldErrors, isStale, recKeys, useDepartmentOptions, useInvalidateRecruitment } from './hooks';
import type { ConfigBase, JobPosition, QuestionType, RecruitmentSettings, RejectionReason, SurveyQuestion, SurveyTemplate } from './types';

type TabKey = 'positions' | 'surveys' | 'reasons' | 'careers';
const TABS: { key: TabKey; label: string }[] = [
  { key: 'positions', label: 'Job positions' }, { key: 'surveys', label: 'Survey templates' },
  { key: 'reasons', label: 'Rejection reasons' }, { key: 'careers', label: 'Careers page' },
];
const PAGE = 25;

export default function ConfigurationPage() {
  usePageTitle('Recruitment configuration');
  const { can } = useAuth();
  const canManage = can('recruitment.configuration.manage');
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'positions') as TabKey;
  return (
    <>
      <PageHeader title="Recruitment configuration" description="Job positions, application questions, rejection reasons and the public careers page." />
      <Card className="overflow-hidden">
        <div className="px-2 pt-2 sm:px-3">
          <Tabs label="Recruitment configuration" idBase="rc" tabs={TABS} active={tab} onChange={(k) => setParams({ tab: k }, { replace: true })} />
        </div>
        <TabPanel active={tab} idBase="rc">
          {tab === 'positions' && <PositionsTab canManage={canManage} />}
          {tab === 'surveys' && <SurveysTab canManage={canManage} />}
          {tab === 'reasons' && <ReasonsTab canManage={canManage} />}
          {tab === 'careers' && <CareersTab canManage={canManage} />}
        </TabPanel>
      </Card>
    </>
  );
}

// ----------------------------------------------------------------- shared list --

function ConfigList<T extends ConfigBase>({ name, label, client, columns, canManage, renderForm, icon }: {
  name: string; label: string; client: ConfigApi<T>; columns: Column<T>[]; canManage: boolean; icon: ReactNode;
  renderForm: (record: T | null, close: () => void) => ReactNode;
}) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [page, setPage] = useState(1);
  const [form, setForm] = useState<T | 'new' | null>(null);
  const [toggling, setToggling] = useState<T | null>(null);
  const debounced = useDebounced(search.trim(), 300);
  useEffect(() => setPage(1), [debounced, status]);
  const query = useMemo(() => ({ search: debounced || undefined, status, page, limit: PAGE }), [debounced, status, page]);
  const q = useQuery({ queryKey: recKeys.config(name, query), queryFn: () => client.list(query), placeholderData: keepPreviousData });
  const lower = label.toLowerCase();

  const toggle = useMutation({
    mutationFn: (r: T) => client.setStatus(r.id, { isActive: !r.isActive, updatedAt: r.updatedAt }),
    onSuccess: async (saved) => { await invalidate(); setToggling(null); notify({ tone: 'success', title: `${label} ${saved.isActive ? 'activated' : 'deactivated'}` }); },
  });

  const all: Column<T>[] = [
    ...columns,
    { key: 'status', header: 'Status', render: (r) => <StatusBadge active={r.isActive} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Actions', bare: true, className: 'w-px whitespace-nowrap',
      render: (r: T) => (
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" icon={<Pencil className="size-3.5" />} onClick={() => setForm(r)} aria-label={`Edit ${r.name}`}>Edit</Button>
          <Button size="sm" variant="outline" icon={r.isActive ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
            onClick={() => { toggle.reset(); setToggling(r); }} aria-label={`${r.isActive ? 'Deactivate' : 'Activate'} ${r.name}`}>{r.isActive ? 'Deactivate' : 'Activate'}</Button>
        </div>
      ),
    }] : []),
  ];
  const filtered = !!debounced || status !== 'all';
  const blockers = toggle.error instanceof ApiError && toggle.error.code === 'HAS_ACTIVE_DEPENDENTS' ? (toggle.error.details?.items as { id: number; title: string }[] | undefined) : undefined;

  return (
    <>
      <div className="flex flex-col gap-3 border-b border-line p-4 sm:flex-row sm:items-end">
        <Field label={`Search ${lower}s`} hideLabel className="flex-1">
          {({ id }) => (
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input id={id} type="search" className="pl-9" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          )}
        </Field>
        <Field label="Status" hideLabel className="sm:w-40">
          {({ id }) => <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></Select>}
        </Field>
        {canManage && <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New {lower}</Button>}
      </div>
      <QueryState query={q} isEmpty={(d) => d.items.length === 0} emptyIcon={icon} emptyTitle={filtered ? `No ${lower}s match` : `No ${lower}s yet`}
        emptyText={filtered ? 'Try another search or status.' : canManage ? `Create the first ${lower} to get started.` : undefined}
        emptyAction={!filtered && canManage ? <Button icon={<Plus className="size-4" />} onClick={() => setForm('new')}>New {lower}</Button> : undefined}>
        {(d) => (
          <>
            <DataTable caption={`${label}s`} columns={all} rows={d.items} rowKey={(r) => r.id} minWidth="44rem" />
            <Pager total={d.total} limit={PAGE} offset={(page - 1) * PAGE} onChange={(o) => setPage(Math.floor(o / PAGE) + 1)} />
          </>
        )}
      </QueryState>
      {form && renderForm(form === 'new' ? null : form, () => setForm(null))}
      <ConfirmDialog open={!!toggling} onClose={() => setToggling(null)} loading={toggle.isPending} tone={toggling?.isActive ? 'destructive' : 'primary'}
        title={`${toggling?.isActive ? 'Deactivate' : 'Activate'} ${toggling?.name ?? ''}?`}
        description={toggling?.isActive ? `It will no longer be offered when creating or editing recruitments. Existing records keep it.` : 'It becomes available again.'}
        confirmLabel={toggling?.isActive ? 'Deactivate' : 'Activate'} onConfirm={() => toggling && toggle.mutate(toggling)}>
        {toggle.isError && (
          <InlineAlert>
            {errorText(toggle.error)}
            {blockers && <ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b.id}>{b.title}</li>)}</ul>}
          </InlineAlert>
        )}
      </ConfirmDialog>
    </>
  );
}

/** Create/edit plumbing shared by the three forms: saves, maps server errors onto fields, handles a stale record. */
function useSave<T extends ConfigBase>(client: ConfigApi<T>, record: T | null, label: string, onClose: () => void, setErrors: (e: Record<string, string>) => void) {
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const m = useMutation({
    mutationFn: (body: Record<string, unknown>) => (record ? client.update(record.id, { ...body, updatedAt: record.updatedAt }) : client.create(body)),
    onSuccess: async () => { await invalidate(); notify({ tone: 'success', title: `${label} ${record ? 'saved' : 'created'}` }); onClose(); },
    onError: (e) => {
      if (isStale(e)) return setStale(true);
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) setErrors(fe); else setFormError(errorText(e));
    },
  });
  return { m, formError, setFormError, stale };
}

const nameCol = <T extends ConfigBase & { title?: string }>(key: 'name' | 'title' = 'name'): Column<T> => ({
  key: 'name', header: 'Name', bare: true,
  render: (r) => <div className="min-w-0"><p className="font-medium text-ink">{key === 'title' ? r.title : r.name}</p>{r.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.description}</p>}</div>,
});

// ------------------------------------------------------------- job positions --

function PositionsTab({ canManage }: { canManage: boolean }) {
  const cols: Column<JobPosition>[] = [
    nameCol<JobPosition>('title'),
    { key: 'dept', header: 'Department', render: (r) => <span className="text-slate-600">{r.department ?? '—'}</span> },
    { key: 'open', header: 'Open recruitments', render: (r) => <span className="tabular text-slate-600">{r.openRecruitments}</span> },
  ];
  return <ConfigList name="positions" label="Job position" client={recruitmentApi.config.jobPositions} columns={cols} canManage={canManage} icon={<Tag />}
    renderForm={(rec, close) => <PositionForm record={rec} onClose={close} />} />;
}

function PositionForm({ record, onClose }: { record: JobPosition | null; onClose: () => void }) {
  const depts = useDepartmentOptions();
  const [title, setTitle] = useState(record?.title ?? '');
  const [dept, setDept] = useState(record?.departmentId ? String(record.departmentId) : '');
  const [desc, setDesc] = useState(record?.description ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { m, formError, setFormError, stale } = useSave(recruitmentApi.config.jobPositions, record, 'Job position', onClose, setErrors);
  return (
    <ConfigFormDialog title={record ? 'Edit job position' : 'New job position'} onClose={onClose} saving={m.isPending} error={formError} stale={stale} onReload={onClose}
      onSubmit={(e) => {
        e.preventDefault(); setFormError(null);
        const er: Record<string, string> = {};
        if (title.trim().length < 2) er.title = 'Enter at least 2 characters';
        setErrors(er);
        if (!Object.keys(er).length) m.mutate({ title: title.trim(), departmentId: dept ? Number(dept) : null, description: desc.trim() || null });
      }}>
      <Field label="Title" required error={errors.title}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
      <Field label="Department" error={errors.departmentId}>
        {({ id }) => <Select id={id} value={dept} onChange={(e) => setDept(e.target.value)}><option value="">None</option>{depts.data?.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}
      </Field>
      <Field label="Description" error={errors.description}>{({ id }) => <Textarea id={id} rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />}</Field>
    </ConfigFormDialog>
  );
}

// ---------------------------------------------------------- rejection reasons --

function ReasonsTab({ canManage }: { canManage: boolean }) {
  return <ConfigList name="reasons" label="Rejection reason" client={recruitmentApi.config.rejectionReasons} columns={[nameCol<RejectionReason>()]} canManage={canManage} icon={<ClipboardList />}
    renderForm={(rec, close) => <ReasonForm record={rec} onClose={close} />} />;
}

function ReasonForm({ record, onClose }: { record: RejectionReason | null; onClose: () => void }) {
  const [name, setName] = useState(record?.name ?? '');
  const [desc, setDesc] = useState(record?.description ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { m, formError, setFormError, stale } = useSave(recruitmentApi.config.rejectionReasons, record, 'Rejection reason', onClose, setErrors);
  return (
    <ConfigFormDialog title={record ? 'Edit rejection reason' : 'New rejection reason'} size="sm" onClose={onClose} saving={m.isPending} error={formError} stale={stale} onReload={onClose}
      onSubmit={(e) => {
        e.preventDefault(); setFormError(null);
        const er: Record<string, string> = {};
        if (name.trim().length < 2) er.name = 'Enter at least 2 characters';
        setErrors(er);
        if (!Object.keys(er).length) m.mutate({ name: name.trim(), description: desc.trim() || null });
      }}>
      <Field label="Name" required error={errors.name}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={150} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
      <Field label="Description" error={errors.description}>{({ id }) => <Textarea id={id} rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />}</Field>
    </ConfigFormDialog>
  );
}

// ------------------------------------------------------------ survey templates --

const TYPE_LABEL: Record<QuestionType, string> = { text: 'Short text', textarea: 'Long text', yes_no: 'Yes / No', select: 'Choose one', number: 'Number' };

function SurveysTab({ canManage }: { canManage: boolean }) {
  const cols: Column<SurveyTemplate>[] = [
    nameCol<SurveyTemplate>(),
    { key: 'q', header: 'Questions', render: (r) => <span className="tabular text-slate-600">{r.questions.length}</span> },
  ];
  return <ConfigList name="surveys" label="Survey template" client={recruitmentApi.config.surveyTemplates} columns={cols} canManage={canManage} icon={<ListChecks />}
    renderForm={(rec, close) => <SurveyForm record={rec} onClose={close} />} />;
}

interface QRow extends SurveyQuestion { key: number; optionsText: string }
let qseq = 0;

function SurveyForm({ record, onClose }: { record: SurveyTemplate | null; onClose: () => void }) {
  const [name, setName] = useState(record?.name ?? '');
  const [desc, setDesc] = useState(record?.description ?? '');
  const [rows, setRows] = useState<QRow[]>(record?.questions.map((q) => ({ ...q, key: ++qseq, optionsText: q.options.join('\n') }))
    ?? [{ key: ++qseq, label: '', type: 'text', required: false, options: [], optionsText: '' }]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { m, formError, setFormError, stale } = useSave(recruitmentApi.config.surveyTemplates, record, 'Survey template', onClose, setErrors);
  const update = (key: number, patch: Partial<QRow>) => setRows((l) => l.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const optionsOf = (r: QRow) => r.optionsText.split('\n').map((s) => s.trim()).filter(Boolean);

  return (
    <ConfigFormDialog title={record ? 'Edit survey template' : 'New survey template'} size="lg" onClose={onClose} saving={m.isPending} error={formError} stale={stale} onReload={onClose}
      description="Extra questions applicants answer on the careers form."
      onSubmit={(e) => {
        e.preventDefault(); setFormError(null);
        const er: Record<string, string> = {};
        if (name.trim().length < 2) er.name = 'Enter at least 2 characters';
        if (!rows.length) er.questions = 'Add at least one question';
        else if (rows.some((r) => r.label.trim().length < 2)) er.questions = 'Write every question';
        else if (rows.some((r) => r.type === 'select' && optionsOf(r).length < 2)) er.questions = 'A "Choose one" question needs at least 2 choices (one per line)';
        setErrors(er);
        if (!Object.keys(er).length) {
          m.mutate({
            name: name.trim(), description: desc.trim() || null,
            questions: rows.map((r) => ({ ...(r.id ? { id: r.id } : {}), label: r.label.trim(), type: r.type, required: r.required, options: r.type === 'select' ? optionsOf(r) : [] })),
          });
        }
      }}>
      <Field label="Name" required error={errors.name}>{({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={150} aria-invalid={invalid} aria-describedby={describedBy} />}</Field>
      <Field label="Description">{({ id }) => <Textarea id={id} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={2000} />}</Field>
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium text-slate-700">Questions</legend>
        {errors.questions && <InlineAlert>{errors.questions}</InlineAlert>}
        {rows.map((r, i) => (
          <div key={r.key} className="space-y-2 rounded-lg border border-line p-3">
            <div className="flex gap-2">
              <Input aria-label={`Question ${i + 1}`} placeholder="Question" value={r.label} maxLength={300} onChange={(e) => update(r.key, { label: e.target.value })} />
              <Button size="icon" variant="ghost" aria-label={`Remove question ${i + 1}`} disabled={rows.length === 1} onClick={() => setRows((l) => l.filter((x) => x.key !== r.key))}><Trash2 className="size-4" /></Button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Select aria-label={`Answer type for question ${i + 1}`} className="w-40" value={r.type} onChange={(e) => update(r.key, { type: e.target.value as QuestionType })}>
                {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
              </Select>
              <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" className="size-4 accent-primary" checked={r.required} onChange={(e) => update(r.key, { required: e.target.checked })} />Required</label>
            </div>
            {r.type === 'select' && <Textarea aria-label={`Choices for question ${i + 1}`} rows={3} placeholder="One choice per line" value={r.optionsText} onChange={(e) => update(r.key, { optionsText: e.target.value })} />}
          </div>
        ))}
        <Button variant="outline" size="sm" icon={<Plus className="size-4" />} disabled={rows.length >= 25}
          onClick={() => setRows((l) => [...l, { key: ++qseq, label: '', type: 'text', required: false, options: [], optionsText: '' }])}>Add question</Button>
      </fieldset>
    </ConfigFormDialog>
  );
}

// ---------------------------------------------------------------- careers page --

function CareersTab({ canManage }: { canManage: boolean }) {
  const { me } = useAuth();
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const q = useQuery({ queryKey: recKeys.config('settings'), queryFn: recruitmentApi.config.settings });
  const [v, setV] = useState<Omit<RecruitmentSettings, 'updatedAt'> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => { if (q.data && !v) setV({ careersEnabled: q.data.careersEnabled, careersHeadline: q.data.careersHeadline ?? '', careersIntro: q.data.careersIntro ?? '', confirmationMessage: q.data.confirmationMessage ?? '', privacyNoticeUrl: q.data.privacyNoticeUrl ?? '' }); }, [q.data, v]);
  const save = useMutation({
    mutationFn: (b: Omit<RecruitmentSettings, 'updatedAt'>) => recruitmentApi.config.saveSettings(b),
    onSuccess: async () => { await invalidate(); notify({ tone: 'success', title: 'Careers page settings saved' }); },
    onError: (e) => { const fe = fieldErrors(e); if (Object.keys(fe).length) setErrors(fe); else setFormError(errorText(e)); },
  });
  const url = `${window.location.origin}/careers?org=${me?.tenant.slug ?? ''}`;

  return (
    <QueryState query={q}>
      {() => v && (
        <form className="max-w-2xl space-y-4 p-4 sm:p-5" noValidate onSubmit={(e) => {
          e.preventDefault(); setFormError(null);
          const er: Record<string, string> = {};
          if (v.privacyNoticeUrl && !/^https?:\/\/\S+$/i.test(v.privacyNoticeUrl)) er.privacyNoticeUrl = 'Enter a full link starting with https://';
          setErrors(er);
          if (!Object.keys(er).length) save.mutate({ ...v, careersHeadline: v.careersHeadline?.trim() || null, careersIntro: v.careersIntro?.trim() || null, confirmationMessage: v.confirmationMessage?.trim() || null, privacyNoticeUrl: v.privacyNoticeUrl?.trim() || null });
        }}>
          {formError && <InlineAlert>{formError}</InlineAlert>}
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1 size-4 accent-primary" checked={v.careersEnabled} disabled={!canManage} onChange={(e) => setV({ ...v, careersEnabled: e.target.checked })} />
            <span><span className="block text-sm font-medium text-ink">Show the careers page</span><span className="block text-xs text-muted">When off, nobody can see or apply to any job, published or not.</span></span>
          </label>
          <div className="rounded-lg border border-line bg-slate-50/60 p-3 text-sm">
            <p className="text-xs text-muted">Public careers page</p>
            <div className="mt-1 flex items-center gap-2"><code className="min-w-0 flex-1 truncate">{url}</code>
              <Button size="sm" variant="outline" icon={<Copy className="size-3.5" />} onClick={async () => { try { await navigator.clipboard.writeText(url); notify({ tone: 'success', title: 'Link copied' }); } catch { notify({ tone: 'info', title: url }); } }}>Copy</Button></div>
          </div>
          <Field label="Headline" error={errors.careersHeadline}>{({ id }) => <Input id={id} disabled={!canManage} value={v.careersHeadline ?? ''} maxLength={200} onChange={(e) => setV({ ...v, careersHeadline: e.target.value })} placeholder="Join our team" />}</Field>
          <Field label="Introduction" error={errors.careersIntro}>{({ id }) => <Textarea id={id} disabled={!canManage} rows={3} value={v.careersIntro ?? ''} maxLength={2000} onChange={(e) => setV({ ...v, careersIntro: e.target.value })} />}</Field>
          <Field label="Confirmation message" hint="Shown after someone applies." error={errors.confirmationMessage}>{({ id }) => <Textarea id={id} disabled={!canManage} rows={2} value={v.confirmationMessage ?? ''} maxLength={1000} onChange={(e) => setV({ ...v, confirmationMessage: e.target.value })} />}</Field>
          <Field label="Privacy notice link" hint="Linked from the application form's consent checkbox." error={errors.privacyNoticeUrl}>
            {({ id, invalid, describedBy }) => <Input id={id} type="url" disabled={!canManage} value={v.privacyNoticeUrl ?? ''} onChange={(e) => setV({ ...v, privacyNoticeUrl: e.target.value })} placeholder="https://" aria-invalid={invalid} aria-describedby={describedBy} />}
          </Field>
          {canManage && <Button type="submit" loading={save.isPending}>Save</Button>}
        </form>
      )}
    </QueryState>
  );
}


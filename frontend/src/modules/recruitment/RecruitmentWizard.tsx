import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, GripVertical, Plus, RotateCw, X } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { InlineAlert } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select } from '@/components/ui/Field';
import { useToast } from '@/components/ui/Toast';
import { cn } from '@/utils/cn';
import { recruitmentApi } from './api';
import { EmployeePicker, RichTextEditor, TagsInput } from './common';
import { errorText, fieldErrors, isStale, useInvalidateRecruitment, useJobPositionOptions, useSurveyOptions } from './hooks';
import { FREE_STAGE_TYPES, STAGE_TYPE_LABEL, type Recruitment, type RecruitmentBody, type StageType } from './types';

type Step = 0 | 1 | 2;
const STEPS = [
  { title: 'Recruitment', hint: 'Title, dates and managers' },
  { title: 'Vacancy', hint: 'Places to fill in each job' },
  { title: 'Pipeline', hint: 'Default or custom stages' },
];
/** Which step owns each server field, so an error jumps the user to the right place. */
const FIELD_STEP: Record<string, Step> = {
  title: 0, description: 0, managerIds: 0, startDate: 0, endDate: 0, surveyTemplateId: 0, skills: 0, vacancies: 1, stages: 2,
};

interface VacancyRow { key: string; jobPositionId: string; vacancies: string; applied: number; filled: number }
interface StageRow { key: string; id?: number; name: string; stageType: StageType; count: number }

const DEFAULT_STAGES: StageRow[] = [
  ['Applied', 'applied'], ['Initial', 'initial'], ['Technical Test', 'test'], ['Interview', 'interview'],
  ['Shortlisted', 'shortlisted'], ['Hired', 'hired'], ['Rejected', 'rejected'],
].map(([name, stageType], i) => ({ key: `d${i}`, name, stageType: stageType as StageType, count: 0 }));

const todayIso = () => new Date().toISOString().slice(0, 10);
let seq = 0;
const nextKey = () => `n${++seq}`;
const isFixed = (t: StageType) => t === 'applied' || t === 'hired' || t === 'rejected';

/**
 * Create / edit a recruitment in three steps (details, vacancy lines, pipeline).
 * Nothing is saved until the last step: one request creates or updates the
 * recruitment, its vacancies and its stages together.
 */
export function RecruitmentWizard({ recruitment, onClose, onSaved }: {
  recruitment: Recruitment | null;
  onClose: () => void;
  onSaved: (r: Recruitment) => void;
}) {
  const editing = !!recruitment;
  const { notify } = useToast();
  const invalidate = useInvalidateRecruitment();
  const positions = useJobPositionOptions();
  const surveys = useSurveyOptions();

  const [step, setStep] = useState<Step>(0);
  const [reached, setReached] = useState<Step>(editing ? 2 : 0);
  const [title, setTitle] = useState(recruitment?.title ?? '');
  const [description, setDescription] = useState(recruitment?.description ?? '');
  const [managerIds, setManagerIds] = useState<number[]>(recruitment?.managers.map((m) => m.id) ?? []);
  const [startDate, setStartDate] = useState(recruitment?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(recruitment?.endDate ?? '');
  const [surveyId, setSurveyId] = useState(recruitment?.surveyTemplate ? String(recruitment.surveyTemplate.id) : '');
  const [skills, setSkills] = useState<string[]>(recruitment?.skills ?? []);
  const [isPublished, setIsPublished] = useState(recruitment?.isPublished ?? false);
  const [optionalResume, setOptionalResume] = useState(recruitment?.optionalResume ?? false);
  const [optionalPhoto, setOptionalPhoto] = useState(recruitment?.optionalPhoto ?? true);
  const [vacancies, setVacancies] = useState<VacancyRow[]>(
    recruitment?.vacancies.map((v) => ({ key: `v${v.id}`, jobPositionId: String(v.jobPositionId), vacancies: String(v.vacancies), applied: v.applied, filled: v.filled }))
      ?? [{ key: nextKey(), jobPositionId: '', vacancies: '1', applied: 0, filled: 0 }],
  );
  const [stages, setStages] = useState<StageRow[]>(
    recruitment?.stages.map((s) => ({ key: `s${s.id}`, id: s.id, name: s.name, stageType: s.stageType, count: s.count })) ?? DEFAULT_STAGES,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const totalVacancy = useMemo(() => vacancies.reduce((n, v) => n + (Number.isInteger(Number(v.vacancies)) ? Number(v.vacancies) : 0), 0), [vacancies]);

  const validate = (s: Step): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (title.trim().length < 3) e.title = 'Enter at least 3 characters';
      if (!description.trim()) e.description = 'Add a description';
      if (!managerIds.length) e.managerIds = 'Choose at least one manager';
      if (!startDate) e.startDate = 'Choose a start date';
      if (endDate && startDate && endDate < startDate) e.endDate = 'End date is before the start date';
    }
    if (s === 1) {
      const chosen = vacancies.map((v) => v.jobPositionId).filter(Boolean);
      if (!vacancies.length) e.vacancies = 'Add at least one vacancy line';
      else if (vacancies.some((v) => !v.jobPositionId)) e.vacancies = 'Choose a job position on every line';
      else if (new Set(chosen).size !== chosen.length) e.vacancies = 'Each job position can appear only once';
      else {
        for (const v of vacancies) {
          const n = Number(v.vacancies);
          if (!Number.isInteger(n) || n < 1 || n > 1000) { e.vacancies = 'Vacancies must be a whole number from 1 to 1000'; break; }
          if (n < v.filled) { e.vacancies = `A line already has ${v.filled} hired; vacancies cannot go below that`; break; }
        }
      }
    }
    if (s === 2) {
      const names = stages.map((x) => x.name.trim().toLowerCase());
      if (stages.some((x) => !x.name.trim())) e.stages = 'Name every stage';
      else if (new Set(names).size !== names.length) e.stages = 'Two stages have the same name';
      else if (stages.length < 3) e.stages = 'A pipeline needs at least 3 stages';
    }
    return e;
  };

  const goNext = () => {
    const e = validate(step);
    setErrors(e);
    if (Object.keys(e).length) return;
    const n = (step + 1) as Step;
    setStep(n);
    setReached((r) => (n > r ? n : r) as Step);
  };
  const goTo = (s: Step) => {
    if (s <= step) return setStep(s);
    // Forward by clicking a step header only if every step before it is valid.
    for (let i = 0; i < s; i++) {
      const e = validate(i as Step);
      if (Object.keys(e).length) { setStep(i as Step); setErrors(e); return; }
    }
    setStep(s);
    setReached((r) => (s > r ? s : r) as Step);
  };

  const save = useMutation({
    mutationFn: async () => {
      const body: RecruitmentBody = {
        title: title.trim(), description: description.trim(), managerIds, startDate, endDate: endDate || null,
        surveyTemplateId: surveyId ? Number(surveyId) : null, skills, isPublished, optionalResume, optionalPhoto,
        vacancies: vacancies.map((v) => ({ jobPositionId: Number(v.jobPositionId), vacancies: Number(v.vacancies) })),
        stages: stages.map((s) => ({ ...(s.id ? { id: s.id } : {}), name: s.name.trim(), stageType: s.stageType })),
      };
      return recruitment
        ? recruitmentApi.recruitments.update(recruitment.id, { ...body, updatedAt: recruitment.updatedAt })
        : recruitmentApi.recruitments.create(body);
    },
    onSuccess: async (saved) => {
      await invalidate();
      notify({ tone: 'success', title: editing ? 'Recruitment saved' : 'Recruitment created' });
      onSaved(saved);
    },
    onError: (e) => {
      if (isStale(e)) { setStale(true); return; }
      const fe = fieldErrors(e);
      if (Object.keys(fe).length) {
        setErrors(fe);
        const first = Object.keys(fe).map((k) => FIELD_STEP[k]).filter((s) => s !== undefined).sort()[0];
        if (first !== undefined) setStep(first);
        setFormError(Object.keys(fe).some((k) => !(k in FIELD_STEP)) ? Object.values(fe).join(' ') : null);
      } else setFormError(errorText(e));
    },
  });

  const submit = () => {
    setFormError(null);
    for (const s of [0, 1, 2] as Step[]) {
      const e = validate(s);
      if (Object.keys(e).length) { setErrors(e); setStep(s); return; }
    }
    setErrors({});
    save.mutate();
  };

  // ------------------------------------------------------------ pipeline ops --
  const moveStage = (from: number, to: number) => {
    // The Applied stage stays first and Rejected stays last.
    if (to < 1 || to > stages.length - 2 || from < 1 || from > stages.length - 2 || from === to) return;
    setStages((list) => {
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };
  const addStage = () => setStages((list) => {
    const at = Math.max(1, list.findIndex((s) => s.stageType === 'hired'));
    const next = [...list];
    next.splice(at < 1 ? list.length - 1 : at, 0, { key: nextKey(), name: '', stageType: 'initial', count: 0 });
    return next;
  });

  const stepErr = (s: Step) => Object.keys(errors).some((k) => FIELD_STEP[k] === s);

  return (
    <Dialog open onClose={save.isPending ? () => undefined : onClose} size="lg" title={editing ? 'Edit recruitment' : 'Add recruitment'}
      footer={
        <>
          <div className="mr-auto flex gap-2">
            {step > 0 && <Button variant="outline" icon={<ChevronLeft className="size-4" />} onClick={() => setStep((step - 1) as Step)} disabled={save.isPending}>Back</Button>}
          </div>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          {step < 2
            ? <Button onClick={goNext}>Next<ChevronRight className="size-4" aria-hidden /></Button>
            : <Button onClick={submit} loading={save.isPending}>{editing ? 'Save' : 'Create'}</Button>}
        </>
      }>
      <ol className="mb-5 grid grid-cols-3 gap-2" aria-label="Steps">
        {STEPS.map((s, i) => {
          const active = step === i;
          const done = i < step || (i <= reached && i !== step && !stepErr(i as Step));
          return (
            <li key={s.title}>
              <button type="button" onClick={() => goTo(i as Step)} aria-current={active ? 'step' : undefined}
                className={cn('flex w-full items-center gap-2 rounded-lg border p-2 text-left transition-colors sm:p-2.5',
                  active ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-slate-50', stepErr(i as Step) && 'border-danger')}>
                <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                  active ? 'bg-primary text-white' : done ? 'bg-success-soft text-green-700' : 'bg-slate-100 text-slate-600')}>{done && !active ? '✓' : i + 1}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink">{s.title}</span>
                  <span className="hidden truncate text-xs text-muted sm:block">{s.hint}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {stale && (
        <div className="mb-4">
          <InlineAlert tone="warning" title="This recruitment was changed by someone else">
            <p>Your changes are still here. Reload to get the latest version, then re-apply them.</p>
            <Button size="sm" variant="outline" className="mt-2" icon={<RotateCw className="size-4" />}
              onClick={async () => { await invalidate(); onClose(); }}>Close and reload</Button>
          </InlineAlert>
        </div>
      )}
      {formError && <div className="mb-4"><InlineAlert>{formError}</InlineAlert></div>}

      {step === 0 && (
        <div className="space-y-4">
          <Field label="Title" required error={errors.title}>
            {({ id, invalid, describedBy }) => <Input id={id} data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} aria-invalid={invalid} aria-describedby={describedBy} placeholder="e.g. Financial Analyst Hiring" />}
          </Field>
          <Field label="Description" required error={errors.description} hint="Shown on the careers page. Use the toolbar for headings, bold and lists.">
            {({ id, invalid, describedBy }) => <RichTextEditor id={id} value={description} onChange={setDescription} invalid={invalid} describedBy={describedBy} />}
          </Field>
          <Field label="Managers" required error={errors.managerIds} hint="Employees responsible for this recruitment.">
            {({ id, invalid, describedBy }) => (
              <EmployeePicker id={id} value={managerIds} onChange={(ids) => setManagerIds(ids)} invalid={invalid} describedBy={describedBy}
                selected={recruitment?.managers} />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Start date" required error={errors.startDate}>
              {({ id, invalid, describedBy }) => <Input id={id} type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy} />}
            </Field>
            <Field label="End date" error={errors.endDate} hint="Leave empty to keep it open until closed.">
              {({ id, invalid, describedBy }) => <Input id={id} type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy} />}
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Survey template" error={errors.surveyTemplateId} hint="Extra questions applicants answer.">
              {({ id, invalid, describedBy }) => (
                <Select id={id} value={surveyId} onChange={(e) => setSurveyId(e.target.value)} aria-invalid={invalid} aria-describedby={describedBy}>
                  <option value="">None</option>
                  {recruitment?.surveyTemplate && !surveys.data?.some((s) => s.id === recruitment.surveyTemplate!.id) && (
                    <option value={recruitment.surveyTemplate.id}>{recruitment.surveyTemplate.name} (inactive)</option>
                  )}
                  {surveys.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Skills" error={errors.skills}>
              {({ id }) => <TagsInput id={id} value={skills} onChange={setSkills} />}
            </Field>
          </div>
          <fieldset className="grid gap-3 rounded-lg border border-line p-3 sm:grid-cols-3">
            <legend className="px-1 text-xs font-medium text-muted">Careers page</legend>
            <Toggle label="Publish" hint="Visible on the public careers page" checked={isPublished} onChange={setIsPublished} />
            <Toggle label="Resume is optional" hint="Applicants may skip it" checked={optionalResume} onChange={setOptionalResume} />
            <Toggle label="Allow profile photo" hint="Applicants may add one" checked={optionalPhoto} onChange={setOptionalPhoto} />
          </fieldset>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Add one line for each job position with the number of people to hire. A position with hires cannot go below the number already filled.</p>
          {errors.vacancies && <InlineAlert>{errors.vacancies}</InlineAlert>}
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <caption className="sr-only">Vacancy lines</caption>
              <thead className="bg-slate-50/70 text-xs font-medium tracking-wide text-muted uppercase">
                <tr><th className="px-3 py-2">Job position</th><th className="px-3 py-2 text-right">Applied</th><th className="px-3 py-2 text-right">Filled</th><th className="w-28 px-3 py-2">Vacancies</th><th className="w-10"><span className="sr-only">Remove</span></th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {vacancies.map((v, i) => {
                  const taken = new Set(vacancies.filter((x) => x.key !== v.key).map((x) => x.jobPositionId));
                  const locked = v.applied > 0;
                  return (
                    <tr key={v.key}>
                      <td className="px-3 py-2">
                        <Select aria-label={`Job position ${i + 1}`} value={v.jobPositionId} disabled={locked}
                          onChange={(e) => setVacancies((l) => l.map((x) => (x.key === v.key ? { ...x, jobPositionId: e.target.value } : x)))}>
                          <option value="">Choose a position…</option>
                          {(positions.data ?? []).map((p) => (
                            <option key={p.id} value={p.id} disabled={taken.has(String(p.id))}>{p.title}{p.department ? ` (${p.department})` : ''}</option>
                          ))}
                          {v.jobPositionId && !positions.data?.some((p) => String(p.id) === v.jobPositionId) && (
                            <option value={v.jobPositionId}>{recruitment?.vacancies.find((x) => String(x.jobPositionId) === v.jobPositionId)?.title ?? 'Position'}</option>
                          )}
                        </Select>
                      </td>
                      <td className="tabular px-3 py-2 text-right text-slate-600">{v.applied}</td>
                      <td className="tabular px-3 py-2 text-right text-slate-600">{v.filled}</td>
                      <td className="px-3 py-2">
                        <Input aria-label={`Vacancies for line ${i + 1}`} inputMode="numeric" className="text-right" value={v.vacancies}
                          onChange={(e) => setVacancies((l) => l.map((x) => (x.key === v.key ? { ...x, vacancies: e.target.value } : x)))} />
                      </td>
                      <td className="px-1">
                        <Button size="icon" variant="ghost" aria-label={`Remove line ${i + 1}`} disabled={locked || vacancies.length === 1}
                          title={locked ? 'This position already has applications' : undefined}
                          onClick={() => setVacancies((l) => l.filter((x) => x.key !== v.key))}><X className="size-4" /></Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button variant="outline" size="sm" icon={<Plus className="size-4" />}
              onClick={() => setVacancies((l) => [...l, { key: nextKey(), jobPositionId: '', vacancies: '1', applied: 0, filled: 0 }])}
              disabled={vacancies.length >= 20}>Add line</Button>
            <span className="text-sm text-muted">Total vacancies: <strong className="tabular text-ink">{totalVacancy}</strong></span>
          </div>
          {positions.data?.length === 0 && (
            <InlineAlert tone="info">No job positions yet. Create them in Recruitment › Configuration first.</InlineAlert>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <p className="text-sm text-muted">Drag stages (or use the arrows) to reorder, rename them, change their type, or remove ones you do not need. Applied stays first and Rejected last.</p>
          {errors.stages && <InlineAlert>{errors.stages}</InlineAlert>}
          <ul className="space-y-2">
            {stages.map((s, i) => {
              const edge = i === 0 || i === stages.length - 1;
              const fixed = isFixed(s.stageType);
              return (
                <li key={s.key} draggable={!edge}
                  onDragStart={(e) => { setDragKey(s.key); e.dataTransfer.effectAllowed = 'move'; }}
                  onDragOver={(e) => { if (dragKey && !edge) e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); const from = stages.findIndex((x) => x.key === dragKey); moveStage(from, i); setDragKey(null); }}
                  onDragEnd={() => setDragKey(null)}
                  className={cn('flex items-center gap-2 rounded-lg border border-line bg-surface p-2', dragKey === s.key && 'opacity-50')}>
                  <GripVertical className={cn('size-4 shrink-0', edge ? 'text-slate-200' : 'cursor-grab text-slate-400')} aria-hidden />
                  <span className="tabular flex size-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">{i + 1}</span>
                  <Input aria-label={`Stage ${i + 1} name`} value={s.name} maxLength={100} className="min-w-0 flex-1"
                    onChange={(e) => setStages((l) => l.map((x) => (x.key === s.key ? { ...x, name: e.target.value } : x)))} />
                  {fixed ? (
                    <span className="hidden w-32 shrink-0 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600 sm:block">{STAGE_TYPE_LABEL[s.stageType]}</span>
                  ) : (
                    <Select aria-label={`Stage ${i + 1} type`} className="hidden w-32 shrink-0 sm:block" value={s.stageType}
                      onChange={(e) => setStages((l) => l.map((x) => (x.key === s.key ? { ...x, stageType: e.target.value as StageType } : x)))}>
                      {FREE_STAGE_TYPES.map((t) => <option key={t} value={t}>{STAGE_TYPE_LABEL[t]}</option>)}
                    </Select>
                  )}
                  {s.count > 0 && <span className="tabular hidden shrink-0 text-xs text-muted md:inline">{s.count} cand.</span>}
                  <div className="flex shrink-0">
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Move ${s.name || 'stage'} up`} disabled={edge || i === 1} onClick={() => moveStage(i, i - 1)}><ArrowUp className="size-4" /></Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Move ${s.name || 'stage'} down`} disabled={edge || i === stages.length - 2} onClick={() => moveStage(i, i + 1)}><ArrowDown className="size-4" /></Button>
                    <Button size="icon" variant="ghost" className="size-8" aria-label={`Remove ${s.name || 'stage'}`} disabled={fixed || s.count > 0}
                      title={fixed ? 'Required stage' : s.count > 0 ? 'Move its candidates first' : undefined}
                      onClick={() => setStages((l) => l.filter((x) => x.key !== s.key))}><X className="size-4" /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={addStage} disabled={stages.length >= 20}>Add stage</Button>
        </div>
      )}
    </Dialog>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
      <span aria-hidden className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full bg-slate-300 transition-colors peer-checked:bg-primary peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-4" />
      <span className="min-w-0"><span className="block text-sm font-medium text-ink">{label}</span><span className="block text-xs text-muted">{hint}</span></span>
    </label>
  );
}

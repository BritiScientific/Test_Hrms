import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Circle } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { employeesApi } from '@/services/employees-api';
import type { AccessStatus, Employee, EmploymentType } from '@/types/api';

export const empKeys = {
  list: (q: object) => ['employees', 'list', q] as const,
  one: (id: number) => ['employees', 'detail', id] as const,
  mine: ['employees', 'mine'] as const,
  departments: ['employees', 'departments'] as const,
  managers: ['employees', 'managers'] as const,
};

export const useDepartments = (enabled = true) =>
  useQuery({ queryKey: empKeys.departments, queryFn: employeesApi.departments, enabled, staleTime: 60_000 });

/** Current employees for the manager picker (first 100; type to filter). */
export const useManagerOptions = (enabled = true) =>
  useQuery({
    queryKey: empKeys.managers,
    queryFn: () => employeesApi.list({ limit: 100 }),
    enabled,
    staleTime: 60_000,
    select: (p) => p.items.map((e) => ({ value: String(e.id), label: e.fullName, hint: e.jobTitle ?? e.employeeCode })),
  });

export function useInvalidateEmployees() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['employees'] }),
    qc.invalidateQueries({ queryKey: ['users'] }),
    qc.invalidateQueries({ queryKey: ['audit'] }),
    qc.invalidateQueries({ queryKey: ['me'] }),
  ]);
}

const ACCESS: Record<AccessStatus, { tone: BadgeTone; label: string; help: string }> = {
  active: { tone: 'success', label: 'Active', help: 'Can sign in' },
  invited: { tone: 'primary', label: 'Invited', help: 'Activation link sent, not used yet' },
  invite_expired: { tone: 'warning', label: 'Link expired', help: 'Issue a new activation link' },
  no_login: { tone: 'neutral', label: 'No login', help: 'Record only, no portal access' },
  suspended: { tone: 'warning', label: 'Suspended', help: 'Access suspended' },
  left: { tone: 'neutral', label: 'No access', help: 'Left the organization' },
};

export function AccessBadge({ status }: { status: AccessStatus }) {
  const a = ACCESS[status] ?? ACCESS.no_login;
  return <Badge tone={a.tone}><span title={a.help}>{a.label}</span></Badge>;
}

export function ProfileBadge({ profile }: { profile: Employee['profile'] }) {
  return profile.completed
    ? <Badge tone="success">Profile complete</Badge>
    : <Badge tone="warning" className="tabular">{profile.done}/{profile.total} details</Badge>;
}

export const EMPLOYMENT_TYPES: { value: EmploymentType; label: string }[] = [
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contract', label: 'Contract' },
  { value: 'intern', label: 'Intern' },
];
export const employmentLabel = (t: EmploymentType) => EMPLOYMENT_TYPES.find((x) => x.value === t)?.label ?? t;

export const GENDERS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'non_binary', label: 'Non-binary' },
  { value: 'other', label: 'Other' },
  { value: 'prefer_not_to_say', label: 'Prefer not to say' },
];

export const STATUS_LABEL = { active: 'Employed', on_notice: 'On notice', exited: 'Exited' } as const;

/** Checklist of the self-service details that make a profile complete. */
export function ProfileChecklist({ employee, audience }: { employee: Employee; audience: 'hr' | 'self' }) {
  const p = employee.profile;
  const all = ['Date of birth', 'Mobile phone', 'City', 'Country', 'Emergency contact name', 'Emergency contact phone'];
  const missing = new Set(p.missing.map((m) => m.label));
  return (
    <div>
      <div className="mb-1.5 flex justify-between text-xs text-muted">
        <span>{p.done} of {p.total} details</span>
        <span className="tabular">{Math.round((p.done / p.total) * 100)}%</span>
      </div>
      <div className="mb-4 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Profile completeness"
        aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
        <div className={`h-full rounded-full ${p.completed ? 'bg-success' : 'bg-primary'}`} style={{ width: `${(p.done / p.total) * 100}%` }} />
      </div>
      <ul className="space-y-2">
        {all.map((label) => {
          const done = !missing.has(label);
          return (
            <li key={label} className="flex items-center gap-2 text-sm">
              {done ? <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="Done" /> : <Circle className="size-4 shrink-0 text-slate-300" aria-label="Missing" />}
              <span className={done ? 'text-slate-600' : 'text-ink'}>{label}</span>
            </li>
          );
        })}
      </ul>
      {!p.completed && (
        <p className="mt-3 text-xs text-muted">
          {audience === 'hr'
            ? employee.access.status === 'active'
              ? 'The employee can fill these from “My profile”. You can also fill them here.'
              : 'The employee will be asked for these after activating. You can also fill them here.'
            : 'Add these so HR has what it needs. Everything else is managed by HR.'}
        </p>
      )}
    </div>
  );
}

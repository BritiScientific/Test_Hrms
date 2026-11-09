import type { BadgeTone } from '@/components/ui/Badge';
import type { CompOffStatus, HalfDaySession, LeaveStatus, RuleStatus } from '@/types/leave';
import { formatDate } from '@/utils/format';
import type { TenantPreferences } from '@/types/api';

export const STATUS_LABEL: Record<LeaveStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Pending', tone: 'warning' },
  returned: { label: 'Returned', tone: 'violet' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const COMP_OFF_STATUS: Record<CompOffStatus, { label: string; tone: BadgeTone }> = {
  pending: { label: 'Awaiting approval', tone: 'warning' },
  returned: { label: 'Returned', tone: 'violet' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
};

export const RULE_STATUS: Record<RuleStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  active: { label: 'Active', tone: 'success' },
  archived: { label: 'Archived', tone: 'neutral' },
};

export const TXN_LABEL: Record<string, string> = {
  OPENING_BALANCE: 'Opening balance',
  ACCRUAL: 'Accrual',
  LEAVE_HOLD: 'Held for a request',
  LEAVE_HOLD_RELEASE: 'Hold released',
  LEAVE_CONSUMPTION: 'Leave taken',
  LEAVE_REVERSAL: 'Leave reversed',
  CARRY_FORWARD: 'Carried forward in',
  CARRY_FORWARD_OUT: 'Carried forward out',
  EXPIRY: 'Expired',
  MANUAL_CREDIT: 'Manual credit',
  MANUAL_DEBIT: 'Manual debit',
  COMP_OFF_CREDIT: 'Comp off credit',
  ENCASHMENT: 'Encashment',
};

export const ACTION_LABEL: Record<string, string> = {
  submit: 'Submitted',
  resubmit: 'Resubmitted',
  approve: 'Approved',
  reject: 'Rejected',
  return: 'Returned for information',
  cancel: 'Cancelled',
  auto_skip: 'Step skipped',
  complete: 'Fully approved',
  reassign: 'Reassigned',
  escalate: 'Escalated',
};

export const CATEGORY_OPTIONS = [
  { value: 'casual', label: 'Casual' },
  { value: 'sick', label: 'Sick' },
  { value: 'earned', label: 'Earned' },
  { value: 'maternity', label: 'Maternity' },
  { value: 'paternity', label: 'Paternity' },
  { value: 'bereavement', label: 'Bereavement' },
  { value: 'comp_off', label: 'Compensatory off' },
  { value: 'loss_of_pay', label: 'Loss of pay' },
  { value: 'other', label: 'Other' },
];

export const HOLIDAY_TYPES = [
  { value: 'national', label: 'National' },
  { value: 'state', label: 'State' },
  { value: 'festival', label: 'Festival' },
  { value: 'optional', label: 'Optional' },
  { value: 'organization', label: 'Organization' },
];

export const FREQUENCY_OPTIONS = [
  { value: 'annual', label: 'Annual allocation' },
  { value: 'monthly', label: 'Monthly accrual' },
  { value: 'quarterly', label: 'Quarterly accrual' },
  { value: 'joining_date', label: 'On joining-date anniversary' },
  { value: 'one_time', label: 'One-time grant' },
  { value: 'manual', label: 'Manual credit only' },
];

export const labelOf = (options: { value: string; label: string }[], value: string | null | undefined) =>
  options.find((o) => o.value === value)?.label ?? value ?? '—';

/** "1", "1.5", "0.5": days without noise. */
export const days = (n: number | null | undefined) => (n === null || n === undefined ? '—' : String(Number(Number(n).toFixed(2))));
export const daysLabel = (n: number) => `${days(n)} ${Number(n) === 1 ? 'day' : 'days'}`;

export const sessionLabel = (s: HalfDaySession | null | undefined) =>
  s === 'first_half' ? 'First half' : s === 'second_half' ? 'Second half' : '';

export function dateRange(
  r: { startDate: string; endDate: string; halfDaySession?: HalfDaySession | null },
  prefs?: Pick<TenantPreferences, 'dateFormat' | 'timezone'>,
) {
  const start = formatDate(r.startDate, prefs);
  if (r.startDate === r.endDate) return r.halfDaySession ? `${start} (${sessionLabel(r.halfDaySession)})` : start;
  return `${start} – ${formatDate(r.endDate, prefs)}`;
}

/** Today in the organization's timezone, not the browser's. */
export function tenantToday(timeZone?: string) {
  return new Date().toLocaleDateString('en-CA', { timeZone });
}

export function toCsv(columns: { key: string; label: string }[], rows: Record<string, unknown>[]) {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Spreadsheets run a leading = + - @ as a formula, and a name can start with one.
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map((c) => cell(c.label)).join(','), ...rows.map((r) => columns.map((c) => cell(r[c.key])).join(','))].join('\r\n');
}

export function downloadText(fileName: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

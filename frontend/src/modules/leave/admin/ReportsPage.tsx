import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CircleCheck, Download, FileBarChart, TriangleAlert } from 'lucide-react';
import { useMe } from '@/app/providers/AuthProvider';
import { PageHeader } from '@/components/feedback/States';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Field, Select } from '@/components/ui/Field';
import { usePageTitle } from '@/hooks/usePageTitle';
import { leaveApi } from '@/services/leave-api';
import type { ReportColumn } from '@/types/leave';
import { formatDate, formatDateTime } from '@/utils/format';
import { leaveKey, useLookups } from '../hooks';
import { DataTable, QueryState, type Column } from '../components/shared';
import { days, downloadText, tenantToday, toCsv } from '../leave-format';

export const REPORTS = [
  { key: 'balance', label: 'Employee leave balance', hint: 'Every balance bucket, per employee and leave type' },
  { key: 'department', label: 'Department-wise leave', hint: 'Days taken by department' },
  { key: 'utilization', label: 'Leave utilization', hint: 'Share of credited leave that was used' },
  { key: 'leave_type', label: 'Leave type-wise', hint: 'Approved, pending and rejected by leave type' },
  { key: 'monthly', label: 'Monthly', hint: 'Days taken per month and leave type' },
  { key: 'annual', label: 'Annual', hint: 'Days taken per employee in the year' },
  { key: 'pending', label: 'Pending leave', hint: 'Requests waiting for a decision, and on whom' },
  { key: 'accrual', label: 'Accrual', hint: 'Credits: opening, accrual, manual and comp off' },
  { key: 'carry_forward', label: 'Carry forward', hint: 'Carried in, carried out and expired' },
  { key: 'encashment', label: 'Encashment', hint: 'Days encashed' },
  { key: 'audit', label: 'Configuration & HR audit', hint: 'Who changed leave settings or acted on requests' },
];

export default function ReportsPage() {
  usePageTitle('Leave Reports');
  const me = useMe();
  const prefs = me.tenant.preferences;
  const thisYear = Number(tenantToday(prefs.timezone).slice(0, 4));
  const lookups = useLookups();
  const [type, setType] = useState('balance');
  const [year, setYear] = useState(thisYear);
  const [departmentId, setDepartmentId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const q = useQuery({
    queryKey: leaveKey('report', type, year, departmentId, leaveTypeId),
    queryFn: () => leaveApi.report(type, { year, departmentId: departmentId || undefined, leaveTypeId: leaveTypeId || undefined }),
    placeholderData: keepPreviousData,
  });
  const rec = useQuery({ queryKey: leaveKey('reconciliation'), queryFn: leaveApi.reconciliation });
  const meta = REPORTS.find((r) => r.key === type)!;

  const cell = (c: ReportColumn, v: unknown) => {
    if (v === null || v === undefined || v === '') return '—';
    switch (c.kind) {
      case 'days': return days(Number(v));
      case 'percent': return `${v}%`;
      case 'date': return formatDate(String(v), prefs);
      case 'datetime': return formatDateTime(String(v), prefs);
      default: return String(v);
    }
  };
  const columns: Column<Record<string, any>>[] = (q.data?.columns ?? []).map((c) => ({
    key: c.key, header: c.label,
    className: ['days', 'number', 'percent'].includes(c.kind ?? '') ? 'tabular whitespace-nowrap' : undefined,
    render: (r) => cell(c, r[c.key]),
  }));
  const exportCsv = () => {
    if (!q.data) return;
    const rows = q.data.rows.map((r) => Object.fromEntries(q.data!.columns.map((c) => [c.key, c.kind === 'days' ? days(Number(r[c.key])) : c.kind === 'date' || c.kind === 'datetime' ? cell(c, r[c.key]) : r[c.key]])));
    downloadText(`leave-${type}-${year}.csv`, toCsv(q.data.columns, rows));
  };

  return (
    <div>
      <PageHeader title="Leave Reports" description={meta.hint}
        actions={<Button variant="outline" icon={<Download className="size-4" />} onClick={exportCsv} disabled={!q.data?.rows.length}>Export CSV</Button>} />
      {rec.data && (
        <p className="mb-4 flex items-center gap-2 text-sm text-muted">
          {rec.data.inBalance
            ? <><CircleCheck className="size-4 text-success" aria-hidden />Balances reconcile with the ledger.</>
            : <><TriangleAlert className="size-4 text-danger" aria-hidden /><span className="font-medium text-red-700">{rec.data.drift.length} balances do not match the ledger. Report this to your administrator.</span></>}
        </p>
      )}
      <Card>
        <div className="grid gap-3 border-b border-line p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Report">{({ id }) => (
            <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>{REPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</Select>
          )}</Field>
          <Field label="Year">{({ id }) => (
            <Select id={id} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {[thisYear + 1, thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map((y) => <option key={y} value={y}>{y}</option>)}
            </Select>
          )}</Field>
          {type !== 'audit' && (
            <>
              <Field label="Department">{({ id }) => (
                <Select id={id} value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  <option value="">All departments</option>
                  {lookups.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </Select>
              )}</Field>
              <Field label="Leave type">{({ id }) => (
                <Select id={id} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
                  <option value="">All leave types</option>
                  {lookups.data?.leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              )}</Field>
            </>
          )}
        </div>
        <QueryState query={q} isEmpty={(d) => d.rows.length === 0} emptyIcon={<FileBarChart />} emptyTitle="Nothing to report" emptyText="Try another year or clear the filters.">
          {(d) => (
            <>
              <DataTable caption={meta.label} columns={columns} rows={d.rows} rowKey={(r) => JSON.stringify(r)} />
              <p className="border-t border-line px-4 py-2 text-xs text-muted tabular">{d.rows.length} rows</p>
            </>
          )}
        </QueryState>
      </Card>
    </div>
  );
}

import type {
  AccrualRuleConfig, AccrualRunSummary, AdminDashboard, ApplicableType, ApprovalHistoryRow, AssignmentHistoryRow, BalanceRow,
  CalendarConfig, CalendarData, CarryRuleConfig, CarryRunSummary, ClaimableType, CompOffClaim, CompOffRuleConfig,
  EmployeeAssignmentRow, EmployeeDashboard, EmployeeOption, EntitlementConfig, HolidayConfig, LeaveLookups, LeavePreview,
  LeaveRequestDetail, LeaveRequestRow, LeaveTypeConfig, LedgerRow, PagedList, PendingApproval, PolicyConfig, ReportResult,
  TeamDashboard, WorkflowDefinition, WorkflowOptions,
} from '@/types/leave';
import { api, apiRequest, qs } from './api-client';

type Query = Record<string, string | number | boolean | undefined | null>;
/** Workflow engine modules owned by Leave Management: leave requests and comp off claims. */
export type WorkflowModule = 'leave' | 'comp_off';
type Body = Record<string, unknown>;

export interface ApplyBody {
  leaveTypeCode: string;
  startDate: string;
  endDate: string;
  durationType: 'full_day' | 'half_day';
  halfDaySession?: 'first_half' | 'second_half' | null;
  reason: string;
  contactDetails?: string | null;
  attachmentIds?: number[];
}

export const leaveApi = {
  // Employee
  myDashboard: () => api.get<EmployeeDashboard>('/leave/dashboard'),
  applicableTypes: (date?: string) => api.get<{ policy: { id: number; name: string } | null; types: ApplicableType[] }>(`/leave/types${qs({ date })}`),
  preview: (body: ApplyBody) => api.post<LeavePreview>('/leave/requests/preview', body),
  apply: (body: ApplyBody, idempotencyKey: string) =>
    api.post<LeaveRequestDetail>('/leave/requests', body, { headers: { 'idempotency-key': idempotencyKey } }),
  myRequests: (q: Query) => api.get<PagedList<LeaveRequestRow>>(`/leave/requests${qs(q)}`),
  request: (id: number) => api.get<LeaveRequestDetail>(`/leave/requests/${id}`),
  resubmit: (id: number, body: Body) => api.post<LeaveRequestDetail>(`/leave/requests/${id}/resubmit`, body),
  withdraw: (id: number, reason?: string) => api.post<LeaveRequestDetail>(`/leave/requests/${id}/withdraw`, { reason: reason || null }),
  cancel: (id: number, reason: string) => api.post<LeaveRequestDetail>(`/leave/requests/${id}/cancel`, { reason }),
  myBalances: (year: number) => api.get<{ year: number; items: BalanceRow[] }>(`/leave/balances${qs({ year })}`),
  myTransactions: (q: Query) => api.get<PagedList<LedgerRow>>(`/leave/balances/transactions${qs(q)}`),
  myCalendar: (from: string, to: string) => api.get<CalendarData>(`/leave/calendar${qs({ from, to })}`),
  uploadAttachment: (file: File) =>
    apiRequest<{ id: number; fileName: string; contentType: string; byteSize: number }>(
      `/leave/attachments${qs({ fileName: file.name })}`,
      { method: 'POST', raw: file, contentType: file.type || 'application/octet-stream' },
    ),
  removeAttachment: (id: number) => api.del(`/leave/attachments/${id}`),
  attachmentUrl: (id: number) => `/api/v1/leave/attachments/${id}`,
  claimableTypes: () => api.get<ClaimableType[]>('/leave/comp-off/types'),
  myClaims: (q: Query) => api.get<PagedList<CompOffClaim>>(`/leave/comp-off/claims${qs(q)}`),
  createClaim: (body: Body) => api.post<CompOffClaim>('/leave/comp-off/claims', body),
  resubmitClaim: (id: number, reason: string) => api.post<CompOffClaim>(`/leave/comp-off/claims/${id}/resubmit`, { reason }),
  withdrawClaim: (id: number) => api.post<CompOffClaim>(`/leave/comp-off/claims/${id}/withdraw`, {}),

  // Manager
  teamDashboard: () => api.get<TeamDashboard>('/leave/team/dashboard'),
  teamMembers: () => api.get<EmployeeOption[]>('/leave/team/members'),
  teamRequests: (q: Query) => api.get<PagedList<LeaveRequestRow>>(`/leave/team/requests${qs(q)}`),
  pendingApprovals: () => api.get<PendingApproval[]>('/leave/team/approvals/pending'),
  approvalHistory: (q: Query) => api.get<PagedList<ApprovalHistoryRow>>(`/leave/team/approvals/history${qs(q)}`),
  /** The engine validates that this task is yours and is the current step. */
  actOnTask: (taskId: number, action: 'approve' | 'reject' | 'return', comments?: string) =>
    api.post(`/workflows/tasks/${taskId}/${action}`, { comments: comments || null }),

  // HR / admin
  adminDashboard: () => api.get<AdminDashboard>('/leave/admin/dashboard'),
  allRequests: (q: Query) => api.get<PagedList<LeaveRequestRow>>(`/leave/admin/requests${qs(q)}`),
  hrCancel: (id: number, reason: string) => api.post<LeaveRequestDetail>(`/leave/admin/requests/${id}/cancel`, { reason }),
  adminCalendar: (q: Query) => api.get<CalendarData>(`/leave/admin/calendar${qs(q)}`),
  report: (type: string, q: Query) => api.get<ReportResult>(`/leave/admin/reports/${type}${qs(q)}`),
  reconciliation: () => api.get<{ inBalance: boolean; drift: unknown[] }>('/leave/admin/reconciliation'),
  employeeBalances: (employeeId: number, year: number) =>
    api.get<{ year: number; items: BalanceRow[] }>(`/leave/admin/balances${qs({ employeeId, year })}`),
  adjustBalance: (body: Body, idempotencyKey: string) =>
    api.post('/leave/admin/balances/adjust', body, { headers: { 'idempotency-key': idempotencyKey } }),
  encashBalance: (body: Body, idempotencyKey: string) =>
    api.post('/leave/admin/balances/encash', body, { headers: { 'idempotency-key': idempotencyKey } }),
  runAccrual: (dryRun: boolean) => api.post<AccrualRunSummary>('/leave/admin/jobs/accrual', { dryRun }),
  runCarryForward: (fromYear: number, dryRun: boolean) => api.post<CarryRunSummary>('/leave/admin/jobs/carry-forward', { fromYear, dryRun }),
  runExpiry: (dryRun: boolean) => api.post<{ asOf: string; dryRun: boolean; creditsExpired: number; expiredDays: number }>('/leave/admin/jobs/expiry', { dryRun }),
  claims: (q: Query) => api.get<PagedList<CompOffClaim>>(`/leave/admin/comp-off/claims${qs(q)}`),

  // Lookups
  lookups: () => api.get<LeaveLookups>('/leave/lookups'),
  employees: (search?: string) => api.get<EmployeeOption[]>(`/leave/employees${qs({ search, limit: 200 })}`),

  // Configuration
  types: () => api.get<LeaveTypeConfig[]>('/leave/config/types'),
  createType: (b: Body) => api.post<LeaveTypeConfig>('/leave/config/types', b),
  updateType: (id: number, b: Body) => api.patch<LeaveTypeConfig>(`/leave/config/types/${id}`, b),

  policies: () => api.get<PolicyConfig[]>('/leave/config/policies'),
  createPolicy: (b: Body) => api.post<PolicyConfig>('/leave/config/policies', b),
  updatePolicy: (id: number, b: Body) => api.patch<PolicyConfig>(`/leave/config/policies/${id}`, b),
  policyCheck: (id: number) => api.get<{ errors: string[]; warnings: string[] }>(`/leave/config/policies/${id}/activation-check`),
  activatePolicy: (id: number) => api.post<{ policy: PolicyConfig; warnings: string[] }>(`/leave/config/policies/${id}/activate`),
  archivePolicy: (id: number) => api.post<PolicyConfig>(`/leave/config/policies/${id}/archive`),

  entitlements: (policyId?: number) => api.get<EntitlementConfig[]>(`/leave/config/entitlements${qs({ policyId })}`),
  createEntitlement: (b: Body) => api.post<EntitlementConfig>('/leave/config/entitlements', b),
  updateEntitlement: (id: number, b: Body) => api.patch<EntitlementConfig>(`/leave/config/entitlements/${id}`, b),
  deleteEntitlement: (id: number) => api.del(`/leave/config/entitlements/${id}`),

  calendars: (year?: number) => api.get<CalendarConfig[]>(`/leave/config/holiday-calendars${qs({ year })}`),
  createCalendar: (b: Body) => api.post<CalendarConfig>('/leave/config/holiday-calendars', b),
  updateCalendar: (id: number, b: Body) => api.patch<CalendarConfig>(`/leave/config/holiday-calendars/${id}`, b),
  holidays: (calendarId: number) => api.get<HolidayConfig[]>(`/leave/config/holidays${qs({ calendarId })}`),
  createHoliday: (b: Body) => api.post<HolidayConfig>('/leave/config/holidays', b),
  updateHoliday: (id: number, b: Body) => api.patch<HolidayConfig>(`/leave/config/holidays/${id}`, b),
  deleteHoliday: (id: number) => api.del(`/leave/config/holidays/${id}`),

  employeeAssignments: (q: Query) => api.get<PagedList<EmployeeAssignmentRow>>(`/leave/config/employee-assignments${qs(q)}`),
  policyAssignments: (employeeId: number) => api.get<AssignmentHistoryRow[]>(`/leave/config/policy-assignments${qs({ employeeId })}`),
  assignPolicy: (b: Body) => api.post('/leave/config/policy-assignments', b),
  endPolicyAssignment: (id: number, effectiveTo: string | null) => api.patch(`/leave/config/policy-assignments/${id}`, { effectiveTo }),
  deletePolicyAssignment: (id: number) => api.del(`/leave/config/policy-assignments/${id}`),
  calendarAssignments: (employeeId: number) => api.get<AssignmentHistoryRow[]>(`/leave/config/calendar-assignments${qs({ employeeId })}`),
  assignCalendar: (b: Body) => api.post('/leave/config/calendar-assignments', b),
  endCalendarAssignment: (id: number, effectiveTo: string | null) => api.patch(`/leave/config/calendar-assignments/${id}`, { effectiveTo }),
  deleteCalendarAssignment: (id: number) => api.del(`/leave/config/calendar-assignments/${id}`),

  accrualRules: () => api.get<AccrualRuleConfig[]>('/leave/config/accrual-rules'),
  createAccrualRule: (b: Body) => api.post<AccrualRuleConfig>('/leave/config/accrual-rules', b),
  updateAccrualRule: (id: number, b: Body) => api.patch<AccrualRuleConfig>(`/leave/config/accrual-rules/${id}`, b),
  accrualImpact: (id: number) => api.get<{ employeesOnPolicy: number; periodsDueNow: number; daysDueNow: number; note: string }>(`/leave/config/accrual-rules/${id}/impact`),
  activateAccrualRule: (id: number) => api.post(`/leave/config/accrual-rules/${id}/activate`),
  archiveAccrualRule: (id: number) => api.post(`/leave/config/accrual-rules/${id}/archive`),

  carryRules: () => api.get<CarryRuleConfig[]>('/leave/config/carry-forward-rules'),
  createCarryRule: (b: Body) => api.post<CarryRuleConfig>('/leave/config/carry-forward-rules', b),
  updateCarryRule: (id: number, b: Body) => api.patch<CarryRuleConfig>(`/leave/config/carry-forward-rules/${id}`, b),
  activateCarryRule: (id: number) => api.post(`/leave/config/carry-forward-rules/${id}/activate`),
  archiveCarryRule: (id: number) => api.post(`/leave/config/carry-forward-rules/${id}/archive`),

  compOffRules: () => api.get<CompOffRuleConfig[]>('/leave/config/comp-off-rules'),
  createCompOffRule: (b: Body) => api.post<CompOffRuleConfig>('/leave/config/comp-off-rules', b),
  updateCompOffRule: (id: number, b: Body) => api.patch<CompOffRuleConfig>(`/leave/config/comp-off-rules/${id}`, b),

  // Approval workflows use the engine's own endpoints.
  workflowOptions: (module: WorkflowModule) => api.get<WorkflowOptions>(`/leave/config/workflow-options${qs({ module })}`),
  workflows: (module: WorkflowModule) => api.get<WorkflowDefinition[]>(`/workflows/definitions${qs({ module })}`),
  workflow: (id: number) => api.get<WorkflowDefinition>(`/workflows/definitions/${id}`),
  cloneWorkflow: (id: number) => api.post<WorkflowDefinition>(`/workflows/definitions/${id}/clone`),
  createWorkflow: (b: Body) => api.post<WorkflowDefinition>('/workflows/definitions', b),
  updateWorkflow: (id: number, b: Body) => api.put<WorkflowDefinition>(`/workflows/definitions/${id}`, b),
  validateWorkflow: (id: number) => api.post<{ errors: string[] }>(`/workflows/definitions/${id}/validate`),
  publishWorkflow: (id: number) => api.post<WorkflowDefinition>(`/workflows/definitions/${id}/publish`),
  deleteWorkflow: (id: number) => api.del(`/workflows/definitions/${id}`),
};

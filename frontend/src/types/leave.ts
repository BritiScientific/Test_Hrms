/** Shapes returned by the Leave Management API (/api/v1/leave). */

export type LeaveStatus = 'pending' | 'returned' | 'approved' | 'rejected' | 'withdrawn' | 'cancelled';
export type DurationType = 'full_day' | 'half_day';
export type HalfDaySession = 'first_half' | 'second_half';
export type RuleStatus = 'draft' | 'active' | 'archived';

export interface PagedList<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface LeaveRequestRow {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode?: string;
  departmentName: string | null;
  workLocation?: string | null;
  leaveTypeId?: number;
  leaveTypeCode?: string;
  leaveTypeName: string;
  leaveYear?: number;
  startDate: string;
  endDate: string;
  durationType: DurationType;
  halfDaySession: HalfDaySession | null;
  totalDays: number;
  reason?: string;
  status: LeaveStatus;
  decidedAt?: string | null;
  createdAt: string;
}

export interface WorkflowLogEntry {
  id: number;
  action: string;
  stepOrder: number | null;
  cycle: number;
  comments: string | null;
  at: string;
  actorName: string | null;
  onBehalfOfName: string | null;
}

export interface WorkflowTaskEntry {
  id: number;
  stepOrder: number;
  cycle: number;
  stepName: string;
  status: string;
  assignedToName: string;
  actedAt: string | null;
  dueAt: string | null;
}

export interface MyTask {
  taskId: number;
  stepName: string;
  allowReject: boolean;
  allowReturn: boolean;
  viaDelegation: boolean;
  overdue: boolean;
}

export interface BalanceBuckets {
  opening: number;
  accrued: number;
  carriedForward: number;
  adjusted: number;
  compOff: number;
  used: number;
  pending: number;
  expired: number;
  encashed: number;
  carriedOut: number;
  available: number;
}

export interface LeaveRequestDetail extends LeaveRequestRow {
  contactDetails: string | null;
  policyName: string;
  days: { leaveDate: string; dayType: string; chargeableDays: number; holidayName: string | null }[];
  attachments: { id: number; fileName: string; contentType: string; byteSize: number }[];
  balance: BalanceBuckets | null;
  ledger: { id: number; txnType: string; days: number; effectiveDate: string; note: string | null; createdAt: string }[];
  cancellation: { previousStatus: string; daysReversed: number; reason: string; isHrAction: boolean; cancelledAt: string; cancelledByName: string } | null;
  workflow: { instance: { id: number; status: string; cycle: number; currentStepOrder: number | null }; tasks: WorkflowTaskEntry[]; history: WorkflowLogEntry[] } | null;
  myTask: MyTask | null;
  actions: { canWithdraw: boolean; canCancel: boolean; canResubmit: boolean; canHrCancel: boolean };
}

export interface ApplicableType {
  id: number;
  entitlementId: number;
  code: string;
  name: string;
  description: string | null;
  category: string;
  isPaid: boolean;
  requiresAttachment: boolean;
  requiresContactDetails: boolean;
  allowBackdated: boolean;
  maxBackdatedDays: number | null;
  minNoticeDays: number;
  includeNonWorkingDays: boolean;
  annualEntitlement: number;
  effectiveAllowHalfDay: boolean;
  effectiveMaxConsecutiveDays: number | null;
}

export interface ValidationIssue {
  code: string;
  message: string;
  field?: string;
}

export interface LeavePreview {
  ok: boolean;
  issues: ValidationIssue[];
  warnings: string[];
  totalDays: number;
  days: { date: string; dayType: string; chargeableDays: number; holidayName: string | null }[];
  policy: { id: number; code: string; name: string; source: string } | null;
  balance: { available: number; afterRequest: number } | null;
}

export interface BalanceRow extends BalanceBuckets {
  leaveTypeId: number;
  leaveTypeCode: string;
  leaveTypeName: string;
  category: string;
  isPaid: boolean;
  balanceId: number | null;
  leaveYear: number;
  annualEntitlement: number;
  allowNegativeBalance: boolean;
  allowEncashment: boolean;
  nextExpiryOn: string | null;
  expiringDays: number;
}

export interface LedgerRow {
  id: number;
  txnType: string;
  days: number;
  delta: number;
  availableAfter: number;
  effectiveDate: string;
  expiresOn: string | null;
  leaveRequestId: number | null;
  note: string | null;
  createdAt: string;
  leaveTypeCode: string;
  leaveTypeName: string;
  createdByName: string | null;
}

export interface HolidayEntry {
  day: string;
  name: string;
  holidayType: string;
  isOptional: boolean;
  calendarName?: string;
  location?: string | null;
}

export interface EmployeeDashboard {
  hasEmployeeRecord: boolean;
  year: number;
  totals: { entitlement: number; available: number; used: number; pending: number } | null;
  balances: BalanceRow[];
  upcomingLeaves: LeaveRequestRow[];
  recentRequests: LeaveRequestRow[];
  upcomingHolidays: HolidayEntry[];
}

export interface TeamDashboard {
  year: number;
  teamSize: number;
  pendingApprovals: number;
  onLeaveToday: LeaveRequestRow[];
  upcomingAbsences: LeaveRequestRow[];
  approvedStats: { requests: number; days: number };
  byType: { leaveTypeName: string; requests: number; days: number }[];
  availability: { available: number; onLeave: number; availablePercent: number };
}

export interface AdminDashboard {
  year: number;
  totalEmployees: number;
  onLeaveToday: LeaveRequestRow[];
  counts: { pending: number; approved: number; rejected: number; cancelled: number };
  byDepartment: { departmentName: string; requests: number; days: number }[];
  byType: { leaveTypeName: string; requests: number; days: number }[];
  upcomingLeaves: LeaveRequestRow[];
  upcomingHolidays: { holidayDate: string; name: string; holidayType: string; isOptional: boolean; calendarName: string }[];
}

export interface CalendarData {
  weeklyOffs: number[];
  calendarName?: string | null;
  holidays: HolidayEntry[];
  leaves: LeaveRequestRow[];
}

export interface PendingApproval {
  taskId: number;
  stepName: string;
  stepOrder: number;
  allowReject: boolean;
  allowReturn: boolean;
  viaDelegation: boolean;
  overdue: boolean;
  dueAt: string | null;
  /** 'leave' = a leave request (entityId is its id); 'comp_off' = a comp off claim. */
  module: 'leave' | 'comp_off';
  entityId: number;
  summary: {
    employeeName: string;
    employeeCode: string;
    departmentName: string | null;
    leaveType: string;
    startDate: string;
    endDate: string;
    durationType: DurationType;
    halfDaySession: HalfDaySession | null;
    totalDays: number;
    reason: string;
    submittedAt: string;
    balanceAvailable?: number | null;
    /** Comp off claims only. */
    hoursWorked?: number;
    workDayType?: string;
  };
}

export interface ApprovalHistoryRow {
  id: number;
  kind: 'leave' | 'comp_off';
  action: 'approve' | 'reject' | 'return';
  comments: string | null;
  at: string;
  stepOrder: number | null;
  stepName: string | null;
  cycle: number;
  onBehalfOfName: string | null;
  requestId: number;
  requestStatus: LeaveStatus | CompOffStatus;
  startDate: string;
  endDate: string;
  totalDays: number;
  employeeName: string;
  leaveTypeName: string;
}

export type CompOffStatus = 'pending' | 'returned' | 'approved' | 'rejected' | 'withdrawn';

export interface CompOffClaim {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  workDate: string;
  workDayType: string;
  hoursWorked: number;
  earnedDays: number;
  reason: string;
  status: CompOffStatus;
  expiresOn: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedByName: string | null;
  leaveTypeName: string;
  createdAt: string;
  workflowInstanceId: number | null;
  /** The approval step it is waiting at, and who can act, while pending. */
  currentStep: string | null;
  waitingOn: string | null;
}

export interface ClaimableType {
  leaveTypeId: number;
  leaveTypeName: string;
  minimumWorkHours: number;
  earnedDays: number;
  eligibleWorkDayType: string;
  approvalRequired: boolean;
  expiryEnabled: boolean;
  expiryAfterDays: number | null;
}

export interface ReportColumn {
  key: string;
  label: string;
  kind?: 'text' | 'days' | 'number' | 'percent' | 'date' | 'datetime';
}

export interface ReportResult {
  type: string;
  year: number;
  columns: ReportColumn[];
  rows: Record<string, any>[];
}

// ------------------------------------------------------------- configuration --

export interface LeaveTypeConfig {
  id: number;
  code: string;
  name: string;
  description: string | null;
  category: string;
  isPaid: boolean;
  isActive: boolean;
  allowHalfDay: boolean;
  requiresAttachment: boolean;
  requiresContactDetails: boolean;
  allowBackdated: boolean;
  maxBackdatedDays: number | null;
  maxConsecutiveDays: number | null;
  minNoticeDays: number;
  includeNonWorkingDays: boolean;
  inUse: boolean;
}

export interface PolicyConfig {
  id: number;
  code: string;
  name: string;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: RuleStatus;
  isDefault: boolean;
  entitlementCount: number;
  employeeCount: number;
}

export interface EntitlementConfig {
  id: number;
  policyId: number;
  policyName: string;
  policyCode: string;
  leaveTypeId: number;
  leaveTypeCode: string;
  leaveTypeName: string;
  leaveTypeActive: boolean;
  annualEntitlement: number;
  entitlementUnit: string;
  allowNegativeBalance: boolean;
  allowCarryForward: boolean;
  allowEncashment: boolean;
  allowHalfDay: boolean | null;
  maxConsecutiveDays: number | null;
  hasActiveAccrual: boolean;
}

export interface CalendarConfig {
  id: number;
  code: string;
  name: string;
  description: string | null;
  calendarYear: number;
  location: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: RuleStatus;
  isDefault: boolean;
  holidayCount: number;
  employeeCount: number;
}

export interface HolidayConfig {
  id: number;
  calendarId: number;
  name: string;
  holidayDate: string;
  holidayType: string;
  isOptional: boolean;
  description: string | null;
}

export interface AccrualRuleConfig {
  id: number;
  policyEntitlementId: number;
  policyName: string;
  leaveTypeName: string;
  annualEntitlement: number;
  accrualFrequency: string;
  accrualAmount: number;
  accrualStartRule: string;
  creditTiming: string;
  prorationEnabled: boolean;
  maximumBalance: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: RuleStatus;
}

export interface CarryRuleConfig {
  id: number;
  policyEntitlementId: number;
  policyName: string;
  leaveTypeName: string;
  allowCarryForward: boolean;
  allowEncashment: boolean;
  isEnabled: boolean;
  maximumCarryForward: number | null;
  maximumBalance: number | null;
  expiryEnabled: boolean;
  expiryAfterMonths: number | null;
  expiryDateRule: string;
  encashmentAllowed: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: RuleStatus;
}

export interface CompOffRuleConfig {
  id: number;
  leaveTypeId: number;
  leaveTypeName: string;
  minimumWorkHours: number;
  earnedDays: number;
  eligibleWorkDayType: string;
  approvalRequired: boolean;
  expiryEnabled: boolean;
  expiryAfterDays: number | null;
  maximumBalance: number | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
}

export interface EmployeeAssignmentRow {
  id: number;
  fullName: string;
  employeeCode: string;
  employmentType: string;
  workLocation: string | null;
  departmentName: string | null;
  policyName: string | null;
  policyIsDefault: boolean;
  calendarName: string | null;
  calendarSource: 'assigned' | 'location' | 'default' | null;
}

export interface AssignmentHistoryRow {
  id: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  policyName?: string;
  calendarName?: string;
  calendarYear?: number;
  assignmentReason?: string | null;
  assignedByName: string | null;
}

export interface LeaveLookups {
  departments: { id: number; name: string }[];
  locations: string[];
  leaveTypes: { id: number; code: string; name: string; category: string; isActive: boolean }[];
  policies: { id: number; code: string; name: string; status: RuleStatus }[];
  calendars: { id: number; code: string; name: string; calendarYear: number; status: RuleStatus }[];
}

export interface EmployeeOption {
  id: number;
  userId: number | null;
  fullName: string;
  employeeCode: string;
  departmentName: string | null;
}

export interface WorkflowOptions {
  roles: { id: number; name: string }[];
  requiredPermission: string;
  conditionFields: { field: string; label: string; type: 'number' | 'string' | 'boolean' }[];
}

/** Workflow definition rows come straight from the engine, in snake_case. */
export interface WorkflowStep {
  id?: number;
  step_order?: number;
  name: string;
  approver_type: string;
  approver_role_id: number | null;
  specific_user_id: number | null;
  required_permission_code: string;
  approval_mode: 'any' | 'all';
  allow_reject: boolean;
  allow_return: boolean;
  on_no_approver: 'fail' | 'skip' | 'fallback_role';
  fallback_role_id: number | null;
  condition: any | null;
  sla_hours: number | null;
}

export interface WorkflowDefinition {
  id: number;
  module: string;
  name: string;
  description?: string | null;
  version: number;
  status: 'draft' | 'published' | 'archived';
  published_at: string | null;
  created_at: string;
  steps?: WorkflowStep[];
}

export interface AccrualRunSummary {
  asOf: string;
  dryRun: boolean;
  periods: number;
  employees: number;
  creditedDays: number;
  cappedDays: number;
  items: { employeeId: number; employeeName: string; leaveTypeName: string; periodKey: string; days: number; capped: number }[];
}

export interface CarryRunSummary {
  fromYear: number;
  toYear: number;
  dryRun: boolean;
  skippedAlreadyClosed: number;
  totalCarried: number;
  totalLapsed: number;
  balancesWithPending: number;
  lines: { employeeId: number; employeeName: string; leaveTypeName: string; closing: number; carried: number; lapsed: number; pendingInOldYear: number; expiresOn: string | null }[];
}

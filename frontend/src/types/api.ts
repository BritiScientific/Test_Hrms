/** Shapes returned by the HRMS API (/api/v1). Kept in one place so screens share them. */

export interface Membership {
  id: number;
  name: string;
  slug: string;
}

export interface TenantPreferences {
  timezone: string;
  locale: string;
  dateFormat: DateFormat;
  currency: string;
}

export interface TenantSummary {
  id: number;
  slug: string;
  displayName: string;
  legalName: string | null;
  logoUrl: string | null;
  status: 'active' | 'onboarding' | 'inactive';
  onboardingCompleted: boolean;
  preferences: TenantPreferences;
}

export interface Me {
  userId: number;
  tenantId: number;
  employeeId: number | null;
  permissions: string[];
  user: { id: number; email: string; fullName: string };
  tenant: TenantSummary;
  memberships: Membership[];
  session: { id: string; expiresAt: string } | null;
}

export interface LoginSuccess {
  tenantId: number;
  tenants: Membership[];
  session?: { expiresAt: string };
}

export interface TenantRequiredDetails {
  tenants: Membership[];
  selectionToken: string;
}

export interface InvitationInfo {
  email: string;
  fullName: string;
  organizationName: string;
  accountExists: boolean;
}

// ------------------------------------------------------------ organization --

export type DateFormat = 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD' | 'DD MMM YYYY';

export interface Address {
  line1: string | null;
  line2: string | null;
  city: string | null;
  stateProvince: string | null;
  postalCode: string | null;
  countryCode: string | null;
}

export interface OrganizationProfile {
  id: number;
  slug: string;
  displayName: string;
  legalName: string | null;
  industry: string | null;
  website: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPerson: string | null;
  registrationNumber: string | null;
  address: Address;
  status: TenantSummary['status'];
  onboardingCompletedAt: string | null;
  logo: { url: string; contentType: string; byteSize: number; updatedAt: string } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export type ProfilePatch = Partial<Omit<OrganizationProfile, 'id' | 'slug' | 'status' | 'logo' | 'createdAt' | 'updatedAt' | 'onboardingCompletedAt' | 'address'>> & {
  address?: Partial<Address>;
};

export interface OrganizationSettings {
  timezone: string;
  weeklyOffs: number[];
  locale: string;
  dateFormat: DateFormat;
  currency: string;
  financialYearStartMonth: number;
  weekStartDay: number;
  confirmedAt: string | null;
  updatedAt: string | null;
  version: number;
}

export interface OrganizationOptions {
  timezones: string[];
  locales: { code: string; label: string }[];
  currencies: { code: string; label: string }[];
  countries: { code: string; label: string }[];
  dateFormats: DateFormat[];
}

export interface OnboardingStep {
  key: 'profile' | 'contact' | 'address' | 'preferences' | 'branding';
  label: string;
  description: string;
  done: boolean;
  optional: boolean;
}

export interface OnboardingStatus {
  completed: boolean;
  completedAt: string | null;
  canComplete: boolean;
  progress: { done: number; total: number };
  steps: OnboardingStep[];
}

// -------------------------------------------------------------------- rbac --

export interface Permission {
  code: string;
  module: string;
  description: string;
}

export interface RoleSummary {
  id: number;
  name: string;
  description: string | null;
  is_system_role: boolean;
  is_active: boolean;
  permissions: string[];
  permission_count: number;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export interface RoleDetail {
  id: number;
  name: string;
  description: string | null;
  is_system_role: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  created_by: number | null;
  created_by_name: string | null;
  member_count: number;
  permission_count: number;
  permissions: (Permission & { granted_at: string })[];
}

export interface RoleMember {
  assignment_id: number;
  user_id: number;
  full_name: string;
  email: string;
  membership_status: string;
  effective_from: string;
  effective_to: string | null;
  scheduled: boolean;
}

export interface UserRoleChip {
  assignmentId: number;
  roleId: number;
  roleName: string;
  isSystemRole: boolean;
  roleActive: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  scheduled: boolean;
}

export interface DirectoryUser {
  id: number;
  email: string;
  full_name: string;
  is_active: boolean;
  membership_status: 'active' | 'suspended' | 'left';
  joined_at: string;
  employee_code: string | null;
  roles: UserRoleChip[];
}

export interface Paged<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface EffectivePermission extends Permission {
  sources: { roleId: number; roleName: string }[];
}

export interface AuditEvent {
  category: 'rbac' | 'organization';
  id: number;
  action: string;
  target_type: string;
  target_id: number | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  request_id: string | null;
  at: string;
  actor_user_id: number | null;
  actor_name: string | null;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

export interface MyTask {
  task_id: number;
  module: string;
  step_name: string;
  requested_by_name: string;
  overdue: boolean;
}

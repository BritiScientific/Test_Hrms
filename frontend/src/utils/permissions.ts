import type { Permission } from '@/types/api';

/**
 * Presentation helpers for the permission catalogue. The catalogue itself
 * always comes from GET /permissions — nothing here invents permissions; these
 * only label modules that the API returns.
 */

const MODULE_LABELS: Record<string, string> = {
  organization: 'Organization',
  rbac: 'Roles & access',
  employee: 'Employees',
  leave: 'Leave',
  attendance: 'Attendance',
  payroll: 'Payroll',
  workflow: 'Workflow & approvals',
};

const MODULE_ORDER = ['organization', 'rbac', 'employee', 'workflow', 'leave', 'attendance', 'payroll'];

export function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module.charAt(0).toUpperCase() + module.slice(1).replace(/_/g, ' ');
}

export interface PermissionGroup<T extends Permission = Permission> {
  module: string;
  label: string;
  permissions: T[];
}

export function groupByModule<T extends Permission>(perms: T[]): PermissionGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const p of perms) map.set(p.module, [...(map.get(p.module) ?? []), p]);
  const rank = (m: string) => {
    const i = MODULE_ORDER.indexOf(m);
    return i === -1 ? MODULE_ORDER.length : i;
  };
  return [...map.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([module, permissions]) => ({ module, label: moduleLabel(module), permissions }));
}

export function matchesPermission(p: Permission, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return p.code.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)
    || p.module.toLowerCase().includes(q) || moduleLabel(p.module).toLowerCase().includes(q);
}

/** Human label for an audit action code. */
export function auditActionLabel(action: string): string {
  const labels: Record<string, string> = {
    'role.create': 'Role created',
    'role.update': 'Role edited',
    'role.deactivate': 'Role deactivated',
    'role.activate': 'Role re-activated',
    'role.permissions.set': 'Role permissions changed',
    'user_role.assign': 'Role assigned',
    'user_role.revoke': 'Role removed',
    'organization.create': 'Organization created',
    'organization.update': 'Profile updated',
    'organization.settings.update': 'Preferences updated',
    'organization.logo.update': 'Logo updated',
    'organization.logo.remove': 'Logo removed',
    'organization.onboarding.complete': 'Onboarding completed',
    'invitation.create': 'Administrator invited',
    'invitation.accept': 'Invitation accepted',
    'employee.create': 'Employee added',
    'employee.update': 'Employee details changed by HR',
    'employee.self_update': 'Details updated by the employee',
    'employee.invite': 'Activation link issued',
    'employee.profile.complete': 'Profile completed',
  };
  if (labels[action]) return labels[action];
  // Work schedule events are "<entity>.<created|updated|activated|deactivated>".
  const ws = /^(employee_type|shift|work_type|rotating_shift|rotating_work_type|shift_schedule)\.(created|updated|activated|deactivated)$/.exec(action);
  if (ws) {
    const entity: Record<string, string> = {
      employee_type: 'Employee type', shift: 'Shift', work_type: 'Work type', rotating_shift: 'Rotating shift',
      rotating_work_type: 'Rotating work type', shift_schedule: 'Shift schedule',
    };
    return `${entity[ws[1]]} ${ws[2]}`;
  }
  return action;
}

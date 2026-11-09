import type { Tx } from '../../config/db';

export interface ResolvedPolicy {
  id: number;
  code: string;
  name: string;
  source: 'assignment' | 'default';
}

/** The policy governing an employee on a date: their assignment, else the default. */
export async function resolvePolicy(tx: Tx, employeeId: number, date: string): Promise<ResolvedPolicy | null> {
  const a = await tx.query(
    `SELECT p.id, p.code, p.name
       FROM leave_policy_assignments a
       JOIN leave_policies p ON p.tenant_id = a.tenant_id AND p.id = a.policy_id
      WHERE a.employee_id = $1 AND p.status = 'active'
        AND daterange(a.effective_from, a.effective_to, '[]') @> $2::date
        AND daterange(p.effective_from, p.effective_to, '[]') @> $2::date
      LIMIT 1`,
    [employeeId, date],
  );
  if (a.rowCount) return { ...a.rows[0], source: 'assignment' };
  const d = await tx.query(
    `SELECT id, code, name FROM leave_policies
      WHERE is_default AND status = 'active' AND daterange(effective_from, effective_to, '[]') @> $1::date
      LIMIT 1`,
    [date],
  );
  return d.rowCount ? { ...d.rows[0], source: 'default' } : null;
}

export interface EffectiveEntitlement {
  id: number;
  policy_id: number;
  leave_type_id: number;
  annual_entitlement: number;
  allow_negative_balance: boolean;
  allow_carry_forward: boolean;
  allow_encashment: boolean;
  /** Type setting combined with the policy override. */
  effective_allow_half_day: boolean;
  effective_max_consecutive_days: number | null;
}

const EFFECTIVE_COLUMNS = `
  en.id, en.policy_id, en.leave_type_id, en.annual_entitlement, en.allow_negative_balance,
  en.allow_carry_forward, en.allow_encashment,
  (lt.allow_half_day AND COALESCE(en.allow_half_day, true)) AS effective_allow_half_day,
  COALESCE(en.max_consecutive_days, lt.max_consecutive_days) AS effective_max_consecutive_days`;

export async function getEntitlement(tx: Tx, policyId: number, leaveTypeId: number): Promise<EffectiveEntitlement | null> {
  const r = await tx.query<EffectiveEntitlement>(
    `SELECT ${EFFECTIVE_COLUMNS}
       FROM leave_policy_entitlements en
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
      WHERE en.policy_id = $1 AND en.leave_type_id = $2`,
    [policyId, leaveTypeId],
  );
  return r.rows[0] ?? null;
}

/** Leave types an employee can apply for on a date, with the rules the form needs. */
export async function listApplicableTypes(tx: Tx, employeeId: number, date: string) {
  const policy = await resolvePolicy(tx, employeeId, date);
  if (!policy) return { policy: null, types: [] };
  const r = await tx.query(
    `SELECT lt.id, lt.code, lt.name, lt.description, lt.category, lt.is_paid, lt.requires_attachment,
            lt.requires_contact_details, lt.allow_backdated, lt.max_backdated_days, lt.min_notice_days,
            lt.include_non_working_days, ${EFFECTIVE_COLUMNS.replace('en.id,', 'en.id AS entitlement_id,').replace('en.leave_type_id,', '')}
       FROM leave_policy_entitlements en
       JOIN leave_types lt ON lt.tenant_id = en.tenant_id AND lt.id = en.leave_type_id
      WHERE en.policy_id = $1 AND lt.is_active
      ORDER BY lt.name`,
    [policy.id],
  );
  return { policy, types: r.rows };
}

-- =============================================================================
-- 014 — Leave Management: permission catalog replacement
--   * New codes are granted to exactly the roles that held the old code they
--     replace, so nobody silently gains or loses access. Tenant Admin keeps
--     "full access".
--   * Workflow steps reference permissions by code. Published steps are immutable
--     through the API (trg_wf_steps_guard); this one rename is the single reason
--     to bypass that guard, and only the code column changes.
--   * The old codes are then deleted. role_permissions and workflow_steps both
--     use RESTRICT, so a reference missed above fails this migration.
-- =============================================================================

INSERT INTO permissions (code, module, description) VALUES
  -- employee self-service
  ('leave.dashboard.view_self',        'leave', 'View my leave dashboard'),
  ('leave.request.create_self',        'leave', 'Apply for leave for myself and claim comp off'),
  ('leave.request.view_self',          'leave', 'View my own leave requests'),
  ('leave.request.cancel_self',        'leave', 'Withdraw or cancel my own leave requests'),
  ('leave.balance.view_self',          'leave', 'View my leave balances and transactions'),
  ('leave.calendar.view_self',         'leave', 'View my holiday calendar'),
  -- manager
  ('leave.dashboard.view_team',        'leave', 'View the team leave dashboard'),
  ('leave.request.view_team',          'leave', 'View leave requests of direct and indirect reports'),
  ('leave.request.approve',            'leave', 'Approve leave approval tasks assigned to me'),
  ('leave.request.reject',             'leave', 'Reject leave approval tasks assigned to me'),
  ('leave.request.return',             'leave', 'Return leave requests to the employee for more information'),
  ('leave.approval_history.view_team', 'leave', 'View my leave approval history'),
  -- HR / admin
  ('leave.dashboard.view_all',         'leave', 'View the organization leave dashboard'),
  ('leave.request.view_all',           'leave', 'View all leave requests in the organization'),
  ('leave.request.manage',             'leave', 'Cancel any leave request and verify comp off claims'),
  ('leave.calendar.view_all',          'leave', 'View the organization leave calendar'),
  ('leave.reports.view',               'leave', 'View leave reports'),
  ('leave.configuration.view',         'leave', 'View leave types, policies, calendars and rules'),
  ('leave.configuration.manage',       'leave', 'Change leave types, policies, calendars and rules'),
  ('leave.policy.assign',              'leave', 'Assign leave policies and holiday calendars to employees'),
  ('leave.balance.adjust',             'leave', 'Credit, debit and encash balances, and run accrual and carry-forward');

-- Old code -> new codes.
CREATE TEMP TABLE leave_permission_map (old_code text, new_code text) ON COMMIT DROP;
INSERT INTO leave_permission_map VALUES
  ('leave.create',         'leave.request.create_self'),
  ('leave.view.own',       'leave.dashboard.view_self'),
  ('leave.view.own',       'leave.request.view_self'),
  ('leave.view.own',       'leave.balance.view_self'),
  ('leave.view.own',       'leave.calendar.view_self'),
  ('leave.withdraw',       'leave.request.cancel_self'),
  ('leave.view.team',      'leave.dashboard.view_team'),
  ('leave.view.team',      'leave.request.view_team'),
  ('leave.approve',        'leave.request.approve'),
  ('leave.approve',        'leave.request.reject'),
  ('leave.approve',        'leave.request.return'),
  ('leave.approve',        'leave.approval_history.view_team'),
  ('leave.view.all',       'leave.dashboard.view_all'),
  ('leave.view.all',       'leave.request.view_all'),
  ('leave.view.all',       'leave.calendar.view_all'),
  ('leave.view.all',       'leave.reports.view'),
  ('leave.type.manage',    'leave.configuration.view'),
  ('leave.type.manage',    'leave.configuration.manage'),
  ('leave.balance.manage', 'leave.configuration.view'),
  ('leave.balance.manage', 'leave.balance.adjust'),
  ('leave.balance.manage', 'leave.policy.assign'),
  ('leave.balance.manage', 'leave.request.manage');

INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT DISTINCT rp.tenant_id, rp.role_id, np.id
  FROM role_permissions rp
  JOIN permissions op          ON op.id = rp.permission_id
  JOIN leave_permission_map m  ON m.old_code = op.code
  JOIN permissions np          ON np.code = m.new_code
ON CONFLICT DO NOTHING;

-- Existing Tenant Admin system roles keep "full access".
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r JOIN permissions p ON p.module = 'leave' AND p.code NOT IN (SELECT old_code FROM leave_permission_map)
 WHERE r.is_system_role AND r.name = 'Tenant Admin'
ON CONFLICT DO NOTHING;

-- Approval steps act on the new approve permission.
ALTER TABLE workflow_steps DISABLE TRIGGER trg_wf_steps_guard;
UPDATE workflow_steps SET required_permission_code = 'leave.request.approve'
 WHERE required_permission_code = 'leave.approve';
ALTER TABLE workflow_steps ENABLE TRIGGER trg_wf_steps_guard;

DELETE FROM role_permissions rp
 USING permissions p
 WHERE p.id = rp.permission_id
   AND p.code IN (SELECT old_code FROM leave_permission_map);

DELETE FROM permissions WHERE code IN (SELECT old_code FROM leave_permission_map);

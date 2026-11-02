-- =============================================================================
-- 002 — RBAC: global permission catalog, tenant roles, assignments, audit
-- Fixes vs. original design:
--   * Seed list matched the documented catalog (original INSERT omitted
--     attendance.view, employee.update, employee.delete, payroll.view, yet
--     section 25 returned attendance.view as an example result).
--   * leave.reject removed: "can act on approval tasks" is one permission
--     (leave.approve); whether a step may reject/return is a step setting.
--     Two permissions let a role approve but never reject — a dead end.
--   * Catalog deletes are RESTRICT (not CASCADE) so retiring a code cannot
--     silently strip it from every tenant; retire via is_active = false.
--   * user_roles: UNIQUE(tenant,user,role) blocked re-assigning a role after
--     it expired. Replaced with an exclusion constraint on validity periods
--     plus soft revoke (revoked_at/by) so history is preserved.
--   * Every user FK is tenant-scoped (tenant_id, user_id) -> tenant_users.
--   * rbac_audit_log: every role / grant / assignment change is recorded.
-- =============================================================================

-- ------------------------------------------------------------ permissions ----
CREATE TABLE permissions (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         varchar(150) NOT NULL UNIQUE
               CHECK (code ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  module       varchar(100) NOT NULL,
  description  text         NOT NULL,
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

INSERT INTO permissions (code, module, description) VALUES
  -- leave
  ('leave.create',          'leave',      'Apply for leave for self'),
  ('leave.view.own',        'leave',      'View own leave requests and balances'),
  ('leave.view.team',       'leave',      'View leave of direct and indirect reports'),
  ('leave.view.all',        'leave',      'View all leave requests in the tenant'),
  ('leave.approve',         'leave',      'Act on leave approval tasks assigned to me'),
  ('leave.withdraw',        'leave',      'Withdraw own pending or returned leave'),
  ('leave.balance.manage',  'leave',      'Allocate and adjust leave balances'),
  ('leave.type.manage',     'leave',      'Configure leave types and holidays'),
  -- attendance
  ('attendance.view',       'attendance', 'View attendance'),
  ('attendance.regularize', 'attendance', 'Request attendance regularization'),
  ('attendance.regularize.approve', 'attendance', 'Approve attendance regularization'),
  -- employee
  ('employee.view',         'employee',   'View employee records'),
  ('employee.create',       'employee',   'Create employee records'),
  ('employee.update',       'employee',   'Update employee records'),
  ('employee.delete',       'employee',   'Deactivate employee records'),
  -- payroll
  ('payroll.view',          'payroll',    'View payroll'),
  ('payroll.process',       'payroll',    'Process payroll'),
  -- workflow
  ('workflow.view',         'workflow',   'View workflow definitions'),
  ('workflow.configure',    'workflow',   'Create, edit and publish workflow definitions'),
  ('workflow.delegate',     'workflow',   'Delegate my approval tasks to a colleague'),
  ('workflow.admin',        'workflow',   'View all workflow instances and reassign tasks'),
  -- rbac
  ('roles.view',            'rbac',       'View roles and permissions'),
  ('roles.manage',          'rbac',       'Create roles and change role permissions'),
  ('roles.assign',          'rbac',       'Assign and revoke user roles');

-- ------------------------------------------------------------------ roles ----
CREATE TABLE roles (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  name            varchar(100) NOT NULL,
  description     text,
  is_system_role  boolean      NOT NULL DEFAULT false,   -- not editable via API
  is_active       boolean      NOT NULL DEFAULT true,
  created_by      bigint,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_roles_name ON roles (tenant_id, lower(name));
CREATE TRIGGER trg_roles_updated BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- role_permissions ----
CREATE TABLE role_permissions (
  tenant_id      bigint      NOT NULL,
  role_id        bigint      NOT NULL,
  permission_id  bigint      NOT NULL REFERENCES permissions(id) ON DELETE RESTRICT,
  granted_by     bigint,
  granted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, role_id, permission_id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES roles(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, granted_by) REFERENCES tenant_users(tenant_id, user_id)
);

-- ------------------------------------------------------------- user_roles ----
CREATE TABLE user_roles (
  tenant_id       bigint      NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  user_id         bigint      NOT NULL,
  role_id         bigint      NOT NULL,
  effective_from  date        NOT NULL,
  effective_to    date,
  assigned_by     bigint,
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  revoked_by      bigint,
  revoked_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id)     REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, role_id)     REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by)  REFERENCES tenant_users(tenant_id, user_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL),
  CONSTRAINT ex_user_roles_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    user_id   WITH =,
    role_id   WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (revoked_at IS NULL)
);
CREATE INDEX idx_user_roles_user ON user_roles (tenant_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_roles_role ON user_roles (tenant_id, role_id) WHERE revoked_at IS NULL;

-- --------------------------------------------- effective permissions view ----
-- security_invoker => RLS of the underlying tables applies to the caller.
-- A role grants permissions only while: assignment is current (tenant-local
-- date) and not revoked, role is active, permission is active, membership is
-- active and the user account is active.
CREATE VIEW v_effective_permissions WITH (security_invoker = true) AS
SELECT DISTINCT ur.tenant_id, ur.user_id, p.code AS permission_code
FROM user_roles ur
JOIN roles r             ON r.tenant_id = ur.tenant_id AND r.id = ur.role_id AND r.is_active
JOIN role_permissions rp ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id
JOIN permissions p       ON p.id = rp.permission_id AND p.is_active
JOIN tenant_users tu     ON tu.tenant_id = ur.tenant_id AND tu.user_id = ur.user_id
                        AND tu.status = 'active'
JOIN users u             ON u.id = ur.user_id AND u.is_active
WHERE ur.revoked_at IS NULL
  AND ur.effective_from <= tenant_today()
  AND (ur.effective_to IS NULL OR ur.effective_to >= tenant_today());

-- ---------------------------------------------------------- rbac_audit_log ----
CREATE TABLE rbac_audit_log (
  tenant_id      bigint      NOT NULL,
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint      NOT NULL,
  action         varchar(40) NOT NULL CHECK (action IN (
                   'role.create', 'role.update', 'role.deactivate',
                   'role.permissions.set', 'user_role.assign', 'user_role.revoke')),
  target_type    varchar(30) NOT NULL,
  target_id      bigint      NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_rbac_audit_target ON rbac_audit_log (tenant_id, target_type, target_id, at);

-- Append-only guard reused by all audit/ledger tables.
CREATE OR REPLACE FUNCTION forbid_modification() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER trg_rbac_audit_append_only
  BEFORE UPDATE OR DELETE ON rbac_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

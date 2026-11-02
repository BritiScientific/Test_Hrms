-- =============================================================================
-- 005 — Row-Level Security and least-privilege grants
-- Fixes vs. original design:
--   * Policies for EVERY tenant table (the doc showed one and said "repeat").
--   * tenants / users are protected too: a tenant session sees only its own
--     tenant row and only users who are members of it. Login runs through
--     narrow SECURITY DEFINER functions instead of open table access.
--   * Append-only tables get SELECT/INSERT only; leave_balances gets no UPDATE
--     (ledger trigger only); the global catalog is read-only to the app.
--   * The outbox worker gets a dedicated cross-tenant policy on one table.
-- =============================================================================

SET client_min_messages = warning;

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'tenant_users', 'departments', 'employees', 'employee_reporting',
    'roles', 'role_permissions', 'user_roles', 'rbac_audit_log',
    'workflow_definitions', 'workflow_steps', 'workflow_instances',
    'workflow_tasks', 'workflow_action_logs', 'workflow_delegations',
    'outbox_events',
    'leave_types', 'holidays', 'leave_balances', 'leave_requests',
    'leave_balance_transactions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = current_tenant_id());

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_in_tenant ON users USING (
  EXISTS (SELECT 1 FROM tenant_users tu
          WHERE tu.user_id = users.id AND tu.tenant_id = current_tenant_id())
);

-- Outbox dispatcher sees every tenant's events, nothing else.
CREATE POLICY outbox_worker ON outbox_events TO hrms_worker USING (true) WITH CHECK (true);

-- ------------------------------------------------------------ auth helpers ---
-- Pre-tenant lookups needed by /auth/login. Narrow, read-only, definer.
CREATE OR REPLACE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (user_id bigint, password_hash text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, password_hash, is_active FROM users WHERE email = p_email
$$;

CREATE OR REPLACE FUNCTION auth_user_tenants(p_user_id bigint)
RETURNS TABLE (tenant_id bigint, tenant_name varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name
  FROM tenant_users tu JOIN tenants t ON t.id = tu.tenant_id
  WHERE tu.user_id = p_user_id AND tu.status = 'active' AND t.is_active
$$;

REVOKE ALL ON FUNCTION auth_find_user(citext)    FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_user_tenants(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(citext)    TO hrms_app;
GRANT EXECUTE ON FUNCTION auth_user_tenants(bigint) TO hrms_app;

-- ------------------------------------------------------------------ grants ---
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO hrms_app, hrms_worker;

GRANT SELECT ON permissions, tenants, users TO hrms_app;

GRANT SELECT, INSERT, UPDATE ON
  tenant_users, departments, employees, employee_reporting,
  roles, user_roles, workflow_definitions, workflow_instances,
  workflow_tasks, workflow_delegations, leave_types, holidays, leave_requests
TO hrms_app;

GRANT SELECT, INSERT, DELETE ON role_permissions TO hrms_app;
GRANT SELECT, INSERT, DELETE ON workflow_steps TO hrms_app;          -- drafts only (trigger)
GRANT DELETE ON workflow_definitions TO hrms_app;                    -- drafts only (trigger)
GRANT DELETE ON holidays TO hrms_app;

-- Append-only
GRANT SELECT, INSERT ON rbac_audit_log, workflow_action_logs,
  leave_balance_transactions, outbox_events TO hrms_app;

-- Projection maintained by the ledger trigger
-- Projection maintained by the ledger trigger. Column-level UPDATE on updated_at
-- only: needed for SELECT ... FOR UPDATE, but buckets stay trigger-only.
GRANT SELECT, INSERT ON leave_balances TO hrms_app;
GRANT UPDATE (updated_at) ON leave_balances TO hrms_app;

GRANT SELECT ON v_effective_permissions, v_leave_balance_drift TO hrms_app;

GRANT SELECT, UPDATE ON outbox_events TO hrms_worker;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

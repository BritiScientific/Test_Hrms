-- =============================================================================
-- 010 — Organization chart
--   * No new reporting table: the chart reads employee_reporting (effective-dated,
--     one manager per employee at a time).
--   * organization.chart.view: employee.view also exposes personal details (date
--     of birth, phone, address, emergency contact), so a directory-style chart
--     needs its own, narrower permission.
--   * prevent_reporting_cycle() checked only the new line's START date, so a line
--     that begins later could still close a cycle (A -> B from next month, then
--     B -> A from today). It now checks the whole period of the new line.
-- =============================================================================

-- ---------------------------------------------------------- permissions ----
INSERT INTO permissions (code, module, description) VALUES
  ('organization.chart.view', 'organization', 'View the organization chart')
ON CONFLICT (code) DO NOTHING;

-- Roles that can already read employee records, and Tenant Admin ("full access").
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, chart.id
  FROM roles r
  JOIN permissions chart ON chart.code = 'organization.chart.view'
 WHERE (r.is_system_role AND r.name = 'Tenant Admin')
    OR EXISTS (
         SELECT 1 FROM role_permissions rp
           JOIN permissions p ON p.id = rp.permission_id
          WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id AND p.code = 'employee.view')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------- cycle prevention ----
CREATE OR REPLACE FUNCTION prevent_reporting_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cycle boolean;
BEGIN
  -- Ending or shortening a line adds no path, and must stay possible so that a
  -- bad line already in the data can be corrected.
  IF TG_OP = 'UPDATE' AND NEW.employee_id = OLD.employee_id AND NEW.manager_id = OLD.manager_id
     AND daterange(OLD.effective_from, OLD.effective_to, '[]') @> daterange(NEW.effective_from, NEW.effective_to, '[]') THEN
    RETURN NEW;
  END IF;

  -- Two concurrent changes could each pass the check and form a cycle together.
  PERFORM pg_advisory_xact_lock(hashtext('employee_reporting'), NEW.tenant_id::int);

  -- A cycle needs every line on the path to be in force at the same time, so the
  -- period narrows at each step. UNION (not ALL) ends the recursion even if the
  -- data already holds a cycle.
  WITH RECURSIVE chain(emp, period) AS (
    SELECT NEW.manager_id, daterange(NEW.effective_from, NEW.effective_to, '[]')
    UNION
    SELECT er.manager_id, c.period * daterange(er.effective_from, er.effective_to, '[]')
    FROM chain c
    JOIN employee_reporting er
      ON er.tenant_id = NEW.tenant_id
     AND er.employee_id = c.emp
     AND er.id IS DISTINCT FROM NEW.id
     AND daterange(er.effective_from, er.effective_to, '[]') && c.period
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE emp = NEW.employee_id) INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION 'This manager already reports to this employee, directly or indirectly, so the change would create a reporting cycle'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

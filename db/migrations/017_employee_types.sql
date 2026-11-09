-- =============================================================================
-- 017 — Work Schedule Configuration: employee types
--   * A tenant-owned master so HR can name its own categories ("Consultant",
--     "Probation") instead of the four hard-coded employment_type codes.
--   * employees.employment_type is NOT NULL with a CHECK limited to four values,
--     and the org chart and workflow conditions read it. Every employee_types
--     row therefore carries a required base_category (one of those four codes);
--     saving an employee with a type also writes employment_type =
--     base_category, so the legacy column stays correct. Retiring it is a
--     separate, later change.
--   * Nothing is ever deleted: a type is activated or deactivated. hrms_app
--     has no DELETE grant, so a delete is impossible even by mistake.
--   * Every existing tenant gets the same four defaults; new tenants get them
--     from provisioning.ts. Re-running is safe (ON CONFLICT DO NOTHING).
-- =============================================================================

CREATE TABLE employee_types (
  tenant_id      bigint       NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  name           varchar(150) NOT NULL,
  description    text,
  -- Keeps the legacy employees.employment_type CHECK satisfiable.
  base_category  varchar(20)  NOT NULL
                 CHECK (base_category IN ('full_time', 'part_time', 'contract', 'intern')),
  is_active      boolean      NOT NULL DEFAULT true,
  created_by     bigint,
  updated_by     bigint,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_employee_types_name ON employee_types (tenant_id, lower(name));
CREATE INDEX idx_employee_types_active ON employee_types (tenant_id, is_active);
CREATE TRIGGER trg_employee_types_updated BEFORE UPDATE ON employee_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------- defaults per tenant --
-- One row per (tenant, default type). Idempotent: the unique index on
-- (tenant_id, lower(name)) absorbs a re-run, and a tenant that has already
-- renamed a default keeps its own name.
INSERT INTO employee_types (tenant_id, name, base_category, description)
SELECT t.id, v.name, v.base_category, v.description
  FROM tenants t
 CROSS JOIN (VALUES
   ('Full-Time', 'full_time', 'Permanent employee working full standard hours'),
   ('Part-Time', 'part_time', 'Employee working reduced standard hours'),
   ('Contract',  'contract',  'Fixed-term or contractual engagement'),
   ('Intern',    'intern',    'Trainee or internship engagement')
 ) AS v(name, base_category, description)
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------- RLS ----
ALTER TABLE employee_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_types
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- ---------------------------------------------------------------- grants ----
-- No DELETE: types are deactivated, never removed.
GRANT SELECT, INSERT, UPDATE ON employee_types TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

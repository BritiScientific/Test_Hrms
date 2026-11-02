-- =============================================================================
-- 001 — Core identity, tenancy and organisation
-- Fixes vs. original design:
--   * Explicit tenant membership (tenant_users). Every user reference inside a
--     tenant table is a composite FK (tenant_id, user_id) -> tenant_users, so a
--     user from tenant 2 can never be assigned a role/task in tenant 1.
--   * employees.user_id links the HR record to the login identity. The workflow
--     engine assigns tasks to USERS, the reporting hierarchy is between
--     EMPLOYEES — the original doc mixed the two ("manager_id returns user 201").
--   * Tenant timezone + weekly offs: "today" and working-day maths are tenant
--     local, not the DB server's CURRENT_DATE.
--   * Reporting hierarchy: no overlapping periods (exclusion constraint), no
--     cycles (trigger), and the manager index is on manager_id.
-- =============================================================================
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- helpers ----
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::bigint
$$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- tenants ----
CREATE TABLE tenants (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         varchar(200) NOT NULL,
  timezone     text         NOT NULL DEFAULT 'Asia/Kolkata',
  weekly_offs  smallint[]   NOT NULL DEFAULT '{0,6}',   -- 0 = Sunday .. 6 = Saturday
  is_active    boolean      NOT NULL DEFAULT true,
  created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Tenant-local "today". Use this everywhere instead of CURRENT_DATE.
CREATE OR REPLACE FUNCTION tenant_today() RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE t.timezone)::date
  FROM tenants t
  WHERE t.id = current_tenant_id()
$$;

-- ------------------------------------------------------------------ users ----
-- Global login identity (one person may belong to several tenants).
CREATE TABLE users (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          citext       NOT NULL UNIQUE,
  password_hash  text,
  full_name      varchar(200) NOT NULL,
  is_active      boolean      NOT NULL DEFAULT true,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_users (
  tenant_id  bigint      NOT NULL REFERENCES tenants(id),
  user_id    bigint      NOT NULL REFERENCES users(id),
  status     varchar(20) NOT NULL DEFAULT 'active'
             CHECK (status IN ('active', 'suspended', 'left')),
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX idx_tenant_users_user ON tenant_users (user_id);

-- ------------------------------------------------------------ departments ----
CREATE TABLE departments (
  tenant_id         bigint       NOT NULL REFERENCES tenants(id),
  id                bigint GENERATED ALWAYS AS IDENTITY,
  name              varchar(150) NOT NULL,
  head_employee_id  bigint,
  is_active         boolean      NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);

-- -------------------------------------------------------------- employees ----
CREATE TABLE employees (
  tenant_id       bigint       NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  user_id         bigint,                       -- NULL = no system login
  employee_code   varchar(50)  NOT NULL,
  full_name       varchar(200) NOT NULL,
  department_id   bigint,
  status          varchar(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'on_notice', 'exited')),
  date_of_joining date,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_code),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id)
);
CREATE TRIGGER trg_employees_updated BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE departments
  ADD CONSTRAINT fk_department_head
  FOREIGN KEY (tenant_id, head_employee_id) REFERENCES employees(tenant_id, id);

-- ----------------------------------------------------- employee_reporting ----
CREATE TABLE employee_reporting (
  tenant_id       bigint      NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  employee_id     bigint      NOT NULL,
  manager_id      bigint      NOT NULL,
  effective_from  date        NOT NULL,
  effective_to    date,
  created_by      bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, manager_id)  REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)  REFERENCES tenant_users(tenant_id, user_id),
  CHECK (employee_id <> manager_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- One line manager per employee at any point in time.
  CONSTRAINT ex_reporting_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
-- "Who reports to X" (team scope) — the original index was on employee_id
-- but named _manager.
CREATE INDEX idx_reporting_manager  ON employee_reporting (tenant_id, manager_id);
CREATE INDEX idx_reporting_employee ON employee_reporting (tenant_id, employee_id);

-- Reject a line that would create a cycle (A -> B -> ... -> A) as of the new
-- line's start date.
CREATE OR REPLACE FUNCTION prevent_reporting_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_cycle boolean;
BEGIN
  WITH RECURSIVE chain(emp, depth) AS (
    SELECT NEW.manager_id, 1
    UNION ALL
    SELECT er.manager_id, c.depth + 1
    FROM chain c
    JOIN employee_reporting er
      ON er.tenant_id = NEW.tenant_id
     AND er.employee_id = c.emp
     AND er.id IS DISTINCT FROM NEW.id
     AND daterange(er.effective_from, er.effective_to, '[]') @> NEW.effective_from
    WHERE c.depth < 50
  )
  SELECT EXISTS (SELECT 1 FROM chain WHERE emp = NEW.employee_id) INTO v_cycle;

  IF v_cycle THEN
    RAISE EXCEPTION 'Reporting line % -> % would create a cycle',
      NEW.employee_id, NEW.manager_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_reporting_no_cycle
  BEFORE INSERT OR UPDATE ON employee_reporting
  FOR EACH ROW EXECUTE FUNCTION prevent_reporting_cycle();

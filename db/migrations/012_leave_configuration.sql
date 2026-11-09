-- =============================================================================
-- 012 — Leave Management: tenant configuration
--   * Everything a tenant can tune lives in data: types, policies, entitlements,
--     holiday calendars, accrual, carry-forward and comp-off rules.
--   * Effective-dated assignments cannot overlap (exclusion constraints), so
--     "which policy applied on this date" always has exactly one answer.
--   * Rules carry draft/active/archived; only one rule per entitlement can be
--     active for any date. Activating a rule never rewrites past ledger rows.
--   * No location master exists in this system: employees.work_location is free
--     text, so calendars store the same text and are matched case-insensitively.
--   * A leave year is a calendar year (same as leave_holiday_calendars.calendar_year).
-- =============================================================================

-- ------------------------------------------------------------- leave_types ----
CREATE TABLE leave_types (
  tenant_id                 bigint       NOT NULL REFERENCES tenants(id),
  id                        bigint GENERATED ALWAYS AS IDENTITY,
  code                      varchar(30)  NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name                      varchar(100) NOT NULL,
  description               text,
  category                  varchar(20)  NOT NULL DEFAULT 'other' CHECK (category IN (
                              'casual', 'sick', 'earned', 'maternity', 'paternity',
                              'bereavement', 'comp_off', 'loss_of_pay', 'other')),
  is_paid                   boolean      NOT NULL DEFAULT true,
  is_active                 boolean      NOT NULL DEFAULT true,
  allow_half_day            boolean      NOT NULL DEFAULT true,
  requires_attachment       boolean      NOT NULL DEFAULT false,
  requires_contact_details  boolean      NOT NULL DEFAULT false,
  allow_backdated           boolean      NOT NULL DEFAULT false,
  max_backdated_days        integer      CHECK (max_backdated_days IS NULL OR max_backdated_days >= 0),
  max_consecutive_days      numeric(6,2) CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  min_notice_days           integer      NOT NULL DEFAULT 0 CHECK (min_notice_days >= 0),
  -- Maternity-style leave is charged per calendar day, weekly offs and holidays included.
  include_non_working_days  boolean      NOT NULL DEFAULT false,
  created_at                timestamptz  NOT NULL DEFAULT now(),
  updated_at                timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  CHECK (allow_backdated OR max_backdated_days IS NULL)
);
CREATE UNIQUE INDEX uq_leave_types_name ON leave_types (tenant_id, lower(name));
CREATE TRIGGER trg_leave_types_updated BEFORE UPDATE ON leave_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------- leave_policies ----
CREATE TABLE leave_policies (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  code            varchar(30)  NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name            varchar(150) NOT NULL,
  description     text,
  effective_from  date         NOT NULL,
  effective_to    date,
  status          varchar(20)  NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'archived')),
  is_default      boolean      NOT NULL DEFAULT false,
  created_by      bigint,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (NOT is_default OR status <> 'archived')
);
-- At most one default policy for any given date.
ALTER TABLE leave_policies ADD CONSTRAINT ex_leave_policy_one_default EXCLUDE USING gist (
  tenant_id WITH =,
  daterange(effective_from, effective_to, '[]') WITH &&
) WHERE (is_default AND status = 'active');
CREATE TRIGGER trg_leave_policies_updated BEFORE UPDATE ON leave_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------ leave_policy_entitlements ----
CREATE TABLE leave_policy_entitlements (
  tenant_id               bigint       NOT NULL,
  id                      bigint GENERATED ALWAYS AS IDENTITY,
  policy_id               bigint       NOT NULL,
  leave_type_id           bigint       NOT NULL,
  annual_entitlement      numeric(6,2) NOT NULL DEFAULT 0 CHECK (annual_entitlement >= 0),
  entitlement_unit        varchar(10)  NOT NULL DEFAULT 'days' CHECK (entitlement_unit IN ('days')),
  allow_negative_balance  boolean      NOT NULL DEFAULT false,
  allow_carry_forward     boolean      NOT NULL DEFAULT false,
  allow_encashment        boolean      NOT NULL DEFAULT false,
  allow_half_day          boolean,     -- NULL = follow the leave type
  max_consecutive_days    numeric(6,2) CHECK (max_consecutive_days IS NULL OR max_consecutive_days > 0),
  created_at              timestamptz  NOT NULL DEFAULT now(),
  updated_at              timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, policy_id, leave_type_id),
  FOREIGN KEY (tenant_id, policy_id)     REFERENCES leave_policies(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id)
);
CREATE TRIGGER trg_leave_entitlements_updated BEFORE UPDATE ON leave_policy_entitlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------- leave_policy_assignments ----
CREATE TABLE leave_policy_assignments (
  tenant_id          bigint      NOT NULL,
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  employee_id        bigint      NOT NULL,
  policy_id          bigint      NOT NULL,
  effective_from     date        NOT NULL,
  effective_to       date,
  assigned_by        bigint,
  assignment_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id)   REFERENCES leave_policies(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_leave_policy_assignment_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
CREATE INDEX idx_leave_policy_assign_policy ON leave_policy_assignments (tenant_id, policy_id);

-- -------------------------------------------------- leave_holiday_calendars ----
CREATE TABLE leave_holiday_calendars (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  code            varchar(30)  NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]*$'),
  name            varchar(150) NOT NULL,
  description     text,
  calendar_year   integer      NOT NULL CHECK (calendar_year BETWEEN 2000 AND 2100),
  location        varchar(150),   -- matches employees.work_location (no location master exists)
  effective_from  date         NOT NULL,
  effective_to    date,
  status          varchar(20)  NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'archived')),
  is_default      boolean      NOT NULL DEFAULT false,
  created_by      bigint,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code, calendar_year),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
CREATE UNIQUE INDEX uq_leave_calendar_one_default ON leave_holiday_calendars (tenant_id, calendar_year)
  WHERE is_default AND status = 'active';
CREATE INDEX idx_leave_calendar_location ON leave_holiday_calendars (tenant_id, calendar_year, lower(location));
CREATE TRIGGER trg_leave_calendars_updated BEFORE UPDATE ON leave_holiday_calendars
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------- leave_holidays ----
CREATE TABLE leave_holidays (
  tenant_id     bigint       NOT NULL,
  id            bigint GENERATED ALWAYS AS IDENTITY,
  calendar_id   bigint       NOT NULL,
  name          varchar(150) NOT NULL,
  holiday_date  date         NOT NULL,
  holiday_type  varchar(20)  NOT NULL DEFAULT 'organization' CHECK (holiday_type IN (
                  'national', 'state', 'festival', 'optional', 'organization')),
  is_optional   boolean      NOT NULL DEFAULT false,
  description   text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, calendar_id, holiday_date),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES leave_holiday_calendars(tenant_id, id) ON DELETE CASCADE,
  CHECK (holiday_type <> 'optional' OR is_optional)
);
CREATE INDEX idx_leave_holidays_date ON leave_holidays (tenant_id, holiday_date);
CREATE TRIGGER trg_leave_holidays_updated BEFORE UPDATE ON leave_holidays
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A holiday outside its calendar's year would silently never apply.
CREATE FUNCTION leave_guard_holiday_year() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_year integer;
BEGIN
  SELECT calendar_year INTO v_year FROM leave_holiday_calendars
   WHERE tenant_id = NEW.tenant_id AND id = NEW.calendar_id;
  IF v_year IS NOT NULL AND extract(year FROM NEW.holiday_date)::int <> v_year THEN
    RAISE EXCEPTION 'Holiday date % is outside calendar year %', NEW.holiday_date, v_year
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_holiday_year BEFORE INSERT OR UPDATE ON leave_holidays
  FOR EACH ROW EXECUTE FUNCTION leave_guard_holiday_year();

-- ----------------------------------------------- leave_calendar_assignments ----
CREATE TABLE leave_calendar_assignments (
  tenant_id       bigint      NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  employee_id     bigint      NOT NULL,
  calendar_id     bigint      NOT NULL,
  effective_from  date        NOT NULL,
  effective_to    date,
  assigned_by     bigint,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, calendar_id) REFERENCES leave_holiday_calendars(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT ex_leave_calendar_assignment_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  )
);
CREATE INDEX idx_leave_calendar_assign_calendar ON leave_calendar_assignments (tenant_id, calendar_id);

-- ------------------------------------------------------ leave_accrual_rules ----
CREATE TABLE leave_accrual_rules (
  tenant_id              bigint       NOT NULL,
  id                     bigint GENERATED ALWAYS AS IDENTITY,
  policy_entitlement_id  bigint       NOT NULL,
  accrual_frequency      varchar(20)  NOT NULL CHECK (accrual_frequency IN (
                           'annual', 'monthly', 'quarterly', 'joining_date', 'one_time', 'manual')),
  accrual_amount         numeric(6,2) NOT NULL DEFAULT 0 CHECK (accrual_amount >= 0),
  -- joining_date: the period the employee joined in is credited (prorated if enabled).
  -- next_period : credit starts with the first full period after joining.
  accrual_start_rule     varchar(20)  NOT NULL DEFAULT 'joining_date'
                         CHECK (accrual_start_rule IN ('joining_date', 'next_period')),
  credit_timing          varchar(20)  NOT NULL DEFAULT 'period_start'
                         CHECK (credit_timing IN ('period_start', 'period_end')),
  proration_enabled      boolean      NOT NULL DEFAULT false,
  maximum_balance        numeric(6,2) CHECK (maximum_balance IS NULL OR maximum_balance > 0),
  effective_from         date         NOT NULL,
  effective_to           date,
  status                 varchar(20)  NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'archived')),
  is_active              boolean      GENERATED ALWAYS AS (status = 'active') STORED,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_entitlement_id)
    REFERENCES leave_policy_entitlements(tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (accrual_frequency = 'manual' OR accrual_amount > 0),
  CONSTRAINT ex_leave_accrual_one_active EXCLUDE USING gist (
    tenant_id             WITH =,
    policy_entitlement_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);
CREATE TRIGGER trg_leave_accrual_rules_updated BEFORE UPDATE ON leave_accrual_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------ leave_carry_forward_rules ----
CREATE TABLE leave_carry_forward_rules (
  tenant_id              bigint       NOT NULL,
  id                     bigint GENERATED ALWAYS AS IDENTITY,
  policy_entitlement_id  bigint       NOT NULL,
  is_enabled             boolean      NOT NULL DEFAULT true,
  maximum_carry_forward  numeric(6,2) CHECK (maximum_carry_forward IS NULL OR maximum_carry_forward >= 0),
  maximum_balance        numeric(6,2) CHECK (maximum_balance IS NULL OR maximum_balance > 0),
  expiry_enabled         boolean      NOT NULL DEFAULT false,
  expiry_after_months    integer      CHECK (expiry_after_months IS NULL OR expiry_after_months > 0),
  expiry_date_rule       varchar(30)  NOT NULL DEFAULT 'months_after_carry'
                         CHECK (expiry_date_rule IN ('months_after_carry', 'end_of_next_year')),
  encashment_allowed     boolean      NOT NULL DEFAULT false,
  effective_from         date         NOT NULL,
  effective_to           date,
  status                 varchar(20)  NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft', 'active', 'archived')),
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, policy_entitlement_id)
    REFERENCES leave_policy_entitlements(tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (NOT expiry_enabled OR expiry_date_rule <> 'months_after_carry' OR expiry_after_months IS NOT NULL),
  CONSTRAINT ex_leave_carry_one_active EXCLUDE USING gist (
    tenant_id             WITH =,
    policy_entitlement_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (status = 'active')
);
CREATE TRIGGER trg_leave_carry_rules_updated BEFORE UPDATE ON leave_carry_forward_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------- leave_comp_off_rules ----
CREATE TABLE leave_comp_off_rules (
  tenant_id              bigint       NOT NULL,
  id                     bigint GENERATED ALWAYS AS IDENTITY,
  leave_type_id          bigint       NOT NULL,
  minimum_work_hours     numeric(4,2) NOT NULL CHECK (minimum_work_hours > 0 AND minimum_work_hours <= 24),
  earned_days            numeric(4,2) NOT NULL CHECK (earned_days > 0),
  eligible_work_day_type varchar(20)  NOT NULL DEFAULT 'non_working'
                         CHECK (eligible_work_day_type IN ('weekly_off', 'holiday', 'non_working', 'any')),
  approval_required      boolean      NOT NULL DEFAULT true,
  expiry_enabled         boolean      NOT NULL DEFAULT false,
  expiry_after_days      integer      CHECK (expiry_after_days IS NULL OR expiry_after_days > 0),
  maximum_balance        numeric(6,2) CHECK (maximum_balance IS NULL OR maximum_balance > 0),
  effective_from         date         NOT NULL,
  effective_to           date,
  is_active              boolean      NOT NULL DEFAULT true,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (NOT expiry_enabled OR expiry_after_days IS NOT NULL),
  CONSTRAINT ex_leave_comp_off_one_active EXCLUDE USING gist (
    tenant_id     WITH =,
    leave_type_id WITH =,
    daterange(effective_from, effective_to, '[]') WITH &&
  ) WHERE (is_active)
);
CREATE TRIGGER trg_leave_comp_off_rules_updated BEFORE UPDATE ON leave_comp_off_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_types', 'leave_policies', 'leave_policy_entitlements', 'leave_policy_assignments',
    'leave_holiday_calendars', 'leave_holidays', 'leave_calendar_assignments',
    'leave_accrual_rules', 'leave_carry_forward_rules', 'leave_comp_off_rules'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants ----
-- Leave types and rules are deactivated/archived, never deleted (see the service).
GRANT SELECT, INSERT, UPDATE ON
  leave_types, leave_policies, leave_policy_assignments, leave_holiday_calendars,
  leave_calendar_assignments, leave_accrual_rules, leave_carry_forward_rules, leave_comp_off_rules
TO hrms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_policy_entitlements, leave_holidays TO hrms_app;
-- Only FUTURE effective-dated assignments are ever deleted (enforced in the service).
GRANT DELETE ON leave_policy_assignments, leave_calendar_assignments TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

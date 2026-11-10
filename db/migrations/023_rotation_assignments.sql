-- =============================================================================
-- 023 — Rotating shift and rotating work type assignments
--   * HR assigns a rotation pattern to an employee from a start date. Only the
--     assignment (employee, pattern, dates) is stored. The current entry, the
--     next switch and the next entry are COMPUTED from the start date and the
--     pattern (resolveRotation), so there is no job that can fall behind.
--   * One rotation of each kind per employee at a time: a GiST exclusion over
--     (employee, date range), ignoring cancelled rows.
--   * An assignment is "live" while it is not cancelled and its end date is
--     empty or not yet past (in the tenant's timezone). A pattern with live
--     assignments is frozen: it cannot be deactivated, and its interval, unit
--     and entries cannot change, even through direct SQL, because that would
--     silently change everyone's current shift and rewrite their history.
--   * Nothing is deleted: End sets an end date, Cancel is for assignments that
--     have not started. hrms_app gets no DELETE grant.
-- =============================================================================

-- Tenant-local "today" for a given tenant. Unlike tenant_today() it does not
-- depend on the session's tenant setting, so triggers also work for the owner.
CREATE FUNCTION ws_tenant_today(p_tenant bigint) RETURNS date
LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE t.timezone)::date FROM tenants t WHERE t.id = p_tenant
$$;

-- ------------------------------------------------- audit log: wider vocabulary --
ALTER TABLE work_schedule_audit_log DROP CONSTRAINT work_schedule_audit_log_action_check;
ALTER TABLE work_schedule_audit_log ADD CONSTRAINT work_schedule_audit_log_action_check
  CHECK (action IN ('created', 'updated', 'activated', 'deactivated', 'ended', 'cancelled'));
ALTER TABLE work_schedule_audit_log DROP CONSTRAINT work_schedule_audit_log_entity_type_check;
ALTER TABLE work_schedule_audit_log ADD CONSTRAINT work_schedule_audit_log_entity_type_check
  CHECK (entity_type IN (
    'employee_type', 'shift', 'work_type', 'rotating_shift', 'rotating_work_type', 'shift_schedule',
    'rotating_shift_assignment', 'rotating_work_type_assignment'));

-- ------------------------------------------------------------------ tables ----
CREATE TABLE rotating_shift_assignments (
  tenant_id    bigint      NOT NULL REFERENCES tenants(id),
  id           bigint GENERATED ALWAYS AS IDENTITY,
  employee_id  bigint      NOT NULL,
  pattern_id   bigint      NOT NULL,
  start_date   date        NOT NULL,
  end_date     date,
  -- How the rotation repeats: every N days, on a weekday (1 = Monday), or on a day of the month.
  based_on          varchar(10) NOT NULL CHECK (based_on IN ('after', 'weekly', 'monthly')),
  rotate_after_days smallint,
  rotate_weekday    smallint,
  rotate_month_day  smallint,
  rotate_last_day   boolean NOT NULL DEFAULT false,
  CHECK (
    (based_on = 'after'   AND rotate_after_days BETWEEN 1 AND 365
       AND rotate_weekday IS NULL AND rotate_month_day IS NULL AND NOT rotate_last_day)
 OR (based_on = 'weekly'  AND rotate_weekday BETWEEN 1 AND 7
       AND rotate_after_days IS NULL AND rotate_month_day IS NULL AND NOT rotate_last_day)
 OR (based_on = 'monthly' AND rotate_after_days IS NULL AND rotate_weekday IS NULL
       AND ((rotate_last_day AND rotate_month_day IS NULL)
         OR (NOT rotate_last_day AND rotate_month_day BETWEEN 1 AND 31)))
  ),
  status       varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  reason       text,
  assigned_by  bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, pattern_id)  REFERENCES rotating_shift_patterns(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT ex_rotating_shift_assignment_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX idx_rotating_shift_assign_pattern  ON rotating_shift_assignments (tenant_id, pattern_id);
CREATE INDEX idx_rotating_shift_assign_employee ON rotating_shift_assignments (tenant_id, employee_id, start_date DESC);
CREATE TRIGGER trg_rotating_shift_assign_updated BEFORE UPDATE ON rotating_shift_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rotating_work_type_assignments (
  tenant_id    bigint      NOT NULL REFERENCES tenants(id),
  id           bigint GENERATED ALWAYS AS IDENTITY,
  employee_id  bigint      NOT NULL,
  pattern_id   bigint      NOT NULL,
  start_date   date        NOT NULL,
  end_date     date,
  -- How the rotation repeats: every N days, on a weekday (1 = Monday), or on a day of the month.
  based_on          varchar(10) NOT NULL CHECK (based_on IN ('after', 'weekly', 'monthly')),
  rotate_after_days smallint,
  rotate_weekday    smallint,
  rotate_month_day  smallint,
  rotate_last_day   boolean NOT NULL DEFAULT false,
  CHECK (
    (based_on = 'after'   AND rotate_after_days BETWEEN 1 AND 365
       AND rotate_weekday IS NULL AND rotate_month_day IS NULL AND NOT rotate_last_day)
 OR (based_on = 'weekly'  AND rotate_weekday BETWEEN 1 AND 7
       AND rotate_after_days IS NULL AND rotate_month_day IS NULL AND NOT rotate_last_day)
 OR (based_on = 'monthly' AND rotate_after_days IS NULL AND rotate_weekday IS NULL
       AND ((rotate_last_day AND rotate_month_day IS NULL)
         OR (NOT rotate_last_day AND rotate_month_day BETWEEN 1 AND 31)))
  ),
  status       varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'cancelled')),
  reason       text,
  assigned_by  bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, pattern_id)  REFERENCES rotating_work_type_patterns(tenant_id, id),
  FOREIGN KEY (tenant_id, assigned_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT ex_rotating_work_type_assignment_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status <> 'cancelled')
);
CREATE INDEX idx_rotating_work_type_assign_pattern  ON rotating_work_type_assignments (tenant_id, pattern_id);
CREATE INDEX idx_rotating_work_type_assign_employee ON rotating_work_type_assignments (tenant_id, employee_id, start_date DESC);
CREATE TRIGGER trg_rotating_work_type_assign_updated BEFORE UPDATE ON rotating_work_type_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -------------------------------------------------- assignment -> pattern guard --
-- A live assignment may not point at a deactivated pattern. FOR SHARE makes a
-- concurrent deactivation of that pattern wait for this transaction.
CREATE FUNCTION ws_guard_assignment_pattern() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_active boolean;
  v_name   text;
BEGIN
  IF NEW.status = 'cancelled' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.pattern_id = OLD.pattern_id AND OLD.status = NEW.status THEN RETURN NEW; END IF;
  EXECUTE format('SELECT is_active, name FROM %I WHERE tenant_id = $1 AND id = $2 FOR SHARE', TG_ARGV[0])
    INTO v_active, v_name USING NEW.tenant_id, NEW.pattern_id;
  IF NOT v_active THEN
    RAISE EXCEPTION 'Pattern "%" is deactivated and cannot be assigned', v_name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_shift_assign_pattern BEFORE INSERT OR UPDATE ON rotating_shift_assignments
  FOR EACH ROW EXECUTE FUNCTION ws_guard_assignment_pattern('rotating_shift_patterns');
CREATE TRIGGER trg_rotating_work_type_assign_pattern BEFORE INSERT OR UPDATE ON rotating_work_type_assignments
  FOR EACH ROW EXECUTE FUNCTION ws_guard_assignment_pattern('rotating_work_type_patterns');

-- ------------------------------------------------------- pattern freeze guards --
-- Deactivation of a pattern with live assignments (the rotation rule lives on the assignment).
-- Takes the row lock the UPDATE already holds, then counts: an assignment
-- being inserted concurrently holds FOR SHARE on this row and so serializes.
CREATE FUNCTION ws_guard_pattern_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_live integer;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE tenant_id = $1 AND pattern_id = $2 AND status <> ''cancelled''
         AND (end_date IS NULL OR end_date >= ws_tenant_today($1))', TG_ARGV[0])
      INTO v_live USING NEW.tenant_id, NEW.id;
    IF v_live > 0 THEN
      RAISE EXCEPTION 'Pattern is used by % live assignment(s); it cannot be deactivated', v_live
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_shift_pattern_freeze BEFORE UPDATE ON rotating_shift_patterns
  FOR EACH ROW EXECUTE FUNCTION ws_guard_pattern_freeze('rotating_shift_assignments');
CREATE TRIGGER trg_rotating_work_type_pattern_freeze BEFORE UPDATE ON rotating_work_type_patterns
  FOR EACH ROW EXECUTE FUNCTION ws_guard_pattern_freeze('rotating_work_type_assignments');

-- Entries (insert, update, delete) of a pattern with live assignments.
CREATE FUNCTION ws_guard_pattern_items_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant  bigint;
  v_pattern bigint;
  v_live    integer;
BEGIN
  v_tenant  := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id  ELSE NEW.tenant_id  END;
  v_pattern := CASE WHEN TG_OP = 'DELETE' THEN OLD.pattern_id ELSE NEW.pattern_id END;
  -- Serialize with a concurrent assignment insert (which holds FOR SHARE on the pattern).
  EXECUTE format('SELECT 1 FROM %I WHERE tenant_id = $1 AND id = $2 FOR UPDATE', TG_ARGV[0]) USING v_tenant, v_pattern;
  EXECUTE format(
    'SELECT count(*) FROM %I WHERE tenant_id = $1 AND pattern_id = $2 AND status <> ''cancelled''
       AND (end_date IS NULL OR end_date >= ws_tenant_today($1))', TG_ARGV[1])
    INTO v_live USING v_tenant, v_pattern;
  IF v_live > 0 THEN
    RAISE EXCEPTION 'Pattern is used by % live assignment(s); its entries cannot change', v_live
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER trg_rotating_shift_items_freeze BEFORE INSERT OR UPDATE OR DELETE ON rotating_shift_pattern_items
  FOR EACH ROW EXECUTE FUNCTION ws_guard_pattern_items_freeze('rotating_shift_patterns', 'rotating_shift_assignments');
CREATE TRIGGER trg_rotating_work_type_items_freeze BEFORE INSERT OR UPDATE OR DELETE ON rotating_work_type_pattern_items
  FOR EACH ROW EXECUTE FUNCTION ws_guard_pattern_items_freeze('rotating_work_type_patterns', 'rotating_work_type_assignments');

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rotating_shift_assignments', 'rotating_work_type_assignments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants ----
GRANT SELECT, INSERT, UPDATE ON rotating_shift_assignments, rotating_work_type_assignments TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

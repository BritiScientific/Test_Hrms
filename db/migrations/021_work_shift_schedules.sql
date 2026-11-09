-- =============================================================================
-- 021 — Work Schedule Configuration: shift schedules
--   * A schedule attaches a weekly timetable to one shift: exactly seven day
--     rows, ISO weekday 1 = Monday .. 7 = Sunday.
--   * Times are wall-clock in the tenant's timezone (tenants.timezone). No UTC
--     conversion is stored, because a schedule is a template, not an event.
--   * end_time <= start_time means the shift runs past midnight; is_night_shift
--     is derived by trigger so the flag can never disagree with the times.
--   * automatic_checkout_enabled is stored only. No job reads it in this
--     release; attendance is out of scope.
--   * The last section holds the deactivation guards that need every dependent
--     table to exist: a shift used by an active schedule or rotation, and an
--     employee type still held by a current employee, cannot be deactivated.
-- =============================================================================

CREATE TABLE work_shift_schedules (
  tenant_id                        bigint       NOT NULL REFERENCES tenants(id),
  id                               bigint GENERATED ALWAYS AS IDENTITY,
  shift_id                         bigint       NOT NULL,
  name                             varchar(150) NOT NULL,
  description                      text,
  default_minimum_working_minutes  integer      NOT NULL DEFAULT 0
                                   CHECK (default_minimum_working_minutes BETWEEN 0 AND 1440),
  automatic_checkout_enabled       boolean      NOT NULL DEFAULT false,
  is_active                        boolean      NOT NULL DEFAULT true,
  created_by                       bigint,
  updated_by                       bigint,
  created_at                       timestamptz  NOT NULL DEFAULT now(),
  updated_at                       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, shift_id)   REFERENCES work_shifts(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_work_shift_schedules_name ON work_shift_schedules (tenant_id, lower(name));
CREATE INDEX idx_work_shift_schedules_shift ON work_shift_schedules (tenant_id, shift_id);
CREATE TRIGGER trg_work_shift_schedules_updated BEFORE UPDATE ON work_shift_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_shift_schedule_days (
  tenant_id                bigint      NOT NULL,
  id                       bigint GENERATED ALWAYS AS IDENTITY,
  schedule_id              bigint      NOT NULL,
  day_of_week              smallint    NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),  -- ISO: 1 = Monday
  is_working_day           boolean     NOT NULL DEFAULT true,
  start_time               time,
  end_time                 time,
  minimum_working_minutes  integer     NOT NULL DEFAULT 0
                           CHECK (minimum_working_minutes BETWEEN 0 AND 1440),
  is_night_shift           boolean     NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, schedule_id, day_of_week),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES work_shift_schedules(tenant_id, id) ON DELETE CASCADE,
  -- A working day needs both times; a day off carries no times and no minimum.
  CONSTRAINT ck_schedule_day_times CHECK (
    (is_working_day AND start_time IS NOT NULL AND end_time IS NOT NULL)
    OR (NOT is_working_day AND start_time IS NULL AND end_time IS NULL AND minimum_working_minutes = 0)
  ),
  -- Equal start and end would be a zero-length (or 24h) day: always a mistake.
  CONSTRAINT ck_schedule_day_span CHECK (NOT is_working_day OR start_time <> end_time)
);
CREATE INDEX idx_work_shift_schedule_days_schedule ON work_shift_schedule_days (tenant_id, schedule_id);
CREATE TRIGGER trg_work_shift_schedule_days_updated BEFORE UPDATE ON work_shift_schedule_days
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- is_night_shift is derived, never supplied by the application.
CREATE FUNCTION ws_set_night_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.is_night_shift := NEW.is_working_day
                        AND NEW.start_time IS NOT NULL AND NEW.end_time IS NOT NULL
                        AND NEW.end_time <= NEW.start_time;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_schedule_day_night_shift
  BEFORE INSERT OR UPDATE ON work_shift_schedule_days
  FOR EACH ROW EXECUTE FUNCTION ws_set_night_shift();

-- An active schedule may not hang off a deactivated shift.
CREATE FUNCTION ws_guard_schedule_shift() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_shift_active boolean;
  v_shift_name   text;
BEGIN
  IF NEW.is_active THEN
    -- FOR SHARE: a concurrent deactivation of this shift must wait for us.
    SELECT is_active, name INTO v_shift_active, v_shift_name FROM work_shifts
     WHERE tenant_id = NEW.tenant_id AND id = NEW.shift_id FOR SHARE;
    IF NOT v_shift_active THEN
      RAISE EXCEPTION 'Shift "%" is deactivated and cannot carry an active schedule', v_shift_name
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_schedule_shift_reference
  BEFORE INSERT OR UPDATE ON work_shift_schedules
  FOR EACH ROW EXECUTE FUNCTION ws_guard_schedule_shift();

-- ------------------------------------------------- cross-table deactivation --
-- A shift in use by an active schedule or an active rotation stays active.
-- The dependent rows are locked before the check, so a concurrent
-- "create a schedule on this shift" cannot commit alongside a deactivation.
CREATE FUNCTION ws_guard_shift_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_blocker text;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    PERFORM 1 FROM work_shift_schedules s
      WHERE s.tenant_id = NEW.tenant_id AND s.shift_id = NEW.id FOR UPDATE;
    PERFORM 1 FROM rotating_shift_pattern_items i
      JOIN rotating_shift_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
     WHERE i.tenant_id = NEW.tenant_id AND i.shift_id = NEW.id
       FOR UPDATE OF p;

    SELECT s.name INTO v_blocker FROM work_shift_schedules s
     WHERE s.tenant_id = NEW.tenant_id AND s.shift_id = NEW.id AND s.is_active LIMIT 1;
    IF v_blocker IS NOT NULL THEN
      RAISE EXCEPTION 'Shift is used by active shift schedule "%"', v_blocker
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT p.name INTO v_blocker
      FROM rotating_shift_pattern_items i
      JOIN rotating_shift_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
     WHERE i.tenant_id = NEW.tenant_id AND i.shift_id = NEW.id AND p.is_active LIMIT 1;
    IF v_blocker IS NOT NULL THEN
      RAISE EXCEPTION 'Shift is used by active rotating shift "%"', v_blocker
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_work_shift_deactivate BEFORE UPDATE ON work_shifts
  FOR EACH ROW EXECUTE FUNCTION ws_guard_shift_deactivate();

-- An employee type still held by a current (non-exited) employee stays active.
CREATE FUNCTION ws_guard_employee_type_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_count integer;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    PERFORM 1 FROM employees e
      WHERE e.tenant_id = NEW.tenant_id AND e.employee_type_id = NEW.id FOR UPDATE;
    SELECT count(*) INTO v_count FROM employees e
     WHERE e.tenant_id = NEW.tenant_id AND e.employee_type_id = NEW.id AND e.status <> 'exited';
    IF v_count > 0 THEN
      RAISE EXCEPTION 'Employee type is used by % active employee(s)', v_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_employee_type_deactivate BEFORE UPDATE ON employee_types
  FOR EACH ROW EXECUTE FUNCTION ws_guard_employee_type_deactivate();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_shift_schedules', 'work_shift_schedule_days'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants ----
GRANT SELECT, INSERT, UPDATE ON work_shift_schedules TO hrms_app;
-- Saving a schedule rewrites its seven day rows in one transaction.
GRANT SELECT, INSERT, UPDATE, DELETE ON work_shift_schedule_days TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

-- =============================================================================
-- 020 — Work Schedule Configuration: rotating shifts and rotating work types
--   * Two identical shapes: a pattern plus its ordered items. The shift version
--     references work_shifts, the work-type version references work_types.
--   * A pattern is a fixed sequence of at least 2 distinct entries. The "at
--     least 2" rule is enforced in the service (a pattern and its items are
--     written in one transaction, so a row-level CHECK cannot see the count);
--     "distinct" and "ordered" are enforced here by unique constraints.
--   * Items are the one part of this module that IS deleted: editing a pattern
--     replaces its items wholesale inside a single transaction, so hrms_app
--     gets DELETE on the item tables only. The patterns themselves are
--     deactivated, never removed.
--   * Integrity triggers close the gap that the API alone cannot: an active
--     pattern may never reference an inactive shift or work type, and a work
--     type with active dependents cannot be deactivated, even through direct
--     SQL. The deactivation guard takes a row lock first, so a concurrent
--     "create a pattern using this work type" cannot slip past the check.
-- =============================================================================

-- ------------------------------------------------------- rotating shifts ----
CREATE TABLE rotating_shift_patterns (
  tenant_id          bigint       NOT NULL REFERENCES tenants(id),
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  name               varchar(150) NOT NULL,
  description        text,
  rotation_interval  integer      NOT NULL DEFAULT 1 CHECK (rotation_interval BETWEEN 1 AND 365),
  rotation_unit      varchar(20)  NOT NULL DEFAULT 'days' CHECK (rotation_unit IN ('days', 'weeks')),
  is_active          boolean      NOT NULL DEFAULT true,
  created_by         bigint,
  updated_by         bigint,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_rotating_shift_patterns_name ON rotating_shift_patterns (tenant_id, lower(name));
CREATE INDEX idx_rotating_shift_patterns_active ON rotating_shift_patterns (tenant_id, is_active);
CREATE TRIGGER trg_rotating_shift_patterns_updated BEFORE UPDATE ON rotating_shift_patterns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rotating_shift_pattern_items (
  tenant_id       bigint      NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  pattern_id      bigint      NOT NULL,
  shift_id        bigint      NOT NULL,
  sequence_order  integer     NOT NULL CHECK (sequence_order >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, pattern_id, sequence_order),
  UNIQUE (tenant_id, pattern_id, shift_id),
  FOREIGN KEY (tenant_id, pattern_id) REFERENCES rotating_shift_patterns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, shift_id)   REFERENCES work_shifts(tenant_id, id)
);
CREATE INDEX idx_rotating_shift_items_shift ON rotating_shift_pattern_items (tenant_id, shift_id);

-- --------------------------------------------------- rotating work types ----
CREATE TABLE rotating_work_type_patterns (
  tenant_id          bigint       NOT NULL REFERENCES tenants(id),
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  name               varchar(150) NOT NULL,
  description        text,
  rotation_interval  integer      NOT NULL DEFAULT 1 CHECK (rotation_interval BETWEEN 1 AND 365),
  rotation_unit      varchar(20)  NOT NULL DEFAULT 'days' CHECK (rotation_unit IN ('days', 'weeks')),
  is_active          boolean      NOT NULL DEFAULT true,
  created_by         bigint,
  updated_by         bigint,
  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_rotating_work_type_patterns_name ON rotating_work_type_patterns (tenant_id, lower(name));
CREATE INDEX idx_rotating_work_type_patterns_active ON rotating_work_type_patterns (tenant_id, is_active);
CREATE TRIGGER trg_rotating_work_type_patterns_updated BEFORE UPDATE ON rotating_work_type_patterns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rotating_work_type_pattern_items (
  tenant_id       bigint      NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  pattern_id      bigint      NOT NULL,
  work_type_id    bigint      NOT NULL,
  sequence_order  integer     NOT NULL CHECK (sequence_order >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, pattern_id, sequence_order),
  UNIQUE (tenant_id, pattern_id, work_type_id),
  FOREIGN KEY (tenant_id, pattern_id)   REFERENCES rotating_work_type_patterns(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, work_type_id) REFERENCES work_types(tenant_id, id)
);
CREATE INDEX idx_rotating_work_type_items_type ON rotating_work_type_pattern_items (tenant_id, work_type_id);

-- ---------------------------------------------- reference integrity guards ---
-- An active pattern may not point at a deactivated shift.
CREATE FUNCTION ws_guard_rotating_shift_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pattern_active boolean;
  v_shift_active   boolean;
  v_shift_name     text;
BEGIN
  SELECT is_active INTO v_pattern_active FROM rotating_shift_patterns
   WHERE tenant_id = NEW.tenant_id AND id = NEW.pattern_id;
  -- FOR SHARE: a concurrent deactivation of this shift must wait for us.
  SELECT is_active, name INTO v_shift_active, v_shift_name FROM work_shifts
   WHERE tenant_id = NEW.tenant_id AND id = NEW.shift_id FOR SHARE;
  IF v_pattern_active AND NOT v_shift_active THEN
    RAISE EXCEPTION 'Shift "%" is deactivated and cannot be used in an active rotating shift', v_shift_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_shift_item_reference
  BEFORE INSERT OR UPDATE ON rotating_shift_pattern_items
  FOR EACH ROW EXECUTE FUNCTION ws_guard_rotating_shift_item();

CREATE FUNCTION ws_guard_rotating_work_type_item() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_pattern_active   boolean;
  v_work_type_active boolean;
  v_work_type_name   text;
BEGIN
  SELECT is_active INTO v_pattern_active FROM rotating_work_type_patterns
   WHERE tenant_id = NEW.tenant_id AND id = NEW.pattern_id;
  SELECT is_active, name INTO v_work_type_active, v_work_type_name FROM work_types
   WHERE tenant_id = NEW.tenant_id AND id = NEW.work_type_id FOR SHARE;
  IF v_pattern_active AND NOT v_work_type_active THEN
    RAISE EXCEPTION 'Work type "%" is deactivated and cannot be used in an active rotating work type', v_work_type_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_work_type_item_reference
  BEFORE INSERT OR UPDATE ON rotating_work_type_pattern_items
  FOR EACH ROW EXECUTE FUNCTION ws_guard_rotating_work_type_item();

-- Reactivating a pattern re-checks every item it holds.
CREATE FUNCTION ws_guard_rotating_shift_pattern() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_bad text;
BEGIN
  IF NEW.is_active AND NOT OLD.is_active THEN
    PERFORM 1 FROM rotating_shift_pattern_items i
      JOIN work_shifts s ON s.tenant_id = i.tenant_id AND s.id = i.shift_id
     WHERE i.tenant_id = NEW.tenant_id AND i.pattern_id = NEW.id
       FOR SHARE OF s;
    SELECT s.name INTO v_bad
      FROM rotating_shift_pattern_items i
      JOIN work_shifts s ON s.tenant_id = i.tenant_id AND s.id = i.shift_id
     WHERE i.tenant_id = NEW.tenant_id AND i.pattern_id = NEW.id AND NOT s.is_active
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot activate: shift "%" in this rotation is deactivated', v_bad
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_shift_pattern_activate BEFORE UPDATE ON rotating_shift_patterns
  FOR EACH ROW EXECUTE FUNCTION ws_guard_rotating_shift_pattern();

CREATE FUNCTION ws_guard_rotating_work_type_pattern() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_bad text;
BEGIN
  IF NEW.is_active AND NOT OLD.is_active THEN
    PERFORM 1 FROM rotating_work_type_pattern_items i
      JOIN work_types w ON w.tenant_id = i.tenant_id AND w.id = i.work_type_id
     WHERE i.tenant_id = NEW.tenant_id AND i.pattern_id = NEW.id
       FOR SHARE OF w;
    SELECT w.name INTO v_bad
      FROM rotating_work_type_pattern_items i
      JOIN work_types w ON w.tenant_id = i.tenant_id AND w.id = i.work_type_id
     WHERE i.tenant_id = NEW.tenant_id AND i.pattern_id = NEW.id AND NOT w.is_active
     LIMIT 1;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot activate: work type "%" in this rotation is deactivated', v_bad
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_rotating_work_type_pattern_activate BEFORE UPDATE ON rotating_work_type_patterns
  FOR EACH ROW EXECUTE FUNCTION ws_guard_rotating_work_type_pattern();

-- A work type still used by an active rotation cannot be deactivated.
-- Locking the dependent rows first closes the race with a concurrent insert.
CREATE FUNCTION ws_guard_work_type_deactivate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_blocker text;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    PERFORM 1 FROM rotating_work_type_pattern_items i
      JOIN rotating_work_type_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
     WHERE i.tenant_id = NEW.tenant_id AND i.work_type_id = NEW.id
       FOR UPDATE OF p;
    SELECT p.name INTO v_blocker
      FROM rotating_work_type_pattern_items i
      JOIN rotating_work_type_patterns p ON p.tenant_id = i.tenant_id AND p.id = i.pattern_id
     WHERE i.tenant_id = NEW.tenant_id AND i.work_type_id = NEW.id AND p.is_active
     LIMIT 1;
    IF v_blocker IS NOT NULL THEN
      RAISE EXCEPTION 'Work type is used by active rotating work type "%"', v_blocker
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_work_type_deactivate BEFORE UPDATE ON work_types
  FOR EACH ROW EXECUTE FUNCTION ws_guard_work_type_deactivate();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rotating_shift_patterns', 'rotating_shift_pattern_items',
    'rotating_work_type_patterns', 'rotating_work_type_pattern_items'
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
GRANT SELECT, INSERT, UPDATE ON rotating_shift_patterns, rotating_work_type_patterns TO hrms_app;
-- Editing a pattern replaces its items in one transaction, so the item tables
-- (and only those) need DELETE.
GRANT SELECT, INSERT, UPDATE, DELETE ON rotating_shift_pattern_items, rotating_work_type_pattern_items TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

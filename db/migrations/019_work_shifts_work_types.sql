-- =============================================================================
-- 019 — Work Schedule Configuration: shifts and work types
--   * Two plain tenant masters. Names are unique per tenant, case-insensitively
--     ("Night Shift" and "night shift" collide inside one tenant, never across).
--   * Grace time is the lateness allowance in minutes, capped at 4 hours.
--   * Deactivated, never deleted: hrms_app gets no DELETE grant.
-- =============================================================================

CREATE TABLE work_shifts (
  tenant_id           bigint       NOT NULL REFERENCES tenants(id),
  id                  bigint GENERATED ALWAYS AS IDENTITY,
  name                varchar(150) NOT NULL,
  description         text,
  grace_time_minutes  integer      NOT NULL DEFAULT 0
                      CHECK (grace_time_minutes BETWEEN 0 AND 240),
  is_active           boolean      NOT NULL DEFAULT true,
  created_by          bigint,
  updated_by          bigint,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_work_shifts_name ON work_shifts (tenant_id, lower(name));
CREATE INDEX idx_work_shifts_active ON work_shifts (tenant_id, is_active);
CREATE TRIGGER trg_work_shifts_updated BEFORE UPDATE ON work_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_types (
  tenant_id    bigint       NOT NULL REFERENCES tenants(id),
  id           bigint GENERATED ALWAYS AS IDENTITY,
  name         varchar(150) NOT NULL,
  description  text,
  is_active    boolean      NOT NULL DEFAULT true,
  created_by   bigint,
  updated_by   bigint,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_work_types_name ON work_types (tenant_id, lower(name));
CREATE INDEX idx_work_types_active ON work_types (tenant_id, is_active);
CREATE TRIGGER trg_work_types_updated BEFORE UPDATE ON work_types
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_shifts', 'work_types'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------- grants ----
GRANT SELECT, INSERT, UPDATE ON work_shifts, work_types TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

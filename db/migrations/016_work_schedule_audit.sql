-- =============================================================================
-- 016 — Work Schedule Configuration: audit log
--   * One row per create, update and status change of any work schedule
--     configuration record, written in the same transaction as the change.
--   * Created first so every later work schedule migration (employee types,
--     shifts, work types, rotations, schedules) can rely on it.
--   * Append-only: the API role gets SELECT and INSERT only, and a trigger
--     rejects UPDATE/DELETE even for the owner.
-- =============================================================================

CREATE TABLE work_schedule_audit_log (
  tenant_id      bigint       NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint       NOT NULL,
  action         varchar(20)  NOT NULL CHECK (action IN ('created', 'updated', 'activated', 'deactivated')),
  entity_type    varchar(40)  NOT NULL CHECK (entity_type IN (
                   'employee_type', 'shift', 'work_type', 'rotating_shift', 'rotating_work_type', 'shift_schedule')),
  entity_id      bigint       NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_ws_audit_at ON work_schedule_audit_log (tenant_id, created_at DESC);
CREATE INDEX idx_ws_audit_entity ON work_schedule_audit_log (tenant_id, entity_type, entity_id);
CREATE TRIGGER trg_ws_audit_append_only
  BEFORE UPDATE OR DELETE ON work_schedule_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

ALTER TABLE work_schedule_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_schedule_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON work_schedule_audit_log
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON work_schedule_audit_log TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

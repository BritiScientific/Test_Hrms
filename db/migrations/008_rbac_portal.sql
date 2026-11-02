-- =============================================================================
-- 008 — RBAC management portal (Milestone 4)
--   * Roles can be re-activated (deactivation stays the delete semantics, so
--     history and references are preserved); that change is audited too.
--   * Indexes for the portal's member counts and audit timeline.
-- =============================================================================

ALTER TABLE rbac_audit_log DROP CONSTRAINT rbac_audit_log_action_check;
ALTER TABLE rbac_audit_log ADD CONSTRAINT rbac_audit_log_action_check CHECK (action IN (
  'role.create', 'role.update', 'role.deactivate', 'role.activate',
  'role.permissions.set', 'user_role.assign', 'user_role.revoke'));

CREATE INDEX IF NOT EXISTS idx_rbac_audit_actor ON rbac_audit_log (tenant_id, actor_user_id, at DESC);

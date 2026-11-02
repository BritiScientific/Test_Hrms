-- =============================================================================
-- 006 — Server-side sessions (Milestone 1)
--   * Every login creates an auth_sessions row; the access JWT carries its id
--     (`sid`). authenticate() rejects a token whose session is revoked or past
--     its absolute lifetime, so logout and "sign out everywhere" really work
--     for both cookie (browser) and bearer (Postman/tests) clients.
--   * The idle timeout is the access-token TTL: the browser cookie is re-issued
--     (sliding) while the user is active, capped by absolute_expires_at.
--   * Tenant-scoped + RLS like every other tenant table: a session can only be
--     read inside the tenant it was issued for.
-- =============================================================================

CREATE TABLE auth_sessions (
  tenant_id            bigint      NOT NULL REFERENCES tenants(id),
  id                   uuid        NOT NULL,
  user_id              bigint      NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoked_reason       varchar(30) CHECK (revoked_reason IN ('logout', 'switch_tenant', 'admin')),
  user_agent           varchar(300),
  ip                   inet,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (absolute_expires_at > created_at)
);
CREATE INDEX idx_auth_sessions_user ON auth_sessions (tenant_id, user_id) WHERE revoked_at IS NULL;

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON auth_sessions
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT ON auth_sessions TO hrms_app;
GRANT UPDATE (last_seen_at, revoked_at, revoked_reason) ON auth_sessions TO hrms_app;

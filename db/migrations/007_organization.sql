-- =============================================================================
-- 007 — Organization onboarding, profile and settings (Milestone 2)
--   * tenants gains profile columns. `name` stays the display name (used by
--     login and everywhere else); `legal_name` is new. `slug` is a stable,
--     unique, URL-safe reference that the API never changes.
--   * tenant_settings: regional preferences. Timezone and weekly offs stay on
--     tenants because tenant_today() and leave-day maths already read them.
--   * tenant_assets: the logo lives in Postgres (bytea, 512 KB cap) behind a
--     storage interface in the API, so S3 can replace it without schema churn.
--     No file-system paths are ever stored.
--   * organization_invitations: one-time activation tokens. Only a SHA-256
--     hash is stored; tokens expire, are single-use and are consumed under a
--     row lock so a replay or a concurrent double-submit cannot succeed.
--   * organization_audit_log: append-only record of every organization write.
--   * Provisioning is NOT exposed to the API role: tenants are created by the
--     platform CLI (scripts/tenant-cli.ts) running as hrms_owner. The API only
--     gets two narrow SECURITY DEFINER functions to look up / accept an
--     invitation by token hash.
-- =============================================================================

-- ------------------------------------------------------- tenant profile ----
ALTER TABLE tenants
  ADD COLUMN legal_name               varchar(200),
  ADD COLUMN slug                     citext,
  ADD COLUMN industry                 varchar(100),
  ADD COLUMN website                  varchar(300),
  ADD COLUMN contact_email            citext,
  ADD COLUMN contact_phone            varchar(40),
  ADD COLUMN contact_person           varchar(200),
  ADD COLUMN registration_number      varchar(100),
  ADD COLUMN address_line1            varchar(200),
  ADD COLUMN address_line2            varchar(200),
  ADD COLUMN city                     varchar(100),
  ADD COLUMN state_province           varchar(100),
  ADD COLUMN postal_code              varchar(20),
  ADD COLUMN country_code             char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN onboarding_completed_at  timestamptz,
  ADD COLUMN updated_at               timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN version                  integer     NOT NULL DEFAULT 1;

-- Backfill slugs for tenants that existed before this migration.
UPDATE tenants
   SET slug = left(trim(both '-' FROM regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 40) || '-' || id
 WHERE slug IS NULL;

ALTER TABLE tenants
  ALTER COLUMN slug SET NOT NULL,
  ADD CONSTRAINT uq_tenants_slug UNIQUE (slug),
  ADD CONSTRAINT ck_tenants_slug CHECK (
    slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 3 AND 50);

CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------ tenant_settings ----
CREATE TABLE tenant_settings (
  tenant_id                   bigint      PRIMARY KEY REFERENCES tenants(id),
  locale                      varchar(35) NOT NULL DEFAULT 'en-IN',
  date_format                 varchar(20) NOT NULL DEFAULT 'DD/MM/YYYY'
                              CHECK (date_format IN ('DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY')),
  currency                    char(3)     NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  financial_year_start_month  smallint    NOT NULL DEFAULT 4 CHECK (financial_year_start_month BETWEEN 1 AND 12),
  week_start_day              smallint    NOT NULL DEFAULT 1 CHECK (week_start_day BETWEEN 0 AND 6),
  confirmed_at                timestamptz,              -- first explicit save (onboarding checklist)
  version                     integer     NOT NULL DEFAULT 1,
  updated_by                  bigint,
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE TRIGGER trg_tenant_settings_updated BEFORE UPDATE ON tenant_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO tenant_settings (tenant_id) SELECT id FROM tenants ON CONFLICT DO NOTHING;

-- -------------------------------------------------------- tenant_assets ----
CREATE TABLE tenant_assets (
  tenant_id     bigint      NOT NULL REFERENCES tenants(id),
  kind          varchar(20) NOT NULL CHECK (kind IN ('logo')),
  content_type  varchar(50) NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
  byte_size     integer     NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
  sha256        char(64)    NOT NULL,
  data          bytea       NOT NULL,
  updated_by    bigint,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, kind),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (octet_length(data) = byte_size)
);

-- --------------------------------------------- organization_invitations ----
CREATE TABLE organization_invitations (
  tenant_id         bigint       NOT NULL REFERENCES tenants(id),
  id                bigint GENERATED ALWAYS AS IDENTITY,
  email             citext       NOT NULL,
  full_name         varchar(200) NOT NULL,
  role_id           bigint       NOT NULL,   -- the controlled bootstrap role
  token_hash        bytea        NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  expires_at        timestamptz  NOT NULL,
  accepted_at       timestamptz,
  accepted_user_id  bigint       REFERENCES users(id),
  revoked_at        timestamptz,
  invited_by        bigint,                  -- NULL = platform provisioning (CLI)
  created_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id)    REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (expires_at > created_at),
  CHECK (accepted_at IS NULL OR accepted_user_id IS NOT NULL)
);

-- ----------------------------------------------- organization_audit_log ----
CREATE TABLE organization_audit_log (
  tenant_id      bigint      NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint,                     -- NULL for platform provisioning
  actor_label    varchar(60),
  action         varchar(40) NOT NULL CHECK (action IN (
                   'organization.create', 'organization.update', 'organization.settings.update',
                   'organization.logo.update', 'organization.logo.remove',
                   'organization.onboarding.complete', 'invitation.create', 'invitation.accept')),
  target_type    varchar(30) NOT NULL,
  target_id      bigint,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (actor_user_id IS NOT NULL OR actor_label IS NOT NULL)
);
CREATE INDEX idx_org_audit_at ON organization_audit_log (tenant_id, at DESC);
CREATE INDEX idx_rbac_audit_at ON rbac_audit_log (tenant_id, at DESC);

CREATE TRIGGER trg_org_audit_append_only
  BEFORE UPDATE OR DELETE ON organization_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------------- permissions ----
INSERT INTO permissions (code, module, description) VALUES
  ('organization.view',            'organization', 'View the organization profile'),
  ('organization.update',          'organization', 'Edit the organization profile, logo and onboarding'),
  ('organization.settings.view',   'organization', 'View organization regional preferences'),
  ('organization.settings.update', 'organization', 'Change organization regional preferences')
ON CONFLICT (code) DO NOTHING;

-- Existing Tenant Admin system roles keep "full access".
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r CROSS JOIN permissions p
 WHERE r.is_system_role AND r.name = 'Tenant Admin' AND p.module = 'organization'
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------------ RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_settings', 'tenant_assets', 'organization_invitations', 'organization_audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- --------------------------------------------------------------- grants ----
-- Profile columns only: id, slug, is_active and created_at stay platform-owned.
GRANT UPDATE (name, legal_name, industry, website, contact_email, contact_phone, contact_person,
              registration_number, address_line1, address_line2, city, state_province,
              postal_code, country_code, timezone, weekly_offs, onboarding_completed_at,
              updated_at, version)
  ON tenants TO hrms_app;
GRANT SELECT, INSERT, UPDATE ON tenant_settings TO hrms_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_assets TO hrms_app;
GRANT SELECT, INSERT ON organization_audit_log TO hrms_app;   -- append-only
-- organization_invitations: no direct access for the API role.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

-- ------------------------------------------------------- auth helpers ------
-- Membership list for login / tenant selection now carries the slug and only
-- returns memberships of ACTIVE user accounts.
DROP FUNCTION auth_user_tenants(bigint);
CREATE FUNCTION auth_user_tenants(p_user_id bigint)
RETURNS TABLE (tenant_id bigint, tenant_name varchar, tenant_slug citext)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.slug
  FROM tenant_users tu
  JOIN tenants t ON t.id = tu.tenant_id
  JOIN users u   ON u.id = tu.user_id
  WHERE tu.user_id = p_user_id AND tu.status = 'active' AND t.is_active AND u.is_active
  ORDER BY t.name
$$;
REVOKE ALL ON FUNCTION auth_user_tenants(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_user_tenants(bigint) TO hrms_app;

-- Pre-tenant lookup of a VALID invitation. Every invalid state (unknown,
-- expired, used, revoked, inactive tenant/user) returns no row, so the caller
-- cannot tell them apart.
CREATE FUNCTION onboarding_invitation_lookup(p_token_hash bytea)
RETURNS TABLE (tenant_id bigint, invitation_id bigint, email citext, full_name varchar,
               organization_name varchar, user_exists boolean, user_has_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.email, i.full_name, t.name,
         u.id IS NOT NULL, u.password_hash IS NOT NULL
  FROM organization_invitations i
  JOIN tenants t ON t.id = i.tenant_id AND t.is_active
  LEFT JOIN users u ON u.email = i.email
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    AND (u.id IS NULL OR u.is_active)
$$;

-- Accept an invitation atomically. p_password_hash is:
--   * required when the account is new or has no password yet;
--   * NULL when the account already has a password (the API verified the
--     caller's CURRENT password first). An invitation can never overwrite an
--     existing password — otherwise whoever provisions a tenant could take
--     over an account that belongs to another tenant.
CREATE FUNCTION onboarding_accept_invitation(
  p_token_hash bytea, p_password_hash text, p_full_name varchar, p_request_id text)
RETURNS TABLE (out_tenant_id bigint, out_user_id bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  inv      organization_invitations%ROWTYPE;
  v_user   users%ROWTYPE;
  v_uid    bigint;
  v_today  date;
BEGIN
  SELECT * INTO inv FROM organization_invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT (now() AT TIME ZONE t.timezone)::date INTO v_today
    FROM tenants t WHERE t.id = inv.tenant_id AND t.is_active;
  IF v_today IS NULL THEN
    RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_user FROM users WHERE email = inv.email FOR UPDATE;
  IF FOUND THEN
    IF NOT v_user.is_active THEN
      RAISE EXCEPTION 'INVITATION_INVALID' USING ERRCODE = 'P0001';
    END IF;
    IF v_user.password_hash IS NOT NULL AND p_password_hash IS NOT NULL THEN
      RAISE EXCEPTION 'ACCOUNT_EXISTS' USING ERRCODE = 'P0001';
    END IF;
    IF v_user.password_hash IS NULL THEN
      IF p_password_hash IS NULL THEN
        RAISE EXCEPTION 'PASSWORD_REQUIRED' USING ERRCODE = 'P0001';
      END IF;
      UPDATE users SET password_hash = p_password_hash WHERE id = v_user.id;
    END IF;
    v_uid := v_user.id;
  ELSE
    IF p_password_hash IS NULL THEN
      RAISE EXCEPTION 'PASSWORD_REQUIRED' USING ERRCODE = 'P0001';
    END IF;
    INSERT INTO users (email, full_name, password_hash)
    VALUES (inv.email, COALESCE(NULLIF(trim(p_full_name), ''), inv.full_name), p_password_hash)
    RETURNING id INTO v_uid;
  END IF;

  INSERT INTO tenant_users AS tu (tenant_id, user_id) VALUES (inv.tenant_id, v_uid)
  ON CONFLICT (tenant_id, user_id) DO UPDATE SET status = 'active';

  IF NOT EXISTS (
    SELECT 1 FROM user_roles ur
     WHERE ur.tenant_id = inv.tenant_id AND ur.user_id = v_uid AND ur.role_id = inv.role_id
       AND ur.revoked_at IS NULL
       AND daterange(ur.effective_from, ur.effective_to, '[]') && daterange(v_today, NULL, '[]')
  ) THEN
    INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from)
    VALUES (inv.tenant_id, v_uid, inv.role_id, v_today);
  END IF;

  UPDATE organization_invitations
     SET accepted_at = now(), accepted_user_id = v_uid
   WHERE tenant_id = inv.tenant_id AND id = inv.id;

  INSERT INTO organization_audit_log (tenant_id, actor_user_id, action, target_type, target_id,
                                      after_state, request_id)
  VALUES (inv.tenant_id, v_uid, 'invitation.accept', 'invitation', inv.id,
          jsonb_build_object('email', inv.email, 'roleId', inv.role_id, 'userId', v_uid), p_request_id);

  out_tenant_id := inv.tenant_id;
  out_user_id := v_uid;
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION onboarding_invitation_lookup(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION onboarding_accept_invitation(bytea, text, varchar, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_invitation_lookup(bytea) TO hrms_app;
GRANT EXECUTE ON FUNCTION onboarding_accept_invitation(bytea, text, varchar, text) TO hrms_app;

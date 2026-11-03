-- =============================================================================
-- 009 — Employee creation: HR quick add + employee self-service (Milestone 3)
--
--   Approach "A + D":
--   * A — HR "Quick add" creates EVERYTHING in one transaction: login identity
--     (or links an existing one), tenant membership (status 'invited'), employee
--     record, reporting line, roles and a one-time activation link. Only full
--     name, work email and joining date are mandatory.
--   * D — the employee activates and completes their own personal, address and
--     emergency-contact details (self-service fields). HR can still fill or
--     correct any field directly.
--
--   * tenant_users gains status 'invited': the membership exists (so roles can
--     be assigned up front) but grants no access until the invitation is
--     accepted — auth_user_tenants and v_effective_permissions only consider
--     'active' memberships.
--   * Invitations gain a kind ('admin' | 'employee') and an employee link.
--     Employee invitations carry no role: roles are assigned at quick add.
--   * employee_audit_log: append-only history of every employee change.
-- =============================================================================

-- ------------------------------------------------------- memberships ----
ALTER TABLE tenant_users DROP CONSTRAINT tenant_users_status_check;
ALTER TABLE tenant_users ADD CONSTRAINT tenant_users_status_check
  CHECK (status IN ('invited', 'active', 'suspended', 'left'));

-- ------------------------------------------------------- employees ------
ALTER TABLE employees
  -- job details (HR-owned)
  ADD COLUMN job_title                   varchar(150),
  ADD COLUMN employment_type             varchar(20) NOT NULL DEFAULT 'full_time'
             CHECK (employment_type IN ('full_time', 'part_time', 'contract', 'intern')),
  ADD COLUMN work_location               varchar(150),
  -- personal details (self-service; HR may also edit)
  ADD COLUMN preferred_name              varchar(100),
  ADD COLUMN date_of_birth               date CHECK (date_of_birth > DATE '1900-01-01'),
  ADD COLUMN gender                      varchar(30)
             CHECK (gender IN ('female', 'male', 'non_binary', 'other', 'prefer_not_to_say')),
  ADD COLUMN personal_email              citext,
  ADD COLUMN mobile_phone                varchar(40),
  ADD COLUMN address_line1               varchar(200),
  ADD COLUMN address_line2               varchar(200),
  ADD COLUMN city                        varchar(100),
  ADD COLUMN state_province              varchar(100),
  ADD COLUMN postal_code                 varchar(20),
  ADD COLUMN country_code                char(2) CHECK (country_code ~ '^[A-Z]{2}$'),
  ADD COLUMN emergency_contact_name      varchar(200),
  ADD COLUMN emergency_contact_relation  varchar(60),
  ADD COLUMN emergency_contact_phone     varchar(40),
  -- bookkeeping
  ADD COLUMN profile_completed_at        timestamptz,
  ADD COLUMN created_by                  bigint,
  ADD COLUMN version                     integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT fk_employees_created_by
      FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id);

CREATE INDEX idx_employees_name ON employees (tenant_id, lower(full_name));
CREATE INDEX idx_employees_department ON employees (tenant_id, department_id);

-- ------------------------------------------------------- invitations ----
ALTER TABLE organization_invitations
  ADD COLUMN kind varchar(20) NOT NULL DEFAULT 'admin' CHECK (kind IN ('admin', 'employee')),
  ADD COLUMN employee_id bigint,
  ALTER COLUMN role_id DROP NOT NULL,
  ADD CONSTRAINT fk_invitation_employee
      FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  ADD CONSTRAINT ck_invitation_role CHECK (kind = 'employee' OR role_id IS NOT NULL),
  ADD CONSTRAINT ck_invitation_employee CHECK (kind = 'admin' OR employee_id IS NOT NULL);
CREATE INDEX idx_invitations_employee ON organization_invitations (tenant_id, employee_id, created_at DESC);

-- ---------------------------------------------------- employee audit ----
CREATE TABLE employee_audit_log (
  tenant_id      bigint      NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint      NOT NULL,
  action         varchar(40) NOT NULL CHECK (action IN (
                   'employee.create', 'employee.update', 'employee.self_update',
                   'employee.invite', 'employee.profile.complete')),
  employee_id    bigint      NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX idx_employee_audit ON employee_audit_log (tenant_id, employee_id, at DESC);
CREATE INDEX idx_employee_audit_at ON employee_audit_log (tenant_id, at DESC);
CREATE TRIGGER trg_employee_audit_append_only
  BEFORE UPDATE OR DELETE ON employee_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

ALTER TABLE employee_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON employee_audit_log
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- -------------------------------------------------------------- grants ----
GRANT SELECT, INSERT ON employee_audit_log TO hrms_app;
GRANT SELECT, INSERT ON organization_invitations TO hrms_app;
GRANT UPDATE (revoked_at) ON organization_invitations TO hrms_app;
-- Only FUTURE reporting lines are ever deleted (enforced in the service).
GRANT DELETE ON employee_reporting TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

-- ------------------------------------------------- definer helpers ------
-- Quick add needs a login identity. users is global (one person, many tenants)
-- and read-only to the API, so this narrow function creates a PASSWORDLESS
-- identity, or returns the existing one for that email. It never changes an
-- existing account. Only callable inside a tenant transaction.
CREATE FUNCTION employee_ensure_user(p_email citext, p_full_name varchar)
RETURNS TABLE (out_user_id bigint, out_is_active boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF current_tenant_id() IS NULL THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO users (email, full_name) VALUES (p_email, p_full_name)
  ON CONFLICT (email) DO NOTHING;
  RETURN QUERY SELECT u.id, u.is_active FROM users u WHERE u.email = p_email;
END $$;
REVOKE ALL ON FUNCTION employee_ensure_user(citext, varchar) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION employee_ensure_user(citext, varchar) TO hrms_app;

-- Invitation preview now says what the invitation is for.
DROP FUNCTION onboarding_invitation_lookup(bytea);
CREATE FUNCTION onboarding_invitation_lookup(p_token_hash bytea)
RETURNS TABLE (tenant_id bigint, invitation_id bigint, email citext, full_name varchar,
               organization_name varchar, user_exists boolean, user_has_password boolean,
               kind varchar, job_title varchar)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.tenant_id, i.id, i.email, i.full_name, t.name,
         u.id IS NOT NULL, u.password_hash IS NOT NULL, i.kind, e.job_title
  FROM organization_invitations i
  JOIN tenants t ON t.id = i.tenant_id AND t.is_active
  LEFT JOIN users u ON u.email = i.email
  LEFT JOIN employees e ON e.tenant_id = i.tenant_id AND e.id = i.employee_id
  WHERE i.token_hash = p_token_hash
    AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
    AND (u.id IS NULL OR u.is_active)
    AND (e.id IS NULL OR e.status <> 'exited')
$$;
REVOKE ALL ON FUNCTION onboarding_invitation_lookup(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_invitation_lookup(bytea) TO hrms_app;

-- Accepting: same guarantees as 007, plus employee invitations (no role on the
-- invitation; the employee record is linked to the activating account).
CREATE OR REPLACE FUNCTION onboarding_accept_invitation(
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

  IF inv.employee_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM employees e WHERE e.tenant_id = inv.tenant_id AND e.id = inv.employee_id AND e.status = 'exited') THEN
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
      UPDATE users SET password_hash = p_password_hash,
                       full_name = COALESCE(NULLIF(trim(p_full_name), ''), full_name)
       WHERE id = v_user.id;
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

  IF inv.role_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM user_roles ur
     WHERE ur.tenant_id = inv.tenant_id AND ur.user_id = v_uid AND ur.role_id = inv.role_id
       AND ur.revoked_at IS NULL
       AND daterange(ur.effective_from, ur.effective_to, '[]') && daterange(v_today, NULL, '[]')
  ) THEN
    INSERT INTO user_roles (tenant_id, user_id, role_id, effective_from)
    VALUES (inv.tenant_id, v_uid, inv.role_id, v_today);
  END IF;

  IF inv.employee_id IS NOT NULL THEN
    UPDATE employees SET user_id = v_uid
     WHERE tenant_id = inv.tenant_id AND id = inv.employee_id AND user_id IS DISTINCT FROM v_uid;
  END IF;

  UPDATE organization_invitations
     SET accepted_at = now(), accepted_user_id = v_uid
   WHERE tenant_id = inv.tenant_id AND id = inv.id;

  INSERT INTO organization_audit_log (tenant_id, actor_user_id, action, target_type, target_id,
                                      after_state, request_id)
  VALUES (inv.tenant_id, v_uid, 'invitation.accept', 'invitation', inv.id,
          jsonb_build_object('email', inv.email, 'kind', inv.kind, 'roleId', inv.role_id,
                             'employeeId', inv.employee_id, 'userId', v_uid), p_request_id);

  out_tenant_id := inv.tenant_id;
  out_user_id := v_uid;
  RETURN NEXT;
END $$;

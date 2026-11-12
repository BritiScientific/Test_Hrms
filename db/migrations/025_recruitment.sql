-- =============================================================================
-- NOTE: candidates, job_positions and the audit log are prefixed rec_ because an earlier
-- phase-1 branch left tables with those names in some dev databases.
-- 025 — Recruitment: pipeline, candidates, interviews, configuration, careers site
--
--   * recruitments own a pipeline of stages (recruitment_stages) and one or more
--     vacancy lines (recruitment_vacancies: job position + headcount). A line can
--     never be filled beyond its headcount: hiring locks the line and counts.
--   * rec_candidates (the candidate directory) is the central, tenant-wide directory (one row per email);
--     applications link a candidate to a recruitment and carry the pipeline
--     position. A candidate applies to a recruitment once.
--   * Documents (resume / photo) are stored in Postgres, RLS-protected, like the
--     leave attachments. A public upload is unlinked until the application is
--     submitted and must present its claim_token to be linked; unlinked rows are
--     purged by the daily job.
--   * The public careers site has no session. It resolves the tenant through two
--     narrow SECURITY DEFINER lookups (by organization slug, by job slug) and then
--     runs in a normal tenant transaction, so RLS still scopes every statement.
--   * Nothing is deleted: recruitments are closed, configuration rows are
--     deactivated. hrms_app gets DELETE only where rows are structural children
--     (stages, vacancy lines, managers) or throw-away (orphan documents).
--   * Every change is written to rec_audit_log (append-only) in the same
--     transaction; stage moves also go to application_stage_log.
-- =============================================================================

-- ------------------------------------------------------------ configuration --
CREATE TABLE rec_job_positions (
  tenant_id      bigint       NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  title          varchar(150) NOT NULL,
  department_id  bigint,
  description    text,
  is_active      boolean      NOT NULL DEFAULT true,
  created_by     bigint,
  updated_by     bigint,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_rec_job_positions_title ON rec_job_positions (tenant_id, lower(title), COALESCE(department_id, 0));
CREATE TRIGGER trg_job_positions_updated BEFORE UPDATE ON rec_job_positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE survey_templates (
  tenant_id    bigint       NOT NULL REFERENCES tenants(id),
  id           bigint GENERATED ALWAYS AS IDENTITY,
  name         varchar(150) NOT NULL,
  description  text,
  -- [{ "id": "q1", "label": "...", "type": "text|textarea|yes_no|select|number", "required": true, "options": ["a","b"] }]
  questions    jsonb        NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(questions) = 'array'),
  is_active    boolean      NOT NULL DEFAULT true,
  created_by   bigint,
  updated_by   bigint,
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_survey_templates_name ON survey_templates (tenant_id, lower(name));
CREATE TRIGGER trg_survey_templates_updated BEFORE UPDATE ON survey_templates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE rejection_reasons (
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
CREATE UNIQUE INDEX uq_rejection_reasons_name ON rejection_reasons (tenant_id, lower(name));
CREATE TRIGGER trg_rejection_reasons_updated BEFORE UPDATE ON rejection_reasons
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per tenant, created lazily by the API on first save.
CREATE TABLE recruitment_settings (
  tenant_id             bigint PRIMARY KEY REFERENCES tenants(id),
  careers_enabled       boolean       NOT NULL DEFAULT true,
  careers_headline      varchar(200),
  careers_intro         text,
  confirmation_message  text,
  privacy_notice_url    varchar(500),
  updated_by            bigint,
  updated_at            timestamptz   NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);

-- ------------------------------------------------------------- recruitments --
CREATE TABLE recruitments (
  tenant_id            bigint       NOT NULL REFERENCES tenants(id),
  id                   bigint GENERATED ALWAYS AS IDENTITY,
  title                varchar(200) NOT NULL,
  -- Public URL key: /careers/<slug>. Globally unique so the link needs no organization.
  slug                 varchar(120) NOT NULL,
  description          text         NOT NULL DEFAULT '',
  start_date           date         NOT NULL,
  end_date             date,
  status               varchar(10)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  is_published         boolean      NOT NULL DEFAULT false,
  optional_resume      boolean      NOT NULL DEFAULT false,
  optional_photo       boolean      NOT NULL DEFAULT true,
  skills               text[]       NOT NULL DEFAULT '{}',
  survey_template_id   bigint,
  closed_at            timestamptz,
  created_by           bigint,
  updated_by           bigint,
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (end_date IS NULL OR end_date >= start_date),
  CHECK (cardinality(skills) <= 30),
  FOREIGN KEY (tenant_id, survey_template_id) REFERENCES survey_templates(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_recruitments_slug ON recruitments (slug);
CREATE INDEX idx_recruitments_status ON recruitments (tenant_id, status, start_date DESC);
CREATE TRIGGER trg_recruitments_updated BEFORE UPDATE ON recruitments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recruitment_managers (
  tenant_id       bigint NOT NULL,
  recruitment_id  bigint NOT NULL,
  employee_id     bigint NOT NULL,
  PRIMARY KEY (tenant_id, recruitment_id, employee_id),
  FOREIGN KEY (tenant_id, recruitment_id) REFERENCES recruitments(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX idx_recruitment_managers_employee ON recruitment_managers (tenant_id, employee_id);

CREATE TABLE recruitment_vacancies (
  tenant_id         bigint  NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  recruitment_id    bigint  NOT NULL,
  job_position_id   bigint  NOT NULL,
  vacancies         integer NOT NULL CHECK (vacancies BETWEEN 1 AND 1000),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, recruitment_id, job_position_id),
  FOREIGN KEY (tenant_id, recruitment_id) REFERENCES recruitments(tenant_id, id),
  FOREIGN KEY (tenant_id, job_position_id) REFERENCES rec_job_positions(tenant_id, id)
);

CREATE TABLE recruitment_stages (
  tenant_id       bigint       NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  recruitment_id  bigint       NOT NULL,
  name            varchar(100) NOT NULL,
  stage_type      varchar(20)  NOT NULL
                  CHECK (stage_type IN ('applied', 'initial', 'test', 'interview', 'shortlisted', 'hired', 'rejected')),
  sequence        integer      NOT NULL CHECK (sequence >= 1),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recruitment_id) REFERENCES recruitments(tenant_id, id),
  -- Deferrable so a reorder can renumber in one statement.
  CONSTRAINT uq_stage_sequence UNIQUE (tenant_id, recruitment_id, sequence) DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX uq_stage_name ON recruitment_stages (tenant_id, recruitment_id, lower(name));
-- Exactly one applied (entry), hired and rejected stage per recruitment.
CREATE UNIQUE INDEX uq_stage_applied  ON recruitment_stages (tenant_id, recruitment_id) WHERE stage_type = 'applied';
CREATE UNIQUE INDEX uq_stage_hired    ON recruitment_stages (tenant_id, recruitment_id) WHERE stage_type = 'hired';
CREATE UNIQUE INDEX uq_stage_rejected ON recruitment_stages (tenant_id, recruitment_id) WHERE stage_type = 'rejected';

-- ------------------------------------------------------------- candidates ---
CREATE TABLE rec_candidates (
  tenant_id         bigint       NOT NULL REFERENCES tenants(id),
  id                bigint GENERATED ALWAYS AS IDENTITY,
  full_name         varchar(200) NOT NULL,
  email             citext       NOT NULL,
  phone             varchar(40),
  current_company   varchar(200),
  current_title     varchar(200),
  experience_years  numeric(4,1) CHECK (experience_years BETWEEN 0 AND 80),
  location          varchar(200),
  linkedin_url      varchar(500),
  source            varchar(20)  NOT NULL DEFAULT 'manual' CHECK (source IN ('careers', 'manual', 'referral', 'agency', 'other')),
  created_by        bigint,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_rec_candidates_email ON rec_candidates (tenant_id, email);
CREATE INDEX idx_rec_candidates_name ON rec_candidates (tenant_id, lower(full_name));
CREATE TRIGGER trg_candidates_updated BEFORE UPDATE ON rec_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE candidate_documents (
  tenant_id     bigint       NOT NULL REFERENCES tenants(id),
  id            bigint GENERATED ALWAYS AS IDENTITY,
  candidate_id  bigint,
  kind          varchar(10)  NOT NULL CHECK (kind IN ('resume', 'photo')),
  file_name     varchar(200) NOT NULL,
  content_type  varchar(100) NOT NULL,
  byte_size     integer      NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256        char(64)     NOT NULL,
  data          bytea        NOT NULL,
  claim_token   uuid         NOT NULL DEFAULT gen_random_uuid(),
  uploaded_by   bigint,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (octet_length(data) = byte_size),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES rec_candidates(tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_candidate_documents_candidate ON candidate_documents (tenant_id, candidate_id);
CREATE INDEX idx_candidate_documents_orphans ON candidate_documents (created_at) WHERE candidate_id IS NULL;

CREATE TABLE applications (
  tenant_id            bigint       NOT NULL REFERENCES tenants(id),
  id                   bigint GENERATED ALWAYS AS IDENTITY,
  reference            varchar(30)  NOT NULL,
  recruitment_id       bigint       NOT NULL,
  candidate_id         bigint       NOT NULL,
  job_position_id      bigint,
  stage_id             bigint       NOT NULL,
  status               varchar(10)  NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'hired', 'rejected')),
  rejection_reason_id  bigint,
  rejection_note       text,
  cover_letter         text,
  answers              jsonb        NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(answers) = 'array'),
  resume_document_id   bigint,
  photo_document_id    bigint,
  rating               smallint     CHECK (rating BETWEEN 1 AND 5),
  source               varchar(20)  NOT NULL DEFAULT 'careers' CHECK (source IN ('careers', 'manual', 'referral', 'agency', 'other')),
  applied_at           timestamptz  NOT NULL DEFAULT now(),
  stage_changed_at     timestamptz  NOT NULL DEFAULT now(),
  hired_at             timestamptz,
  created_by           bigint,
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, recruitment_id, candidate_id),
  FOREIGN KEY (tenant_id, recruitment_id) REFERENCES recruitments(tenant_id, id),
  FOREIGN KEY (tenant_id, candidate_id) REFERENCES rec_candidates(tenant_id, id),
  FOREIGN KEY (tenant_id, job_position_id) REFERENCES rec_job_positions(tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES recruitment_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, rejection_reason_id) REFERENCES rejection_reasons(tenant_id, id),
  FOREIGN KEY (tenant_id, resume_document_id) REFERENCES candidate_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, photo_document_id) REFERENCES candidate_documents(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE UNIQUE INDEX uq_applications_reference ON applications (tenant_id, reference);
CREATE INDEX idx_applications_stage ON applications (tenant_id, recruitment_id, stage_id, applied_at DESC);
CREATE INDEX idx_applications_candidate ON applications (tenant_id, candidate_id);
CREATE INDEX idx_applications_position ON applications (tenant_id, recruitment_id, job_position_id) WHERE status = 'hired';
CREATE TRIGGER trg_applications_updated BEFORE UPDATE ON applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE application_stage_log (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  application_id  bigint       NOT NULL,
  from_stage_id   bigint,
  to_stage_id     bigint       NOT NULL,
  actor_user_id   bigint,
  note            text,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, from_stage_id) REFERENCES recruitment_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, to_stage_id) REFERENCES recruitment_stages(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_stage_log_application ON application_stage_log (tenant_id, application_id, created_at);
CREATE TRIGGER trg_stage_log_append_only BEFORE UPDATE OR DELETE ON application_stage_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

CREATE TABLE application_notes (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  application_id  bigint       NOT NULL,
  author_user_id  bigint       NOT NULL,
  body            text         NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_application_notes_application ON application_notes (tenant_id, application_id, created_at DESC);
CREATE TRIGGER trg_application_notes_append_only BEFORE UPDATE OR DELETE ON application_notes
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- -------------------------------------------------------------- interviews ---
CREATE TABLE interviews (
  tenant_id        bigint       NOT NULL REFERENCES tenants(id),
  id               bigint GENERATED ALWAYS AS IDENTITY,
  application_id   bigint       NOT NULL,
  title            varchar(150) NOT NULL,
  starts_at        timestamptz  NOT NULL,
  ends_at          timestamptz  NOT NULL,
  mode             varchar(10)  NOT NULL CHECK (mode IN ('video', 'in_person', 'phone')),
  location         varchar(300),
  meeting_link     varchar(500),
  notes            text,
  status           varchar(10)  NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
  cancel_reason    text,
  created_by       bigint,
  updated_by       bigint,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (ends_at > starts_at),
  CHECK (ends_at - starts_at <= interval '12 hours'),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, updated_by) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_interviews_start ON interviews (tenant_id, starts_at);
CREATE INDEX idx_interviews_application ON interviews (tenant_id, application_id);
CREATE TRIGGER trg_interviews_updated BEFORE UPDATE ON interviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE interview_interviewers (
  tenant_id     bigint NOT NULL,
  interview_id  bigint NOT NULL,
  employee_id   bigint NOT NULL,
  PRIMARY KEY (tenant_id, interview_id, employee_id),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE INDEX idx_interviewers_employee ON interview_interviewers (tenant_id, employee_id);

CREATE TABLE interview_feedback (
  tenant_id       bigint       NOT NULL REFERENCES tenants(id),
  id              bigint GENERATED ALWAYS AS IDENTITY,
  interview_id    bigint       NOT NULL,
  employee_id     bigint       NOT NULL,
  rating          smallint     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  recommendation  varchar(10)  NOT NULL CHECK (recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')),
  strengths       text,
  concerns        text,
  comments        text,
  submitted_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, interview_id, employee_id),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id)
);
CREATE TRIGGER trg_interview_feedback_updated BEFORE UPDATE ON interview_feedback
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ------------------------------------------------------------------- audit ---
CREATE TABLE rec_audit_log (
  tenant_id      bigint       NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint,
  action         varchar(40)  NOT NULL,
  entity_type    varchar(30)  NOT NULL CHECK (entity_type IN (
                   'recruitment', 'application', 'candidate', 'interview', 'job_position',
                   'survey_template', 'rejection_reason', 'settings')),
  entity_id      bigint       NOT NULL,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_rec_audit_entity ON rec_audit_log (tenant_id, entity_type, entity_id, created_at DESC);
CREATE TRIGGER trg_rec_audit_append_only BEFORE UPDATE OR DELETE ON rec_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- --------------------------------------------------- public (no session) -----
-- Two narrow lookups, same pattern as auth_find_user: the careers site knows only
-- an organization slug or a job slug, not a tenant id. Only an active tenant and
-- (for a job) a published, open recruitment resolve; the caller then works in an
-- ordinary tenant transaction under RLS.
CREATE OR REPLACE FUNCTION public_tenant_by_slug(p_slug citext)
RETURNS TABLE (tenant_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM tenants WHERE slug = p_slug AND is_active
$$;

CREATE OR REPLACE FUNCTION public_tenant_by_job_slug(p_slug text)
RETURNS TABLE (tenant_id bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.tenant_id
    FROM recruitments r JOIN tenants t ON t.id = r.tenant_id
   WHERE r.slug = p_slug AND r.is_published AND t.is_active
$$;

REVOKE ALL ON FUNCTION public_tenant_by_slug(citext)     FROM PUBLIC;
REVOKE ALL ON FUNCTION public_tenant_by_job_slug(text)   FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_tenant_by_slug(citext)   TO hrms_app;
GRANT EXECUTE ON FUNCTION public_tenant_by_job_slug(text) TO hrms_app;

-- --------------------------------------------------------------- RLS / grants --
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'rec_job_positions', 'survey_templates', 'rejection_reasons', 'recruitment_settings',
    'recruitments', 'recruitment_managers', 'recruitment_vacancies', 'recruitment_stages',
    'rec_candidates', 'candidate_documents', 'applications', 'application_stage_log', 'application_notes',
    'interviews', 'interview_interviewers', 'interview_feedback', 'rec_audit_log'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (tenant_id = current_tenant_id())
         WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON
  rec_job_positions, survey_templates, rejection_reasons, recruitment_settings,
  recruitments, recruitment_vacancies, recruitment_stages,
  rec_candidates, candidate_documents, applications, interviews, interview_feedback
TO hrms_app;
GRANT SELECT, INSERT, DELETE ON recruitment_managers, interview_interviewers TO hrms_app;
GRANT DELETE ON recruitment_vacancies, recruitment_stages TO hrms_app;   -- empty children only (service checks)
GRANT DELETE ON candidate_documents TO hrms_app;                          -- orphan purge only (service checks)
GRANT SELECT, INSERT ON application_stage_log, application_notes, rec_audit_log TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

-- -------------------------------------------------------------- permissions --
INSERT INTO permissions (code, module, description) VALUES
  ('recruitment.pipeline.view',      'recruitment', 'View recruitments and their candidate pipeline'),
  ('recruitment.manage',             'recruitment', 'Create, edit, publish and close recruitments, vacancies and pipeline stages'),
  ('recruitment.candidate.view',     'recruitment', 'View the candidate directory, profiles and resumes'),
  ('recruitment.candidate.manage',   'recruitment', 'Add rec_candidates, move them between stages, reject, hire and add notes'),
  ('recruitment.interview.view',     'recruitment', 'View every interview and its feedback'),
  ('recruitment.interview.manage',   'recruitment', 'Schedule, reschedule, cancel and complete interviews'),
  ('recruitment.interview.feedback', 'recruitment', 'View interviews you are an interviewer on and submit your feedback'),
  ('recruitment.configuration.view', 'recruitment', 'View recruitment settings, job positions, survey templates and rejection reasons'),
  ('recruitment.configuration.manage', 'recruitment', 'Manage recruitment settings, job positions, survey templates and rejection reasons')
ON CONFLICT (code) DO NOTHING;

-- Tenant Admin keeps "full access"; HR configuration roles get the same reach.
-- Everybody else (managers, employees) receives only what an admin grants later;
-- an interviewer needs recruitment.interview.feedback, which only ever exposes
-- the interviews they are named on.
INSERT INTO role_permissions (tenant_id, role_id, permission_id)
SELECT r.tenant_id, r.id, p.id
  FROM roles r
 CROSS JOIN permissions p
 WHERE p.module = 'recruitment'
   AND ((r.is_system_role AND r.name = 'Tenant Admin')
        OR EXISTS (
             SELECT 1 FROM role_permissions rp
               JOIN permissions lp ON lp.id = rp.permission_id
              WHERE rp.tenant_id = r.tenant_id AND rp.role_id = r.id
                AND lp.code = 'leave.configuration.manage'))
ON CONFLICT DO NOTHING;

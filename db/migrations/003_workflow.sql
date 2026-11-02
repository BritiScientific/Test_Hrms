-- =============================================================================
-- 003 — Workflow engine
-- Fixes vs. original design:
--   * Exactly one PUBLISHED definition per (tenant, module) — partial unique
--     index. Previously two published "Leave Approval" rows were possible and
--     "find the published workflow" was ambiguous.
--   * Published definitions and their steps are immutable (triggers), not just
--     "should be". steps.is_active was removed — it was a mutable flag that
--     defeated versioning.
--   * required_permission_code is NOT NULL: a step without a permission meant
--     "anyone assigned can approve".
--   * on_no_approver / fallback_role_id: explicit behaviour when the resolver
--     returns nobody (no manager, empty role, everyone excluded by SoD).
--   * Step "condition" is per-step ("this step applies when ...") — the doc put
--     a workflow-level rule list with step arrays into a step-level column.
--   * 'requester_manager' removed (identical to reporting_manager);
--     'second_level_manager' added.
--   * Instances carry requested_for_employee_id (hierarchy is employee-based),
--     a cycle counter for return/resubmit, and a context snapshot used for
--     condition evaluation. One ACTIVE instance per entity (partial unique).
--   * Tasks: composite FKs force task.step to belong to task.instance's
--     workflow (doc 31.1, now actually in the DDL); unique per
--     (instance, cycle, step, assignee) prevents duplicate task generation;
--     redundant `action` column removed; acted_by/on_behalf_of recorded.
--   * Action log: task id is nullable (submit/cancel/complete have no task —
--     the doc's own history table showed "Submitted", which the original
--     NOT NULL task FK + CHECK list could not store). Append-only enforced.
--   * State-transition triggers make illegal transitions impossible even if a
--     service has a bug.
--   * Outbox table for post-commit notifications.
-- =============================================================================

-- --------------------------------------------------- workflow_definitions ----
CREATE TABLE workflow_definitions (
  tenant_id     bigint       NOT NULL REFERENCES tenants(id),
  id            bigint GENERATED ALWAYS AS IDENTITY,
  module        varchar(50)  NOT NULL CHECK (module ~ '^[a-z][a-z_]*$'),
  name          varchar(150) NOT NULL,
  version       int          NOT NULL CHECK (version > 0),
  description   text,
  status        varchar(20)  NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft', 'published', 'archived')),
  created_by    bigint       NOT NULL,
  published_by  bigint,
  published_at  timestamptz,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, module),
  UNIQUE (tenant_id, module, version),
  FOREIGN KEY (tenant_id, created_by)   REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, published_by) REFERENCES tenant_users(tenant_id, user_id),
  CHECK (status = 'draft' OR (published_at IS NOT NULL AND published_by IS NOT NULL))
);
CREATE UNIQUE INDEX uq_wf_def_one_published ON workflow_definitions (tenant_id, module)
  WHERE status = 'published';
CREATE UNIQUE INDEX uq_wf_def_one_draft ON workflow_definitions (tenant_id, module)
  WHERE status = 'draft';
CREATE TRIGGER trg_wf_def_updated BEFORE UPDATE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION wf_guard_definition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Workflow definition % is % and cannot be deleted', OLD.id, OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'published' THEN
    IF NEW.status = 'archived'
       AND (NEW.module, NEW.name, NEW.version, NEW.description, NEW.published_at, NEW.published_by)
           IS NOT DISTINCT FROM
           (OLD.module, OLD.name, OLD.version, OLD.description, OLD.published_at, OLD.published_by)
    THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Published workflow definition % is immutable; create a new version', OLD.id
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'archived' THEN
    RAISE EXCEPTION 'Archived workflow definition % is immutable', OLD.id
      USING ERRCODE = 'check_violation';
  ELSIF NEW.status = 'archived' THEN
    RAISE EXCEPTION 'Drafts cannot be archived; delete the draft instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wf_def_guard
  BEFORE UPDATE OR DELETE ON workflow_definitions
  FOR EACH ROW EXECUTE FUNCTION wf_guard_definition();

-- --------------------------------------------------------- workflow_steps ----
CREATE TABLE workflow_steps (
  tenant_id                 bigint       NOT NULL,
  id                        bigint GENERATED ALWAYS AS IDENTITY,
  workflow_id               bigint       NOT NULL,
  step_order                int          NOT NULL CHECK (step_order BETWEEN 1 AND 20),
  name                      varchar(150) NOT NULL,
  approver_type             varchar(30)  NOT NULL CHECK (approver_type IN (
                              'reporting_manager', 'second_level_manager',
                              'department_head', 'role', 'specific_user')),
  approver_role_id          bigint,
  specific_user_id          bigint,
  required_permission_code  varchar(150) NOT NULL REFERENCES permissions(code),
  approval_mode             varchar(10)  NOT NULL DEFAULT 'any'
                            CHECK (approval_mode IN ('any', 'all')),
  allow_reject              boolean      NOT NULL DEFAULT true,
  allow_return              boolean      NOT NULL DEFAULT true,
  on_no_approver            varchar(20)  NOT NULL DEFAULT 'fail'
                            CHECK (on_no_approver IN ('fail', 'skip', 'fallback_role')),
  fallback_role_id          bigint,
  condition                 jsonb,          -- NULL = step always applies
  sla_hours                 int CHECK (sla_hours IS NULL OR sla_hours > 0),
  created_at                timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, workflow_id, step_order),
  UNIQUE (tenant_id, id, workflow_id, step_order),
  FOREIGN KEY (tenant_id, workflow_id) REFERENCES workflow_definitions(tenant_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, approver_role_id) REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, fallback_role_id) REFERENCES roles(tenant_id, id),
  FOREIGN KEY (tenant_id, specific_user_id) REFERENCES tenant_users(tenant_id, user_id),
  CHECK ((approver_type = 'role') = (approver_role_id IS NOT NULL)),
  CHECK ((approver_type = 'specific_user') = (specific_user_id IS NOT NULL)),
  CHECK ((on_no_approver = 'fallback_role') = (fallback_role_id IS NOT NULL)),
  -- "all" only makes sense when the resolver can return several people.
  CHECK (approval_mode = 'any' OR approver_type = 'role'),
  CHECK (condition IS NULL OR jsonb_typeof(condition) = 'object')
);

CREATE OR REPLACE FUNCTION wf_guard_steps() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status text;
  v_wf     bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.workflow_id ELSE NEW.workflow_id END;
  v_tenant bigint := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id  ELSE NEW.tenant_id  END;
BEGIN
  SELECT status INTO v_status FROM workflow_definitions
  WHERE tenant_id = v_tenant AND id = v_wf;

  -- Parent already gone => cascade delete of a draft; allow.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Steps of a % workflow definition are immutable', v_status
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.workflow_id <> OLD.workflow_id THEN
    RAISE EXCEPTION 'A step cannot be moved to another workflow'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE TRIGGER trg_wf_steps_guard
  BEFORE INSERT OR UPDATE OR DELETE ON workflow_steps
  FOR EACH ROW EXECUTE FUNCTION wf_guard_steps();

-- ----------------------------------------------------- workflow_instances ----
CREATE TABLE workflow_instances (
  tenant_id                  bigint      NOT NULL,
  id                         bigint GENERATED ALWAYS AS IDENTITY,
  workflow_id                bigint      NOT NULL,
  module                     varchar(50) NOT NULL,
  entity_id                  bigint      NOT NULL,
  requested_by               bigint      NOT NULL,   -- user who submitted
  requested_for_employee_id  bigint      NOT NULL,   -- whose request it is
  status                     varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
                               'pending', 'returned', 'approved', 'rejected',
                               'cancelled', 'failed')),
  cycle                      int         NOT NULL DEFAULT 1 CHECK (cycle > 0),
  current_step_order         int,
  context                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  completed_at               timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, id, workflow_id),
  FOREIGN KEY (tenant_id, workflow_id, module)
    REFERENCES workflow_definitions(tenant_id, id, module),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, requested_for_employee_id) REFERENCES employees(tenant_id, id),
  CHECK ((status IN ('approved', 'rejected', 'cancelled', 'failed')) = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_wf_instance_active_entity ON workflow_instances (tenant_id, module, entity_id)
  WHERE status IN ('pending', 'returned');
CREATE INDEX idx_wf_instance_entity ON workflow_instances (tenant_id, module, entity_id);
CREATE INDEX idx_wf_instance_requester ON workflow_instances (tenant_id, requested_by, status);
CREATE TRIGGER trg_wf_instance_updated BEFORE UPDATE ON workflow_instances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION wf_guard_instance_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status IN ('approved', 'rejected', 'cancelled', 'failed') THEN
    RAISE EXCEPTION 'Workflow instance % is % (terminal)', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'pending' AND NEW.status NOT IN
       ('pending', 'approved', 'rejected', 'returned', 'cancelled', 'failed')
     OR OLD.status = 'returned' AND NEW.status NOT IN ('returned', 'pending', 'cancelled')
  THEN
    RAISE EXCEPTION 'Illegal workflow transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.workflow_id <> OLD.workflow_id OR NEW.entity_id <> OLD.entity_id
     OR NEW.module <> OLD.module OR NEW.requested_by <> OLD.requested_by THEN
    RAISE EXCEPTION 'Workflow instance identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.cycle < OLD.cycle THEN
    RAISE EXCEPTION 'Workflow cycle cannot decrease' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wf_instance_transition
  BEFORE UPDATE ON workflow_instances
  FOR EACH ROW EXECUTE FUNCTION wf_guard_instance_transition();

-- --------------------------------------------------------- workflow_tasks ----
CREATE TABLE workflow_tasks (
  tenant_id             bigint      NOT NULL,
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  workflow_instance_id  bigint      NOT NULL,
  workflow_id           bigint      NOT NULL,
  workflow_step_id      bigint      NOT NULL,
  step_order            int         NOT NULL,
  cycle                 int         NOT NULL,
  assigned_to           bigint      NOT NULL,
  status                varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'approved', 'rejected', 'returned',
                          'cancelled', 'skipped')),
  acted_by              bigint,
  on_behalf_of          bigint,
  comments              text,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  acted_at              timestamptz,
  due_at                timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_instance_id, workflow_id)
    REFERENCES workflow_instances(tenant_id, id, workflow_id),
  FOREIGN KEY (tenant_id, workflow_step_id, workflow_id, step_order)
    REFERENCES workflow_steps(tenant_id, id, workflow_id, step_order),
  FOREIGN KEY (tenant_id, assigned_to)  REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, acted_by)     REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, on_behalf_of) REFERENCES tenant_users(tenant_id, user_id),
  UNIQUE (tenant_id, workflow_instance_id, cycle, step_order, assigned_to),
  CHECK (status NOT IN ('approved', 'rejected', 'returned')
         OR (acted_by IS NOT NULL AND acted_at IS NOT NULL)),
  CHECK (on_behalf_of IS NULL OR on_behalf_of = assigned_to)
);
CREATE INDEX idx_wf_tasks_inbox ON workflow_tasks (tenant_id, assigned_to) WHERE status = 'pending';
CREATE INDEX idx_wf_tasks_instance ON workflow_tasks (tenant_id, workflow_instance_id, cycle, step_order);
CREATE INDEX idx_wf_tasks_due ON workflow_tasks (tenant_id, due_at) WHERE status = 'pending';

CREATE OR REPLACE FUNCTION wf_guard_task_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Workflow task % already %', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.workflow_instance_id, NEW.workflow_step_id, NEW.cycle, NEW.step_order)
     IS DISTINCT FROM (OLD.workflow_instance_id, OLD.workflow_step_id, OLD.cycle, OLD.step_order)
  THEN
    RAISE EXCEPTION 'Workflow task identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_wf_task_transition
  BEFORE UPDATE ON workflow_tasks
  FOR EACH ROW EXECUTE FUNCTION wf_guard_task_transition();

-- --------------------------------------------------- workflow_action_logs ----
CREATE TABLE workflow_action_logs (
  tenant_id             bigint      NOT NULL,
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  workflow_instance_id  bigint      NOT NULL,
  workflow_task_id      bigint,                 -- NULL for submit/cancel/complete/...
  actor_user_id         bigint,                 -- NULL = system
  on_behalf_of_user_id  bigint,                 -- set when acting as a delegate
  action                varchar(20) NOT NULL CHECK (action IN (
                          'submit', 'resubmit', 'approve', 'reject', 'return',
                          'cancel', 'auto_skip', 'complete', 'reassign', 'escalate')),
  step_order            int,
  cycle                 int         NOT NULL,
  from_status           varchar(20),
  to_status             varchar(20),
  comments              text,
  metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
  at                    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES workflow_instances(tenant_id, id),
  FOREIGN KEY (tenant_id, workflow_task_id)     REFERENCES workflow_tasks(tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id)        REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, on_behalf_of_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_wf_logs_instance ON workflow_action_logs (tenant_id, workflow_instance_id, at, id);
CREATE TRIGGER trg_wf_logs_append_only
  BEFORE UPDATE OR DELETE ON workflow_action_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- --------------------------------------------------- workflow_delegations ----
CREATE TABLE workflow_delegations (
  tenant_id          bigint      NOT NULL,
  id                 bigint GENERATED ALWAYS AS IDENTITY,
  delegator_user_id  bigint      NOT NULL,
  delegate_user_id   bigint      NOT NULL,
  module             varchar(50),               -- NULL = all modules
  valid_during       tstzrange   NOT NULL,
  reason             text,
  created_by         bigint      NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_by         bigint,
  revoked_at         timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, delegator_user_id) REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, delegate_user_id)  REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, created_by)        REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, revoked_by)        REFERENCES tenant_users(tenant_id, user_id),
  CHECK (delegator_user_id <> delegate_user_id),
  CHECK (NOT isempty(valid_during) AND NOT lower_inf(valid_during) AND NOT upper_inf(valid_during)),
  CONSTRAINT ex_delegation_no_overlap EXCLUDE USING gist (
    tenant_id                 WITH =,
    delegator_user_id         WITH =,
    (COALESCE(module, '*'))   WITH =,
    valid_during              WITH &&
  ) WHERE (revoked_at IS NULL)
);
CREATE INDEX idx_wf_delegations_delegate ON workflow_delegations (tenant_id, delegate_user_id)
  WHERE revoked_at IS NULL;

-- ---------------------------------------------------------- outbox_events ----
CREATE TABLE outbox_events (
  tenant_id       bigint       NOT NULL,
  id              bigint GENERATED ALWAYS AS IDENTITY,
  event_type      varchar(100) NOT NULL,
  aggregate_type  varchar(50)  NOT NULL,
  aggregate_id    bigint       NOT NULL,
  payload         jsonb        NOT NULL,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  available_at    timestamptz  NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  attempts        int          NOT NULL DEFAULT 0,
  last_error      text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
CREATE INDEX idx_outbox_pending ON outbox_events (available_at) WHERE processed_at IS NULL;

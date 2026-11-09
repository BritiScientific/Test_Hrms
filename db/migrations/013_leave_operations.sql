-- =============================================================================
-- 013 — Leave Management: requests, balances and the ledger
--   * The ledger is the source of truth. leave_balances is a projection only the
--     ledger trigger can change; the API role cannot update its buckets.
--   * Every ledger row carries a deterministic idempotency_key, so a retried
--     approval, accrual job or reversal is a no-op instead of a second posting.
--   * Submitting does NOT deduct: it places a hold (LEAVE_HOLD -> pending). The
--     deduction (LEAVE_CONSUMPTION -> used) happens at final approval. Holds are
--     what stop concurrent requests from overspending the same balance.
--   * Overlap is measured in half-day slots, so a morning half day and an
--     afternoon half day on the same date can coexist. The exclusion constraint
--     makes this race-proof.
--   * Attachments live in Postgres behind a storage interface, like tenant_assets.
-- =============================================================================

-- ---------------------------------------------------------- leave_requests ----
-- Half-day slots since an arbitrary epoch: [first slot, slot after the last).
CREATE FUNCTION leave_slot_range(p_start date, p_end date, p_session varchar)
RETURNS int4range
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT int4range(
    (p_start - DATE '2000-01-01') * 2 + CASE WHEN p_session = 'second_half' THEN 1 ELSE 0 END,
    (p_end   - DATE '2000-01-01') * 2 + CASE WHEN p_session = 'first_half'  THEN 1 ELSE 2 END
  )
$$;

CREATE TABLE leave_requests (
  tenant_id             bigint       NOT NULL,
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  employee_id           bigint       NOT NULL,
  leave_type_id         bigint       NOT NULL,
  policy_id             bigint       NOT NULL,
  leave_year            integer      NOT NULL CHECK (leave_year BETWEEN 2000 AND 2100),
  start_date            date         NOT NULL,
  end_date              date         NOT NULL,
  duration_type         varchar(10)  NOT NULL DEFAULT 'full_day'
                        CHECK (duration_type IN ('full_day', 'half_day')),
  half_day_session      varchar(12)  CHECK (half_day_session IN ('first_half', 'second_half')),
  total_days            numeric(6,2) NOT NULL CHECK (total_days > 0),
  reason                text         NOT NULL,
  contact_details       varchar(300),
  status                varchar(20)  NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'returned', 'approved', 'rejected', 'withdrawn', 'cancelled')),
  workflow_instance_id  bigint,
  applied_by            bigint       NOT NULL,
  idempotency_key       uuid,
  decided_at            timestamptz,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id),
  FOREIGN KEY (tenant_id, policy_id)     REFERENCES leave_policies(tenant_id, id),
  FOREIGN KEY (tenant_id, applied_by)    REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES workflow_instances(tenant_id, id),
  UNIQUE (tenant_id, employee_id, idempotency_key),
  CHECK (end_date >= start_date),
  CHECK (leave_year = extract(year FROM start_date)::int
         AND leave_year = extract(year FROM end_date)::int),
  CHECK ((duration_type = 'half_day') = (half_day_session IS NOT NULL)),
  CHECK (duration_type = 'full_day' OR start_date = end_date),
  CONSTRAINT ex_leave_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    leave_slot_range(start_date, end_date, half_day_session) WITH &&
  ) WHERE (status IN ('pending', 'returned', 'approved'))
);
CREATE INDEX idx_leave_req_employee ON leave_requests (tenant_id, employee_id, start_date DESC);
CREATE INDEX idx_leave_req_status   ON leave_requests (tenant_id, status, start_date);
CREATE INDEX idx_leave_req_dates    ON leave_requests (tenant_id, start_date, end_date);
CREATE INDEX idx_leave_req_instance ON leave_requests (tenant_id, workflow_instance_id);
CREATE TRIGGER trg_leave_req_updated BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION leave_guard_request() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.employee_id, NEW.leave_type_id, NEW.start_date, NEW.end_date, NEW.total_days,
      NEW.duration_type, NEW.half_day_session)
     IS DISTINCT FROM
     (OLD.employee_id, OLD.leave_type_id, OLD.start_date, OLD.end_date, OLD.total_days,
      OLD.duration_type, OLD.half_day_session) THEN
    RAISE EXCEPTION 'The dates and leave type of a request cannot change; withdraw it and apply again'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'returned', 'withdrawn', 'cancelled'))
    OR (OLD.status = 'returned' AND NEW.status IN ('pending', 'withdrawn', 'cancelled'))
    OR (OLD.status = 'approved' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Illegal leave transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_req_guard BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION leave_guard_request();

-- ------------------------------------------------------ leave_request_days ----
-- One row per calendar date, written at submission. Reports and calendars read
-- this instead of re-deriving days from a holiday calendar that may have changed.
CREATE TABLE leave_request_days (
  tenant_id         bigint       NOT NULL,
  leave_request_id  bigint       NOT NULL,
  leave_date        date         NOT NULL,
  day_type          varchar(12)  NOT NULL CHECK (day_type IN ('working', 'weekly_off', 'holiday')),
  chargeable_days   numeric(3,2) NOT NULL CHECK (chargeable_days IN (0, 0.5, 1)),
  holiday_name      varchar(150),
  PRIMARY KEY (tenant_id, leave_request_id, leave_date),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_requests(tenant_id, id)
);
CREATE INDEX idx_leave_days_date ON leave_request_days (tenant_id, leave_date);
CREATE TRIGGER trg_leave_days_append_only BEFORE UPDATE OR DELETE ON leave_request_days
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ----------------------------------------------- leave_request_attachments ----
-- Uploaded first (leave_request_id NULL), linked when the request is created.
CREATE TABLE leave_request_attachments (
  tenant_id         bigint       NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  leave_request_id  bigint,
  employee_id       bigint       NOT NULL,
  file_name         varchar(255) NOT NULL,
  content_type      varchar(50)  NOT NULL CHECK (content_type IN (
                      'application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  byte_size         integer      NOT NULL CHECK (byte_size BETWEEN 1 AND 5242880),
  sha256            char(64)     NOT NULL,
  data              bytea        NOT NULL,
  uploaded_by       bigint       NOT NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)      REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, uploaded_by)      REFERENCES tenant_users(tenant_id, user_id),
  CHECK (octet_length(data) = byte_size)
);
CREATE INDEX idx_leave_attach_request ON leave_request_attachments (tenant_id, leave_request_id);
CREATE INDEX idx_leave_attach_orphans ON leave_request_attachments (tenant_id, created_at)
  WHERE leave_request_id IS NULL;

-- ---------------------------------------------------------- leave_balances ----
CREATE TABLE leave_balances (
  tenant_id        bigint       NOT NULL,
  id               bigint GENERATED ALWAYS AS IDENTITY,
  employee_id      bigint       NOT NULL,
  leave_type_id    bigint       NOT NULL,
  leave_year       integer      NOT NULL CHECK (leave_year BETWEEN 2000 AND 2100),
  opening          numeric(7,2) NOT NULL DEFAULT 0,
  accrued          numeric(7,2) NOT NULL DEFAULT 0,
  carried_forward  numeric(7,2) NOT NULL DEFAULT 0,
  adjusted         numeric(7,2) NOT NULL DEFAULT 0,   -- manual credits minus manual debits
  comp_off         numeric(7,2) NOT NULL DEFAULT 0,
  used             numeric(7,2) NOT NULL DEFAULT 0 CHECK (used >= 0),
  pending          numeric(7,2) NOT NULL DEFAULT 0 CHECK (pending >= 0),
  expired          numeric(7,2) NOT NULL DEFAULT 0,
  encashed         numeric(7,2) NOT NULL DEFAULT 0,
  carried_out      numeric(7,2) NOT NULL DEFAULT 0,   -- moved to next year's balance
  available        numeric(8,2) GENERATED ALWAYS AS (
                     opening + accrued + carried_forward + adjusted + comp_off
                     - used - pending - expired - encashed - carried_out) STORED,
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, leave_type_id, leave_year),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id)
);
CREATE INDEX idx_leave_bal_type_year ON leave_balances (tenant_id, leave_type_id, leave_year);

-- ---------------------------------------------- leave_balance_transactions ----
CREATE TABLE leave_balance_transactions (
  tenant_id         bigint       NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  balance_id        bigint       NOT NULL,
  txn_type          varchar(30)  NOT NULL CHECK (txn_type IN (
                      'OPENING_BALANCE', 'ACCRUAL', 'LEAVE_HOLD', 'LEAVE_HOLD_RELEASE',
                      'LEAVE_CONSUMPTION', 'LEAVE_REVERSAL', 'CARRY_FORWARD', 'CARRY_FORWARD_OUT',
                      'EXPIRY', 'MANUAL_CREDIT', 'MANUAL_DEBIT', 'COMP_OFF_CREDIT', 'ENCASHMENT')),
  days              numeric(7,2) NOT NULL CHECK (days > 0),   -- direction comes from txn_type
  effective_date    date         NOT NULL,
  expires_on        date,
  leave_request_id  bigint,
  idempotency_key   varchar(200) NOT NULL,
  note              text,
  created_by        bigint,                                   -- NULL = system job
  created_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, balance_id)       REFERENCES leave_balances(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)       REFERENCES tenant_users(tenant_id, user_id),
  CONSTRAINT uq_leave_txn_idempotency UNIQUE (tenant_id, idempotency_key),
  CHECK (txn_type NOT IN ('LEAVE_HOLD', 'LEAVE_HOLD_RELEASE', 'LEAVE_CONSUMPTION', 'LEAVE_REVERSAL')
         OR leave_request_id IS NOT NULL),
  CHECK (txn_type IN ('CARRY_FORWARD', 'COMP_OFF_CREDIT') OR expires_on IS NULL)
);
CREATE INDEX idx_leave_txn_balance ON leave_balance_transactions (tenant_id, balance_id, created_at, id);
CREATE INDEX idx_leave_txn_request ON leave_balance_transactions (tenant_id, leave_request_id);
CREATE INDEX idx_leave_txn_expiring ON leave_balance_transactions (tenant_id, expires_on)
  WHERE expires_on IS NOT NULL;
CREATE TRIGGER trg_leave_txn_append_only BEFORE UPDATE OR DELETE ON leave_balance_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- Effect of one ledger row on the available balance. Used for running balances
-- on statements; bucket reconciliation is in v_leave_balance_drift.
CREATE FUNCTION leave_txn_available_delta(p_type varchar, p_days numeric)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN p_type IN ('OPENING_BALANCE', 'ACCRUAL', 'CARRY_FORWARD', 'MANUAL_CREDIT',
                              'COMP_OFF_CREDIT', 'LEAVE_HOLD_RELEASE', 'LEAVE_REVERSAL')
              THEN p_days ELSE -p_days END
$$;

-- The only writer of balance buckets. AFTER INSERT so that an idempotent
-- INSERT .. ON CONFLICT DO NOTHING cannot apply the same row twice.
-- SECURITY DEFINER: the API role has no UPDATE on the buckets.
CREATE FUNCTION leave_apply_txn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE leave_balances b
     SET opening         = b.opening         + CASE WHEN NEW.txn_type = 'OPENING_BALANCE' THEN NEW.days ELSE 0 END,
         accrued         = b.accrued         + CASE WHEN NEW.txn_type = 'ACCRUAL' THEN NEW.days ELSE 0 END,
         carried_forward = b.carried_forward + CASE WHEN NEW.txn_type = 'CARRY_FORWARD' THEN NEW.days ELSE 0 END,
         adjusted        = b.adjusted        + CASE NEW.txn_type WHEN 'MANUAL_CREDIT' THEN NEW.days
                                                                 WHEN 'MANUAL_DEBIT' THEN -NEW.days ELSE 0 END,
         comp_off        = b.comp_off        + CASE WHEN NEW.txn_type = 'COMP_OFF_CREDIT' THEN NEW.days ELSE 0 END,
         used            = b.used            + CASE NEW.txn_type WHEN 'LEAVE_CONSUMPTION' THEN NEW.days
                                                                 WHEN 'LEAVE_REVERSAL' THEN -NEW.days ELSE 0 END,
         pending         = b.pending         + CASE NEW.txn_type WHEN 'LEAVE_HOLD' THEN NEW.days
                                                                 WHEN 'LEAVE_HOLD_RELEASE' THEN -NEW.days ELSE 0 END,
         expired         = b.expired         + CASE WHEN NEW.txn_type = 'EXPIRY' THEN NEW.days ELSE 0 END,
         encashed        = b.encashed        + CASE WHEN NEW.txn_type = 'ENCASHMENT' THEN NEW.days ELSE 0 END,
         carried_out     = b.carried_out     + CASE WHEN NEW.txn_type = 'CARRY_FORWARD_OUT' THEN NEW.days ELSE 0 END,
         updated_at      = now()
   WHERE b.tenant_id = NEW.tenant_id AND b.id = NEW.balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Leave balance % not found', NEW.balance_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_leave_txn_apply AFTER INSERT ON leave_balance_transactions
  FOR EACH ROW EXECUTE FUNCTION leave_apply_txn();

-- Reconciliation: should always return zero rows.
CREATE VIEW v_leave_balance_drift WITH (security_invoker = true) AS
SELECT b.tenant_id, b.id AS balance_id, b.employee_id, b.leave_type_id, b.leave_year,
       b.available AS projected_available,
       COALESCE(SUM(leave_txn_available_delta(t.txn_type, t.days)), 0) AS ledger_available
  FROM leave_balances b
  LEFT JOIN leave_balance_transactions t ON t.tenant_id = b.tenant_id AND t.balance_id = b.id
 GROUP BY b.tenant_id, b.id
HAVING b.opening         <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'OPENING_BALANCE'), 0)
    OR b.accrued         <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'ACCRUAL'), 0)
    OR b.carried_forward <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'CARRY_FORWARD'), 0)
    OR b.adjusted        <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'MANUAL_CREDIT'), 0)
                          - COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'MANUAL_DEBIT'), 0)
    OR b.comp_off        <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'COMP_OFF_CREDIT'), 0)
    OR b.used            <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'LEAVE_CONSUMPTION'), 0)
                          - COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'LEAVE_REVERSAL'), 0)
    OR b.pending         <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'LEAVE_HOLD'), 0)
                          - COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'LEAVE_HOLD_RELEASE'), 0)
    OR b.expired         <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'EXPIRY'), 0)
    OR b.encashed        <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'ENCASHMENT'), 0)
    OR b.carried_out     <> COALESCE(SUM(t.days) FILTER (WHERE t.txn_type = 'CARRY_FORWARD_OUT'), 0);

-- ------------------------------------------------- leave_request_cancellations --
-- Who cancelled approved or in-flight leave, why, and which reversal it produced.
CREATE TABLE leave_request_cancellations (
  tenant_id         bigint       NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  leave_request_id  bigint       NOT NULL,
  previous_status   varchar(20)  NOT NULL,
  days_reversed     numeric(6,2) NOT NULL DEFAULT 0 CHECK (days_reversed >= 0),
  reason            text         NOT NULL,
  is_hr_action      boolean      NOT NULL DEFAULT false,
  cancelled_by      bigint       NOT NULL,
  cancelled_at      timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, leave_request_id),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, cancelled_by)     REFERENCES tenant_users(tenant_id, user_id)
);
CREATE TRIGGER trg_leave_cancel_append_only BEFORE UPDATE OR DELETE ON leave_request_cancellations
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- --------------------------------------------------- leave_accrual_postings ----
-- One row per rule / employee / period, whether days were credited or the
-- maximum balance capped them. Without it a capped period would be credited by
-- a later run, once the employee had used some leave.
CREATE TABLE leave_accrual_postings (
  tenant_id         bigint       NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  accrual_rule_id   bigint       NOT NULL,
  employee_id       bigint       NOT NULL,
  period_key        varchar(20)  NOT NULL,
  scheduled_days    numeric(6,2) NOT NULL CHECK (scheduled_days >= 0),
  credited_days     numeric(6,2) NOT NULL CHECK (credited_days >= 0),
  created_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT uq_leave_accrual_period UNIQUE (tenant_id, accrual_rule_id, employee_id, period_key),
  FOREIGN KEY (tenant_id, accrual_rule_id) REFERENCES leave_accrual_rules(tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)     REFERENCES employees(tenant_id, id)
);
CREATE TRIGGER trg_leave_accrual_postings_append_only BEFORE UPDATE OR DELETE ON leave_accrual_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ---------------------------------------------------- leave_comp_off_claims ----
CREATE TABLE leave_comp_off_claims (
  tenant_id      bigint       NOT NULL,
  id             bigint GENERATED ALWAYS AS IDENTITY,
  employee_id    bigint       NOT NULL,
  rule_id        bigint       NOT NULL,
  work_date      date         NOT NULL,
  work_day_type  varchar(12)  NOT NULL CHECK (work_day_type IN ('working', 'weekly_off', 'holiday')),
  hours_worked   numeric(4,2) NOT NULL CHECK (hours_worked > 0 AND hours_worked <= 24),
  earned_days    numeric(4,2) NOT NULL CHECK (earned_days > 0),
  reason         text         NOT NULL,
  status         varchar(20)  NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  expires_on     date,
  claimed_by     bigint       NOT NULL,
  decided_by     bigint,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id) REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, rule_id)     REFERENCES leave_comp_off_rules(tenant_id, id),
  FOREIGN KEY (tenant_id, claimed_by)  REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, decided_by)  REFERENCES tenant_users(tenant_id, user_id),
  CHECK ((status = 'pending') = (decided_at IS NULL))
);
-- One live claim per worked date; a rejected claim may be corrected and claimed again.
CREATE UNIQUE INDEX uq_leave_comp_off_date ON leave_comp_off_claims (tenant_id, employee_id, work_date)
  WHERE status IN ('pending', 'approved');
CREATE INDEX idx_leave_comp_off_status ON leave_comp_off_claims (tenant_id, status, created_at DESC);

-- --------------------------------------------------------- leave_audit_log ----
CREATE TABLE leave_audit_log (
  tenant_id      bigint       NOT NULL REFERENCES tenants(id),
  id             bigint GENERATED ALWAYS AS IDENTITY,
  actor_user_id  bigint       NOT NULL,
  action         varchar(60)  NOT NULL CHECK (action ~ '^[a-z_]+(\.[a-z_]+)+$'),
  target_type    varchar(40)  NOT NULL,
  target_id      bigint,
  before_state   jsonb,
  after_state    jsonb,
  request_id     text,
  at             timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES tenant_users(tenant_id, user_id)
);
CREATE INDEX idx_leave_audit_at ON leave_audit_log (tenant_id, at DESC);
CREATE INDEX idx_leave_audit_target ON leave_audit_log (tenant_id, target_type, target_id, at DESC);
CREATE TRIGGER trg_leave_audit_append_only BEFORE UPDATE OR DELETE ON leave_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- ------------------------------------------------------------------- RLS ----
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_requests', 'leave_request_days', 'leave_request_attachments', 'leave_balances',
    'leave_balance_transactions', 'leave_request_cancellations', 'leave_accrual_postings',
    'leave_comp_off_claims', 'leave_audit_log'
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
GRANT SELECT, INSERT, UPDATE ON leave_requests, leave_comp_off_claims TO hrms_app;
GRANT SELECT, INSERT ON leave_request_days, leave_request_cancellations,
  leave_accrual_postings, leave_balance_transactions, leave_audit_log TO hrms_app;

GRANT SELECT, INSERT, DELETE ON leave_request_attachments TO hrms_app;   -- DELETE: unlinked uploads only
GRANT UPDATE (leave_request_id) ON leave_request_attachments TO hrms_app;

-- Balance rows start at zero: the API can create one but never set a bucket.
-- UPDATE (updated_at) exists only because SELECT .. FOR UPDATE requires it.
GRANT SELECT ON leave_balances TO hrms_app;
GRANT INSERT (tenant_id, employee_id, leave_type_id, leave_year) ON leave_balances TO hrms_app;
GRANT UPDATE (updated_at) ON leave_balances TO hrms_app;

GRANT SELECT ON v_leave_balance_drift TO hrms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hrms_app;

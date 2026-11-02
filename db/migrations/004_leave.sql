-- =============================================================================
-- 004 — Leave management
-- Fixes vs. original design:
--   * total_days is computed by the server (weekly offs, holidays, half days).
--     The doc accepted totalDays from the client: its own example
--     (2026-11-05 .. 2026-11-09, "5 days") spans a weekend = 3 working days.
--   * leave_type is a tenant-configured table, not free text.
--   * Balances are per leave period (year). The original UNIQUE
--     (tenant, employee, leave_type) made yearly allocation / carry-forward
--     impossible.
--   * Days are RESERVED on submit (pending bucket) and moved to USED on final
--     approval. The doc only debited at final approval, so two concurrent
--     pending requests could both pass the balance check and overdraw.
--   * The ledger is the source of truth; leave_balances is a projection that
--     only the ledger trigger can update (app role has no UPDATE on it).
--   * Ledger idempotency: one row per (request, txn_type) — a retried approval
--     cannot debit twice.
--   * Overlapping active leave for the same employee is rejected by an
--     exclusion constraint (race-proof, unlike an application check).
--   * Status adds 'returned' and 'withdrawn' to match the workflow outcomes.
-- =============================================================================

CREATE TABLE leave_types (
  tenant_id        bigint       NOT NULL REFERENCES tenants(id),
  id               bigint GENERATED ALWAYS AS IDENTITY,
  code             varchar(30)  NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]*$'),
  name             varchar(100) NOT NULL,
  allow_half_day   boolean      NOT NULL DEFAULT true,
  allow_negative   boolean      NOT NULL DEFAULT false,
  max_negative     numeric(6,2) NOT NULL DEFAULT 0 CHECK (max_negative >= 0),
  max_days_per_request numeric(6,2) CHECK (max_days_per_request IS NULL OR max_days_per_request > 0),
  is_active        boolean      NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);

CREATE TABLE holidays (
  tenant_id     bigint       NOT NULL REFERENCES tenants(id),
  id            bigint GENERATED ALWAYS AS IDENTITY,
  holiday_date  date         NOT NULL,
  name          varchar(150) NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, holiday_date)
);

CREATE TABLE leave_balances (
  tenant_id      bigint       NOT NULL,
  id             bigint GENERATED ALWAYS AS IDENTITY,
  employee_id    bigint       NOT NULL,
  leave_type_id  bigint       NOT NULL,
  period_year    int          NOT NULL CHECK (period_year BETWEEN 2000 AND 2100),
  allocated      numeric(6,2) NOT NULL DEFAULT 0,
  used           numeric(6,2) NOT NULL DEFAULT 0 CHECK (used >= 0),
  pending        numeric(6,2) NOT NULL DEFAULT 0 CHECK (pending >= 0),
  available      numeric(6,2) GENERATED ALWAYS AS (allocated - used - pending) STORED,
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, employee_id, leave_type_id, period_year),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id)
);

CREATE TABLE leave_requests (
  tenant_id             bigint       NOT NULL,
  id                    bigint GENERATED ALWAYS AS IDENTITY,
  employee_id           bigint       NOT NULL,
  leave_type_id         bigint       NOT NULL,
  start_date            date         NOT NULL,
  end_date              date         NOT NULL,
  start_session         varchar(12)  NOT NULL DEFAULT 'full'
                        CHECK (start_session IN ('full', 'second_half')),
  end_session           varchar(12)  NOT NULL DEFAULT 'full'
                        CHECK (end_session IN ('full', 'first_half')),
  total_days            numeric(6,2) NOT NULL CHECK (total_days > 0),
  period_year           int          NOT NULL,
  reason                text,
  status                varchar(20)  NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'returned', 'approved', 'rejected',
                          'withdrawn', 'cancelled')),
  workflow_instance_id  bigint,
  applied_by            bigint       NOT NULL,
  idempotency_key       uuid,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, employee_id)   REFERENCES employees(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_type_id) REFERENCES leave_types(tenant_id, id),
  FOREIGN KEY (tenant_id, applied_by)    REFERENCES tenant_users(tenant_id, user_id),
  FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES workflow_instances(tenant_id, id),
  UNIQUE (tenant_id, employee_id, idempotency_key),
  CHECK (end_date >= start_date),
  CHECK (period_year = extract(year FROM start_date)::int
         AND period_year = extract(year FROM end_date)::int),
  CHECK (NOT (start_date = end_date AND start_session = 'second_half'
              AND end_session = 'first_half')),
  CONSTRAINT ex_leave_no_overlap EXCLUDE USING gist (
    tenant_id   WITH =,
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('pending', 'returned', 'approved'))
);
CREATE INDEX idx_leave_employee ON leave_requests (tenant_id, employee_id, start_date DESC);
CREATE INDEX idx_leave_status   ON leave_requests (tenant_id, status);
CREATE TRIGGER trg_leave_updated BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION leave_guard_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'returned', 'withdrawn'))
    OR (OLD.status = 'returned' AND NEW.status IN ('pending', 'withdrawn'))
    OR (OLD.status = 'approved' AND NEW.status = 'cancelled')
  ) THEN
    RAISE EXCEPTION 'Illegal leave transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_leave_transition
  BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION leave_guard_transition();

-- ------------------------------------------------ leave_balance_transactions --
-- Signed deltas per bucket; SUM(deltas) == balance row, always.
CREATE TABLE leave_balance_transactions (
  tenant_id         bigint       NOT NULL,
  id                bigint GENERATED ALWAYS AS IDENTITY,
  balance_id        bigint       NOT NULL,
  leave_request_id  bigint,
  txn_type          varchar(20)  NOT NULL CHECK (txn_type IN (
                      'allocation', 'reserve', 'release', 'debit', 'credit',
                      'adjustment', 'carry_forward', 'lapse')),
  allocated_delta   numeric(6,2) NOT NULL DEFAULT 0,
  used_delta        numeric(6,2) NOT NULL DEFAULT 0,
  pending_delta     numeric(6,2) NOT NULL DEFAULT 0,
  note              text,
  created_by        bigint,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, balance_id)       REFERENCES leave_balances(tenant_id, id),
  FOREIGN KEY (tenant_id, leave_request_id) REFERENCES leave_requests(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by)       REFERENCES tenant_users(tenant_id, user_id),
  CHECK (allocated_delta <> 0 OR used_delta <> 0 OR pending_delta <> 0),
  CHECK (txn_type NOT IN ('reserve', 'release', 'debit', 'credit') OR leave_request_id IS NOT NULL)
);
-- Idempotency: each request can be reserved/released/debited/credited once.
CREATE UNIQUE INDEX uq_leave_txn_once_per_request
  ON leave_balance_transactions (tenant_id, leave_request_id, txn_type)
  WHERE leave_request_id IS NOT NULL;
CREATE INDEX idx_leave_txn_balance ON leave_balance_transactions (tenant_id, balance_id, created_at);

CREATE TRIGGER trg_leave_txn_append_only
  BEFORE UPDATE OR DELETE ON leave_balance_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_modification();

-- The only writer of leave_balances buckets. SECURITY DEFINER so the app
-- role needs no UPDATE grant on leave_balances. RLS still applies (FORCE),
-- so the update stays inside the current tenant.
CREATE OR REPLACE FUNCTION leave_apply_txn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE leave_balances
     SET allocated  = allocated + NEW.allocated_delta,
         used       = used      + NEW.used_delta,
         pending    = pending   + NEW.pending_delta,
         updated_at = now()
   WHERE tenant_id = NEW.tenant_id AND id = NEW.balance_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Leave balance % not found', NEW.balance_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_leave_txn_apply
  AFTER INSERT ON leave_balance_transactions
  FOR EACH ROW EXECUTE FUNCTION leave_apply_txn();

-- Reconciliation view: should always return zero rows.
CREATE VIEW v_leave_balance_drift WITH (security_invoker = true) AS
SELECT b.tenant_id, b.id AS balance_id,
       b.allocated, COALESCE(SUM(t.allocated_delta), 0) AS ledger_allocated,
       b.used,      COALESCE(SUM(t.used_delta), 0)      AS ledger_used,
       b.pending,   COALESCE(SUM(t.pending_delta), 0)   AS ledger_pending
FROM leave_balances b
LEFT JOIN leave_balance_transactions t
  ON t.tenant_id = b.tenant_id AND t.balance_id = b.id
GROUP BY b.tenant_id, b.id
HAVING b.allocated <> COALESCE(SUM(t.allocated_delta), 0)
    OR b.used      <> COALESCE(SUM(t.used_delta), 0)
    OR b.pending   <> COALESCE(SUM(t.pending_delta), 0);

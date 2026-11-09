-- =============================================================================
-- 015 — Comp off claims are approved through the workflow engine
--   * Claims used to wait for anyone holding leave.request.manage, outside the
--     engine, so the reporting manager never saw them. They now start a
--     workflow instance (module 'comp_off') with its own published definition,
--     which HR configures under Approval Workflows like the leave one.
--   * A claim can be returned for information and resubmitted, or withdrawn,
--     the same as a leave request. A status guard keeps transitions legal.
--   * Credit still happens only on final approval, in the engine's transaction.
--   * Existing pending claims have no instance; they are routed by the
--     application once a comp off workflow is published.
-- =============================================================================

ALTER TABLE leave_comp_off_claims
  ADD COLUMN workflow_instance_id bigint,
  ADD CONSTRAINT fk_comp_off_claim_instance
      FOREIGN KEY (tenant_id, workflow_instance_id) REFERENCES workflow_instances(tenant_id, id);

ALTER TABLE leave_comp_off_claims DROP CONSTRAINT leave_comp_off_claims_status_check;
ALTER TABLE leave_comp_off_claims ADD CONSTRAINT leave_comp_off_claims_status_check
  CHECK (status IN ('pending', 'returned', 'approved', 'rejected', 'withdrawn'));

-- Undecided while pending or returned; decided once approved, rejected or withdrawn.
ALTER TABLE leave_comp_off_claims DROP CONSTRAINT leave_comp_off_claims_check;
ALTER TABLE leave_comp_off_claims ADD CONSTRAINT ck_comp_off_claim_decided
  CHECK ((status IN ('pending', 'returned')) = (decided_at IS NULL));

-- A returned claim still holds its worked date.
DROP INDEX uq_leave_comp_off_date;
CREATE UNIQUE INDEX uq_leave_comp_off_date ON leave_comp_off_claims (tenant_id, employee_id, work_date)
  WHERE status IN ('pending', 'returned', 'approved');
CREATE INDEX idx_comp_off_claim_instance ON leave_comp_off_claims (tenant_id, workflow_instance_id);

CREATE FUNCTION leave_guard_comp_off_claim() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NOT (
       (OLD.status = 'pending'  AND NEW.status IN ('approved', 'rejected', 'returned', 'withdrawn'))
    OR (OLD.status = 'returned' AND NEW.status IN ('pending', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'Illegal comp off claim transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_comp_off_claim_guard BEFORE UPDATE ON leave_comp_off_claims
  FOR EACH ROW EXECUTE FUNCTION leave_guard_comp_off_claim();

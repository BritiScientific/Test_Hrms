-- @destructive
-- =============================================================================
-- 011 — Remove the first Leave Management implementation
--
--   THIS DELETES DATA. Leave requests, balances, ledger history, leave types and
--   holidays are removed, NOT migrated: 012-014 replace them with a new design.
--   `npm run db:migrate` takes a pg_dump first because of the @destructive marker.
--
--   Workflow tables keep their structure and history. Active leave instances
--   would point at requests that no longer exist (and block the new requests
--   that reuse their ids, see uq_wf_instance_active_entity), so they are closed
--   here through the same transitions the engine uses.
--
--   No CASCADE: an unexpected dependency should fail this migration, not vanish.
-- =============================================================================

-- ------------------------------------------- close in-flight leave workflows --
INSERT INTO workflow_action_logs (tenant_id, workflow_instance_id, action, step_order, cycle,
                                  from_status, to_status, comments, metadata)
SELECT i.tenant_id, i.id, 'cancel', i.current_step_order, i.cycle, i.status, 'cancelled',
       'Closed by the Leave Management replacement', '{"migration": "011_leave_remove_legacy"}'::jsonb
  FROM workflow_instances i
 WHERE i.module = 'leave' AND i.status IN ('pending', 'returned');

UPDATE workflow_tasks t
   SET status = 'cancelled', acted_at = now()
  FROM workflow_instances i
 WHERE i.tenant_id = t.tenant_id AND i.id = t.workflow_instance_id
   AND i.module = 'leave' AND i.status IN ('pending', 'returned')
   AND t.status = 'pending';

UPDATE workflow_instances
   SET status = 'cancelled', completed_at = now()
 WHERE module = 'leave' AND status IN ('pending', 'returned');

-- Notifications about requests that are about to disappear must not be sent.
UPDATE outbox_events
   SET processed_at = now(), last_error = 'Skipped: Leave Management replaced by migration 011'
 WHERE processed_at IS NULL
   AND (aggregate_type = 'leave_request'
        OR (payload ->> 'module' = 'leave' AND aggregate_type IN ('workflow_task', 'workflow_instance')));

-- ------------------------------------------------------------- drop objects --
DROP VIEW v_leave_balance_drift;
DROP TABLE leave_balance_transactions;   -- trg_leave_txn_append_only, trg_leave_txn_apply, RLS policy
DROP TABLE leave_requests;               -- ex_leave_no_overlap, trg_leave_updated, trg_leave_transition, RLS policy
DROP TABLE leave_balances;
DROP TABLE holidays;
DROP TABLE leave_types;
DROP FUNCTION leave_apply_txn();
DROP FUNCTION leave_guard_transition();

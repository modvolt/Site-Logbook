-- Full rollback for migration 0094_steep_black_widow.
--
-- Application rollback is preferred: old code can safely ignore these
-- additive columns. Full removal is allowed only before the feature has been
-- used, because dropping the columns after an exclusion was recorded would
-- silently put that job back into the billing queue.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM jobs
    WHERE billing_intent <> 'billable'
       OR billing_exclusion_reason IS NOT NULL
       OR billing_intent_changed_at IS NOT NULL
       OR billing_intent_changed_by_user_id IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM audit_log
    WHERE action = 'job_billing_intent_changed'
  ) THEN
    RAISE EXCEPTION
      'Rollback 0094 blocked: billing intent has already been used. Revert application code and keep the additive columns, or review and export the audit history manually.';
  END IF;
END
$$;

DROP INDEX IF EXISTS jobs_billing_intent_idx;
ALTER TABLE jobs
  DROP CONSTRAINT IF EXISTS jobs_billing_exclusion_reason_check,
  DROP CONSTRAINT IF EXISTS jobs_billing_intent_check,
  DROP CONSTRAINT IF EXISTS jobs_billing_intent_changed_by_user_id_users_id_fk,
  DROP COLUMN IF EXISTS billing_intent_changed_by_user_id,
  DROP COLUMN IF EXISTS billing_intent_changed_at,
  DROP COLUMN IF EXISTS billing_exclusion_reason,
  DROP COLUMN IF EXISTS billing_intent;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785167642005;

COMMIT;

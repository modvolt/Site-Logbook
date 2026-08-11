-- Full rollback for migration 0097_session_and_api_idempotency.
--
-- Application rollback is preferred. Removing session_generation after any
-- revocation advanced it could re-enable stale sessions, and dropping a used
-- idempotency ledger would erase the durable duplicate-prevention evidence.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE session_generation <> 1
  ) THEN
    RAISE EXCEPTION
      'Rollback 0097 blocked: session generations have already advanced. Revert application code and keep the additive security foundation.';
  END IF;

  IF EXISTS (SELECT 1 FROM api_idempotency_records LIMIT 1) THEN
    RAISE EXCEPTION
      'Rollback 0097 blocked: the idempotency ledger already contains records. Revert application code and keep the additive security foundation.';
  END IF;
END
$$;

DROP TABLE IF EXISTS api_idempotency_records;
ALTER TABLE users DROP COLUMN IF EXISTS session_generation;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383360000;

COMMIT;

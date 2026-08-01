-- Full rollback for migration 0097_api_idempotency_records.
--
-- Application rollback is preferred: the previous application safely ignores
-- this additive table. Dropping it after any replay was registered would erase
-- the only durable evidence preventing a duplicate, so destructive rollback is
-- allowed only while the ledger is still empty.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM api_idempotency_records LIMIT 1) THEN
    RAISE EXCEPTION
      'Rollback 0097 blocked: the offline idempotency ledger already contains records. Revert application code and keep the additive table.';
  END IF;
END
$$;

DROP TABLE IF EXISTS api_idempotency_records;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785615206350;

COMMIT;

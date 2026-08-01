-- Application rollback is preferred: old application versions ignore this
-- additive ledger. Dropping it after any upload would erase orphan/quarantine
-- evidence, so destructive rollback is allowed only while the table is empty.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM object_uploads LIMIT 1) THEN
    RAISE EXCEPTION
      'Rollback 0098 blocked: object_uploads contains evidence. Revert application code and keep the additive table.';
  END IF;
END
$$;

DROP TABLE IF EXISTS object_uploads;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785618959339;

COMMIT;

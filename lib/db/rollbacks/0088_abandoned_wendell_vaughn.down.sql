-- Manual rollback for migration 0088_abandoned_wendell_vaughn.
--
-- The old application safely ignores these additive columns, so an
-- application rollback does not require this SQL. Run it only while the API
-- is stopped and only if no visit-specific time has been entered.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "job_visits"
    WHERE "start_time" IS NOT NULL OR "end_time" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0088 blocked: visit-specific times exist. Keep the additive columns or clear the values explicitly after export.';
  END IF;
END $$;

DROP INDEX IF EXISTS "job_visits_job_date_idx";
DROP INDEX IF EXISTS "job_visits_date_idx";
ALTER TABLE "job_visits" DROP COLUMN IF EXISTS "updated_at";
ALTER TABLE "job_visits" DROP COLUMN IF EXISTS "end_time";
ALTER TABLE "job_visits" DROP COLUMN IF EXISTS "start_time";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1783984064694;

COMMIT;

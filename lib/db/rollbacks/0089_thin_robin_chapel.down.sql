-- Manual rollback for migration 0089_thin_robin_chapel.
--
-- The previous application safely ignores the additive column, so an
-- application rollback does not require this SQL. Run it only with the API
-- stopped and only before any quote has been converted to a job group.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "quotes"
    WHERE "converted_to_job_group_id" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0089 blocked: quote-to-job-group links exist. Keep the additive column or unlink records manually only after a verified export.';
  END IF;
END $$;

DROP INDEX IF EXISTS "quotes_converted_job_group_uidx";
ALTER TABLE "quotes" DROP CONSTRAINT IF EXISTS "quotes_converted_to_job_group_id_job_groups_id_fk";
ALTER TABLE "quotes" DROP COLUMN IF EXISTS "converted_to_job_group_id";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1783986815471;

COMMIT;

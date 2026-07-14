-- Manual rollback for migration 0086_quick_imperial_guard.
--
-- This intentionally refuses to run while any archive metadata remains.
-- Dropping the columns in that state would lose which jobs are hidden, who
-- archived them or which status must be restored. Clear the metadata only
-- through the application, then run this script while the API is stopped.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "jobs"
    WHERE "archived_at" IS NOT NULL
       OR "archived_by_user_id" IS NOT NULL
       OR "status_before_archive" IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0086 blocked: archive metadata exists. Restore affected jobs and verify all three archive columns are empty.';
  END IF;
END $$;

DROP INDEX IF EXISTS "jobs_archived_at_idx";
ALTER TABLE "jobs" DROP CONSTRAINT IF EXISTS "jobs_archived_by_user_id_users_id_fk";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "status_before_archive";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "archived_by_user_id";
ALTER TABLE "jobs" DROP COLUMN IF EXISTS "archived_at";

-- Allow a later redeploy of the forward migration. Without removing this row,
-- Drizzle would consider 0086 applied even though its columns were dropped.
DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1783979822106;

COMMIT;

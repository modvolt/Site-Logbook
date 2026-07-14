-- Manual rollback for migration 0087_chief_marvel_apes.
--
-- Run only together with an application rollback while the API is stopped.
-- It refuses to remove the new audit columns if planned materials or
-- non-reconstructable consumption audit exists. Legacy application code would
-- treat planned rows as consumed, while dropping real audit data would lose
-- who consumed the material and its actual consumption time.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "materials" WHERE "done" = false) THEN
    RAISE EXCEPTION
      'Rollback 0087 blocked: planned materials exist. Consume or delete them before reverting the workflow.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "materials"
    WHERE "consumed_by_user_id" IS NOT NULL
       OR (
         "consumed_at" IS NOT NULL
         AND "consumed_at" IS DISTINCT FROM "created_at"
       )
  ) THEN
    RAISE EXCEPTION
      'Rollback 0087 blocked: non-legacy consumption audit exists. Keep the additive columns or preserve the audit in a compatible schema.';
  END IF;
END $$;

DROP INDEX IF EXISTS "materials_consumed_at_idx";
ALTER TABLE "materials" DROP CONSTRAINT IF EXISTS "materials_consumed_by_user_id_users_id_fk";
ALTER TABLE "materials" DROP COLUMN IF EXISTS "consumed_by_user_id";
ALTER TABLE "materials" DROP COLUMN IF EXISTS "consumed_at";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1783981467968;

COMMIT;

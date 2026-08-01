-- Full rollback for migration 0096_daffy_puppet_master.
--
-- Application rollback is preferred: the prior application safely ignores the
-- additive column. Removing it is allowed only before any revocation has
-- advanced the generation, otherwise stale sessions could become valid again.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM users
    WHERE session_generation <> 1
  ) THEN
    RAISE EXCEPTION
      'Rollback 0096 blocked: session generations have already advanced. Revert application code and keep the additive column.';
  END IF;
END
$$;

ALTER TABLE users DROP COLUMN IF EXISTS session_generation;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785604750584;

COMMIT;

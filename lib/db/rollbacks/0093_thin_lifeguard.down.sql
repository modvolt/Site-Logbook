-- Full rollback for migration 0093_thin_lifeguard.
--
-- Application rollback is preferred: leaving this additive column in place is
-- harmless and every existing invoice uses the "detailed" default. Dropping it
-- only removes the saved customer-facing material layout; source invoice lines,
-- material reservations, warehouse movements and issued PDFs remain unchanged.

BEGIN;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS material_display_mode;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785164749948;

COMMIT;

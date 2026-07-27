-- Full rollback for migration 0092_sparkling_scourge.
--
-- Application rollback is preferred because leaving this additive column in
-- place is harmless. Dropping it only removes the saved default transport rate;
-- job kilometres, manual transport prices and issued invoice lines remain.

BEGIN;

ALTER TABLE billing_settings
  DROP COLUMN IF EXISTS transport_rate_per_km;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1785163125205;

COMMIT;

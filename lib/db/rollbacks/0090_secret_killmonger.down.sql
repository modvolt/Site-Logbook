-- Manual rollback for migration 0090_secret_killmonger.
--
-- The previous application ignores this additive table. Prefer an application
-- rollback and keep the table whenever even one billing lifecycle row exists.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "quote_invoice_links") THEN
    RAISE EXCEPTION
      'Rollback 0090 blocked: quote invoice history exists. Keep the additive table or archive it only after a verified export.';
  END IF;
END $$;

DROP TABLE "quote_invoice_links";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1783988026596;

COMMIT;

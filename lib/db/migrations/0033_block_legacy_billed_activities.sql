-- Neutralize legacy/cosmetic activity billing_status = 'billed' rows that are
-- NOT backed by an actual invoice link.
--
-- The authoritative billed state of an activity is derived from
-- invoice_source_links (a non-cancelled invoice referencing the activity), not
-- from the cosmetic billing_status column. The activities update endpoint no
-- longer accepts a manual billing_status = 'billed' (only billable /
-- not_billable / null are editable intents), but historical rows may still
-- carry a stale 'billed' value with no matching invoice link — which would
-- otherwise misrepresent intent. Reset those to NULL so the editable intent is
-- consistent everywhere; rows that ARE linked to a live invoice keep 'billed'.
--
-- Idempotent: the WHERE filter only touches stale, unlinked 'billed' rows, so
-- re-running this migration is a safe no-op.

UPDATE "activities" a
SET "billing_status" = NULL, "updated_at" = now()
WHERE a."billing_status" = 'billed'
  AND NOT EXISTS (
    SELECT 1
    FROM "invoice_source_links" isl
    JOIN "invoices" i ON i."id" = isl."invoice_id"
    WHERE isl."activity_id" = a."id"
      AND i."status" <> 'cancelled'
  );

-- Backfill synthetic price-history rows for warehouse items that have a
-- purchase_price set but no warehouse_price_history entries yet.
--
-- Items stocked via manual import, direct PATCH, or the opening-balance
-- migration (0018) may have a purchase_price on the item but no corresponding
-- warehouse_price_history row, so OUT movements fall back to a potentially
-- stale item.purchase_price rather than a proper historical price chain.
--
-- This migration seeds one synthetic history row per affected item using the
-- item's purchase_price and created_at as the best available proxy for when
-- that price was first known.
--
-- Idempotent: the NOT EXISTS guard skips any item that already has at least
-- one history row (e.g. from an approved cost document), so re-running this
-- migration is a safe no-op.

INSERT INTO "warehouse_price_history"
  ("warehouse_item_id", "purchase_price", "note", "created_by_name", "created_at")
SELECT
  wi."id",
  wi."purchase_price",
  'Počáteční nákupní cena',
  'Systém',
  wi."created_at"
FROM "warehouse_items" wi
WHERE wi."purchase_price" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "warehouse_price_history" ph
    WHERE ph."warehouse_item_id" = wi."id"
  );

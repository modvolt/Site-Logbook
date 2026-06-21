-- Opening-balance backfill for the stock movement ledger.
-- Existing warehouse_items rows carry an on-hand quantity that predates the
-- append-only movement ledger. Seed one "Počáteční stav" movement per item so
-- that quantity == sum(movements) from rollout onward; without this, the first
-- reconciled movement would recompute quantity to the movement sum and discard
-- the historical baseline.
--
-- Guarded by NOT EXISTS so it only seeds items that have no movements yet,
-- making it safe against items created after the ledger already existed.
INSERT INTO "warehouse_movements"
  ("warehouse_item_id", "direction", "quantity", "source_type", "source_id", "note", "created_by_name", "created_at")
SELECT
  wi."id",
  CASE WHEN wi."quantity" >= 0 THEN 'in' ELSE 'out' END,
  ABS(wi."quantity"),
  'manual',
  NULL,
  'Počáteční stav',
  'Systém',
  now()
FROM "warehouse_items" wi
WHERE wi."quantity" IS NOT NULL
  AND wi."quantity" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "warehouse_movements" wm
    WHERE wm."warehouse_item_id" = wi."id"
  );

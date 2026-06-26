-- Backfill cost_price_at_time for historical OUT movements using price-history.
--
-- The earlier opening-balance migration set cost_price_at_time on OUT movements
-- from the item's *current* purchase_price — a best-effort approximation. Now
-- that warehouse_price_history records every purchase-price observation with a
-- timestamp, we can do better: for each OUT movement we find the most recent
-- price-history row for the same item whose created_at <= the movement's
-- created_at and update cost_price_at_time to that historical price.
--
-- Movements where no preceding price-history entry exists keep their existing
-- value (current purchase_price fallback or NULL — both already acceptable).
--
-- Idempotent: the WHERE filter skips rows that already carry the correct
-- historical price, so re-running this migration is a safe no-op.

UPDATE "warehouse_movements" wm
SET "cost_price_at_time" = ph."purchase_price"
FROM (
  SELECT DISTINCT ON (m."id")
    m."id"            AS movement_id,
    ph."purchase_price"
  FROM "warehouse_movements" m
  JOIN "warehouse_price_history" ph
    ON  ph."warehouse_item_id" = m."warehouse_item_id"
    AND ph."created_at"        <= m."created_at"
  WHERE m."direction" = 'out'
  ORDER BY m."id", ph."created_at" DESC
) best
WHERE wm."id" = best.movement_id
  AND wm."cost_price_at_time" IS DISTINCT FROM best."purchase_price";

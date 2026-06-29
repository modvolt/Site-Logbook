-- Add stable FK from job materials and activity materials to warehouse items.
-- ON DELETE SET NULL: if a warehouse card is ever deleted the material row stays
-- but loses its link (graceful degradation, no cascade loss).

ALTER TABLE "materials" ADD COLUMN "warehouse_item_id" integer REFERENCES "warehouse_items"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "activity_materials" ADD COLUMN "warehouse_item_id" integer REFERENCES "warehouse_items"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Conservative backfill: only match where exactly ONE warehouse item exists with
-- that name (case-insensitive). Ambiguous or unmatched rows stay NULL.
-- Report: run the duplicate-name query below to see what was skipped.
--   SELECT lower(name) AS name, count(*) FROM warehouse_items GROUP BY 1 HAVING count(*)>1;

UPDATE materials m
SET warehouse_item_id = wi.id
FROM warehouse_items wi
WHERE lower(m.name) = lower(wi.name)
  AND m.warehouse_item_id IS NULL
  AND (
    SELECT count(*) FROM warehouse_items wi2 WHERE lower(wi2.name) = lower(wi.name)
  ) = 1;--> statement-breakpoint

UPDATE activity_materials am
SET warehouse_item_id = wi.id
FROM warehouse_items wi
WHERE lower(am.name) = lower(wi.name)
  AND am.warehouse_item_id IS NULL
  AND (
    SELECT count(*) FROM warehouse_items wi2 WHERE lower(wi2.name) = lower(wi.name)
  ) = 1;

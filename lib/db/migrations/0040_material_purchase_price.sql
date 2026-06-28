-- Add purchase_price_per_unit to materials table.
-- Stores the unit cost from the linked billing document line for margin tracking.
ALTER TABLE "materials" ADD COLUMN "purchase_price_per_unit" numeric(10,2);

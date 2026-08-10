-- Full rollback for migration 0096_far_smiling_tiger.
--
-- Application rollback is preferred: old code safely ignores the additive
-- columns. Full removal is allowed only before any quote uses internal costs
-- or structural rows, because those values cannot be represented by old code.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM quote_items
    WHERE row_type <> 'item'
       OR purchase_unit_price IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'Rollback 0096 blocked: quote margins or structural rows have already been used. Revert application code and keep the additive columns, or export and review the quote data manually.';
  END IF;
END
$$;

ALTER TABLE quote_items
  DROP CONSTRAINT IF EXISTS quote_items_purchase_unit_price_check,
  DROP CONSTRAINT IF EXISTS quote_items_row_type_check,
  DROP COLUMN IF EXISTS purchase_unit_price,
  DROP COLUMN IF EXISTS row_type;

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786383352759;

COMMIT;

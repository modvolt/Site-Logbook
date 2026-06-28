-- Migration 0053: record error messages on failed recurring invoice generations
-- Makes invoice_id nullable (failed runs have no invoice) and adds error_message column.
-- Replaces the all-rows unique index with a partial index covering successful runs only.

ALTER TABLE recurring_invoice_generations
  ALTER COLUMN invoice_id DROP NOT NULL;

ALTER TABLE recurring_invoice_generations
  ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Drop old all-rows unique index and replace with partial (successes only)
DROP INDEX IF EXISTS rig_template_period_unique;

CREATE UNIQUE INDEX IF NOT EXISTS rig_template_period_success_unique
  ON recurring_invoice_generations(template_id, period)
  WHERE invoice_id IS NOT NULL;

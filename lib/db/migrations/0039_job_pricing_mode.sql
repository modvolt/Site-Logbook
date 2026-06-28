-- Add pricing_mode and contract_price to jobs table.
-- pricing_mode: 'time_material' (default) or 'fixed_price'
-- contract_price: the agreed-upon fixed price (NULL unless fixed_price mode)

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS pricing_mode text NOT NULL DEFAULT 'time_material',
  ADD COLUMN IF NOT EXISTS contract_price numeric(10, 2);

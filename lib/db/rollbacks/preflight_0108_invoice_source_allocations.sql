-- Read-only rollback preflight for migration 0108. Every non-zero count blocks
-- the corresponding destructive DOWN step and requires an explicit data plan.
SELECT 'verified_allocations' AS blocker, COUNT(*) AS row_count
FROM invoice_source_allocations
WHERE legacy_incomplete = false
UNION ALL
SELECT 'advance_or_invoice_snapshot_fields', COUNT(*)
FROM invoices
WHERE document_type <> 'standard'
   OR customer_delivery_address IS NOT NULL
   OR bank_account IS NOT NULL
   OR iban IS NOT NULL
   OR bic IS NOT NULL
UNION ALL
SELECT 'section_rows', COUNT(*)
FROM invoice_lines
WHERE row_type <> 'item'
UNION ALL
SELECT 'advance_number_series_used', COUNT(*)
FROM billing_settings
WHERE advance_number_year IS NOT NULL
   OR advance_number_next_seq <> 1;

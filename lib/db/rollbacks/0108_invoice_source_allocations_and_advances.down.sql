BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM invoice_source_allocations
    WHERE legacy_incomplete = false
  ) THEN
    RAISE EXCEPTION 'Rollback 0108 blocked: verified invoice source allocations exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM invoices
    WHERE document_type <> 'standard'
       OR customer_delivery_address IS NOT NULL
       OR bank_account IS NOT NULL
       OR iban IS NOT NULL
       OR bic IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Rollback 0108 blocked: invoice data uses the new document fields';
  END IF;

  IF EXISTS (
    SELECT 1 FROM invoice_lines WHERE row_type <> 'item'
  ) THEN
    RAISE EXCEPTION 'Rollback 0108 blocked: invoice section rows exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM billing_settings
    WHERE advance_number_year IS NOT NULL
       OR advance_number_next_seq <> 1
  ) THEN
    RAISE EXCEPTION 'Rollback 0108 blocked: advance invoice number series was used';
  END IF;
END $$;

DROP TABLE "invoice_source_allocations";
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_row_type_check";
ALTER TABLE "invoice_lines" DROP COLUMN "row_type";
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_document_type_check";
ALTER TABLE "invoices" DROP COLUMN "document_type";
ALTER TABLE "invoices" DROP COLUMN "customer_delivery_address";
ALTER TABLE "invoices" DROP COLUMN "bank_account";
ALTER TABLE "invoices" DROP COLUMN "iban";
ALTER TABLE "invoices" DROP COLUMN "bic";
ALTER TABLE "billing_settings" DROP COLUMN "advance_number_prefix";
ALTER TABLE "billing_settings" DROP COLUMN "advance_number_format";
ALTER TABLE "billing_settings" DROP COLUMN "advance_number_year";
ALTER TABLE "billing_settings" DROP COLUMN "advance_number_next_seq";

DELETE FROM drizzle.__drizzle_migrations
WHERE created_at = 1786986729921;

COMMIT;

-- Cenové nabídky (quotes) module
-- New tables: quotes, quote_items
-- New columns: billing_settings.quote_number_prefix, billing_settings.quote_number_next_seq

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quotes" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_number" text,
  "customer_id" integer,
  "title" text NOT NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "valid_until" text,
  "notes" text,
  "pdf_object_path" text,
  "converted_to_job_id" integer,
  "converted_to_invoice_id" integer,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_converted_to_job_id_jobs_id_fk"
  FOREIGN KEY ("converted_to_job_id") REFERENCES "public"."jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quotes_customer_idx" ON "quotes" ("customer_id");

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "quote_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "quote_id" integer NOT NULL,
  "position" integer NOT NULL DEFAULT 0,
  "description" text NOT NULL,
  "quantity" numeric(12,4) NOT NULL DEFAULT '1',
  "unit" text,
  "unit_price" numeric(12,2) NOT NULL DEFAULT '0',
  "vat_rate" numeric(5,2) DEFAULT '21'
);
--> statement-breakpoint
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk"
  FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "quote_items_quote_idx" ON "quote_items" ("quote_id");

--> statement-breakpoint
ALTER TABLE "billing_settings"
  ADD COLUMN IF NOT EXISTS "quote_number_prefix" text NOT NULL DEFAULT 'NAB';
--> statement-breakpoint
ALTER TABLE "billing_settings"
  ADD COLUMN IF NOT EXISTS "quote_number_next_seq" integer NOT NULL DEFAULT 1;

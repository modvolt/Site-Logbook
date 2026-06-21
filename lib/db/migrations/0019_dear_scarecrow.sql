CREATE TABLE "warehouse_price_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_item_id" integer NOT NULL,
	"billing_document_id" integer,
	"billing_document_line_id" integer,
	"purchase_price" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'CZK' NOT NULL,
	"supplier_name" text,
	"supplier_ic" text,
	"ean" text,
	"supplier_sku" text,
	"document_number" text,
	"document_date" timestamp,
	"note" text,
	"created_by_user_id" integer,
	"created_by_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_source" text;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_source_document_id" integer;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_source_line_id" integer;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_source_supplier_name" text;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_source_date" timestamp;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "price_confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "admin_note" text;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "invoiced_at" timestamp;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "invoiced_invoice_id" integer;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "ean" text;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "supplier_sku" text;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "supplier_name" text;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "supplier_ic" text;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "warehouse_items" ADD COLUMN "normalized_name" text;--> statement-breakpoint
ALTER TABLE "warehouse_price_history" ADD CONSTRAINT "warehouse_price_history_warehouse_item_id_warehouse_items_id_fk" FOREIGN KEY ("warehouse_item_id") REFERENCES "public"."warehouse_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_price_history" ADD CONSTRAINT "warehouse_price_history_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_price_history" ADD CONSTRAINT "warehouse_price_history_billing_document_line_id_billing_document_lines_id_fk" FOREIGN KEY ("billing_document_line_id") REFERENCES "public"."billing_document_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_price_history" ADD CONSTRAINT "warehouse_price_history_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warehouse_price_history_item_id_idx" ON "warehouse_price_history" USING btree ("warehouse_item_id");--> statement-breakpoint
CREATE INDEX "warehouse_price_history_billing_document_id_idx" ON "warehouse_price_history" USING btree ("billing_document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_price_history_line_uq" ON "warehouse_price_history" USING btree ("billing_document_line_id") WHERE "warehouse_price_history"."billing_document_line_id" is not null;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_price_source_document_id_billing_documents_id_fk" FOREIGN KEY ("price_source_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_price_source_line_id_billing_document_lines_id_fk" FOREIGN KEY ("price_source_line_id") REFERENCES "public"."billing_document_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_invoiced_invoice_id_invoices_id_fk" FOREIGN KEY ("invoiced_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "materials_price_source_document_id_idx" ON "materials" USING btree ("price_source_document_id");--> statement-breakpoint
CREATE INDEX "materials_price_source_line_id_idx" ON "materials" USING btree ("price_source_line_id");--> statement-breakpoint
CREATE INDEX "materials_invoiced_invoice_id_idx" ON "materials" USING btree ("invoiced_invoice_id");--> statement-breakpoint
CREATE INDEX "warehouse_items_ean_idx" ON "warehouse_items" USING btree ("ean");--> statement-breakpoint
CREATE INDEX "warehouse_items_supplier_sku_idx" ON "warehouse_items" USING btree ("supplier_sku");--> statement-breakpoint
CREATE INDEX "warehouse_items_normalized_name_idx" ON "warehouse_items" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "billing_document_lines_ean_idx" ON "billing_document_lines" USING btree ("ean");--> statement-breakpoint
CREATE INDEX "billing_document_lines_supplier_sku_idx" ON "billing_document_lines" USING btree ("supplier_sku");
--> statement-breakpoint
UPDATE "materials" SET "price_source" = 'manual' WHERE "price_per_unit" IS NOT NULL AND "price_source" IS NULL;

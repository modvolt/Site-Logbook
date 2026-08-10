ALTER TABLE "quote_items" ADD COLUMN "row_type" text DEFAULT 'item' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_items" ADD COLUMN "purchase_unit_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_row_type_check" CHECK ("quote_items"."row_type" in ('item', 'section', 'spacer'));--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_purchase_unit_price_check" CHECK ("quote_items"."purchase_unit_price" is null or "quote_items"."purchase_unit_price" >= 0);
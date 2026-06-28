ALTER TABLE "jobs" ALTER COLUMN "signature_token" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_token_expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_requested_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_object_path" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "position" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "quantity" SET DEFAULT '1';--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "unit_price" SET DATA TYPE numeric(12, 2);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "unit_price" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "vat_rate" SET DATA TYPE numeric(5, 2);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "vat_rate" SET DEFAULT '21';--> statement-breakpoint
ALTER TABLE "recurring_invoice_generations" ADD CONSTRAINT "recurring_invoice_generations_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("recurring_template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE set null ON UPDATE no action;

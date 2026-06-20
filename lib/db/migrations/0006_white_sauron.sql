ALTER TABLE "invoices" ADD COLUMN "paid_date" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "paid_amount" numeric(12, 2);
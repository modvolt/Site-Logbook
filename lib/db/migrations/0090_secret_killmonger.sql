CREATE TABLE "quote_invoice_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"job_group_id" integer,
	"invoice_id" integer,
	"invoice_id_snapshot" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"billed_at" timestamp,
	"released_at" timestamp,
	"released_by_user_id" integer,
	"release_reason" text,
	CONSTRAINT "quote_invoice_links_status_check" CHECK ("quote_invoice_links"."status" in ('reserved', 'billed', 'released'))
);
--> statement-breakpoint
ALTER TABLE "quote_invoice_links" ADD CONSTRAINT "quote_invoice_links_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_invoice_links" ADD CONSTRAINT "quote_invoice_links_job_group_id_job_groups_id_fk" FOREIGN KEY ("job_group_id") REFERENCES "public"."job_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_invoice_links" ADD CONSTRAINT "quote_invoice_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_invoice_links" ADD CONSTRAINT "quote_invoice_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_invoice_links" ADD CONSTRAINT "quote_invoice_links_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quote_invoice_links_active_quote_uq" ON "quote_invoice_links" USING btree ("quote_id") WHERE "quote_invoice_links"."status" in ('reserved', 'billed');--> statement-breakpoint
CREATE INDEX "quote_invoice_links_invoice_idx" ON "quote_invoice_links" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "quote_invoice_links_quote_idx" ON "quote_invoice_links" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "quote_invoice_links_job_group_idx" ON "quote_invoice_links" USING btree ("job_group_id");
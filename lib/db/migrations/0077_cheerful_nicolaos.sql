CREATE TABLE "work_session_billing_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"invoice_id" integer,
	"invoice_id_snapshot" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"duration_seconds_snapshot" integer NOT NULL,
	"sale_rate_snapshot" numeric(10, 2) NOT NULL,
	"amount_without_vat_snapshot" numeric(12, 2) NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"billed_at" timestamp,
	"released_at" timestamp,
	"released_by_user_id" integer,
	"release_reason" text,
	CONSTRAINT "work_session_billing_links_status_check" CHECK ("work_session_billing_links"."status" in ('reserved', 'billed', 'released')),
	CONSTRAINT "work_session_billing_links_values_check" CHECK ("work_session_billing_links"."duration_seconds_snapshot" <> 0 and "work_session_billing_links"."sale_rate_snapshot" >= 0)
);
--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "billing_status" text DEFAULT 'unbilled' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "non_billable_reason" text;--> statement-breakpoint
ALTER TABLE "work_session_billing_links" ADD CONSTRAINT "work_session_billing_links_session_id_work_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."work_sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_billing_links" ADD CONSTRAINT "work_session_billing_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_billing_links" ADD CONSTRAINT "work_session_billing_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_session_billing_links" ADD CONSTRAINT "work_session_billing_links_released_by_user_id_users_id_fk" FOREIGN KEY ("released_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_session_billing_links_active_session_uq" ON "work_session_billing_links" USING btree ("session_id") WHERE "work_session_billing_links"."status" in ('reserved', 'billed');--> statement-breakpoint
CREATE INDEX "work_session_billing_links_invoice_idx" ON "work_session_billing_links" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "work_session_billing_links_session_idx" ON "work_session_billing_links" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_billing_status_check" CHECK ("work_sessions"."billing_status" in ('unbilled', 'ready', 'billed', 'non_billable'));
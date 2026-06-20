CREATE TABLE "invoice_reminders" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"threshold" integer,
	"days_overdue" integer DEFAULT 0 NOT NULL,
	"to_email" text NOT NULL,
	"auto" boolean DEFAULT false NOT NULL,
	"sent_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "reminder_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "reminder_days" text DEFAULT '3,14,30' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_reminders_invoice_id_idx" ON "invoice_reminders" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_reminders_invoice_threshold_idx" ON "invoice_reminders" USING btree ("invoice_id","threshold");
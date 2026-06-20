CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" integer,
	"job_id" integer,
	"activity_id" integer,
	"description" text NOT NULL,
	"quantity" numeric(12, 2) DEFAULT '1' NOT NULL,
	"unit" text,
	"unit_price_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(5, 2),
	"vat_rate" numeric(5, 2),
	"vat_mode" text DEFAULT 'standard' NOT NULL,
	"total_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_with_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_source_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"job_id" integer,
	"activity_id" integer,
	"amount_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"customer_id" integer,
	"customer_name" text,
	"customer_ic" text,
	"customer_dic" text,
	"customer_address" text,
	"customer_email" text,
	"issue_date" text,
	"taxable_supply_date" text,
	"due_date" text,
	"currency" text DEFAULT 'CZK' NOT NULL,
	"payment_method" text,
	"variable_symbol" text,
	"constant_symbol" text,
	"specific_symbol" text,
	"vat_mode_default" text DEFAULT 'standard' NOT NULL,
	"subtotal_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_with_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"pdf_object_path" text,
	"isdoc_object_path" text,
	"created_by_user_id" integer,
	"issued_by_user_id" integer,
	"issued_at" timestamp,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"supplier_name" text DEFAULT 'Modvolt s.r.o.' NOT NULL,
	"supplier_ic" text,
	"supplier_dic" text,
	"supplier_address" text,
	"supplier_email" text,
	"supplier_phone" text,
	"bank_account" text,
	"iban" text,
	"bic" text,
	"default_due_days" integer DEFAULT 14 NOT NULL,
	"default_payment_method" text DEFAULT 'bank' NOT NULL,
	"vat_payer" boolean DEFAULT true NOT NULL,
	"vat_mode_default" text DEFAULT 'standard' NOT NULL,
	"invoice_footer_note" text,
	"number_prefix" text DEFAULT 'FV' NOT NULL,
	"number_format" text DEFAULT '{PREFIX}{YYYY}{SEQ4}' NOT NULL,
	"number_year" integer,
	"number_next_seq" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activities" ADD COLUMN "billing_status" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_source_links" ADD CONSTRAINT "invoice_source_links_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_issued_by_user_id_users_id_fk" FOREIGN KEY ("issued_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_id_idx" ON "invoice_lines" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_source_links_invoice_id_idx" ON "invoice_source_links" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoice_source_links_job_id_idx" ON "invoice_source_links" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "invoice_source_links_activity_id_idx" ON "invoice_source_links" USING btree ("activity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_invoice_number_unique" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_customer_id_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");
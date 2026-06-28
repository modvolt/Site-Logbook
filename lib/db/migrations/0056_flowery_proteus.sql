CREATE TABLE "ppe_handover_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"document_number" text NOT NULL,
	"signatory_name" text NOT NULL,
	"signed_at" timestamp NOT NULL,
	"confirmation_text" text NOT NULL,
	"png_object_path" text NOT NULL,
	"png_sha256" text NOT NULL,
	"pdf_object_path" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"issuer_snapshot" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ppe_handover_documents_assignment_id_uniq" UNIQUE("assignment_id")
);
--> statement-breakpoint
CREATE TABLE "ppe_handover_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"handover_document_id" integer,
	"event_type" text NOT NULL,
	"actor_user_id" integer,
	"actor_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_generations" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"invoice_id" integer NOT NULL,
	"period" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoice_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"customer_id" integer NOT NULL,
	"name" text NOT NULL,
	"items" jsonb NOT NULL,
	"interval" text DEFAULT 'monthly' NOT NULL,
	"day_of_month" integer DEFAULT 1 NOT NULL,
	"next_generation_date" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_generated_at" timestamp,
	"notes" text,
	"vat_mode_default" text DEFAULT 'standard' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "ppe_assignments_signature_token_idx";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "contract_price" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_token" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_token_expires_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_requested_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signed_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "signature_object_path" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "materials" ALTER COLUMN "purchase_price_per_unit" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "position" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "quantity" SET DATA TYPE numeric(12, 4);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "quantity" SET DEFAULT '1';--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "unit_price" SET DATA TYPE numeric(12, 2);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "unit_price" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "vat_rate" SET DATA TYPE numeric(5, 2);--> statement-breakpoint
ALTER TABLE "quote_items" ALTER COLUMN "vat_rate" SET DEFAULT '21';--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "customer_id" integer;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "document_number" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "revision" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "issued_at" date;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "valid_until" date;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "doc_status" text DEFAULT 'current' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "replaces_attachment_id" integer;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "tags" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "mime_type" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "file_size" bigint;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "sha256" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "uploaded_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "uploaded_by_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "updated_at" timestamp;--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "recurring_template_id" integer;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "quote_number_prefix" text DEFAULT 'NAB' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_settings" ADD COLUMN "quote_number_next_seq" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_category_snapshot" text;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_standard_snapshot" text;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_protection_class_snapshot" text;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "ppe_risk_description_snapshot" text;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "confirm_token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "confirm_email_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "ppe_handover_documents" ADD CONSTRAINT "ppe_handover_documents_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_handover_events" ADD CONSTRAINT "ppe_handover_events_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_handover_events" ADD CONSTRAINT "ppe_handover_events_handover_document_id_ppe_handover_documents_id_fk" FOREIGN KEY ("handover_document_id") REFERENCES "public"."ppe_handover_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_handover_events" ADD CONSTRAINT "ppe_handover_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_generations" ADD CONSTRAINT "recurring_invoice_generations_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoice_templates" ADD CONSTRAINT "recurring_invoice_templates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ppe_handover_documents_assignment_id_idx" ON "ppe_handover_documents" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "ppe_handover_events_assignment_id_idx" ON "ppe_handover_events" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "rig_template_id_idx" ON "recurring_invoice_generations" USING btree ("template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rig_template_period_unique" ON "recurring_invoice_generations" USING btree ("template_id","period");--> statement-breakpoint
CREATE INDEX "rit_customer_id_idx" ON "recurring_invoice_templates" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "rit_next_generation_date_idx" ON "recurring_invoice_templates" USING btree ("next_generation_date");--> statement-breakpoint
CREATE INDEX "rit_is_active_idx" ON "recurring_invoice_templates" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD CONSTRAINT "customer_site_attachments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_template_id_recurring_invoice_templates_id_fk" FOREIGN KEY ("recurring_template_id") REFERENCES "public"."recurring_invoice_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_converted_to_job_id_jobs_id_fk" FOREIGN KEY ("converted_to_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_csa_customer_id" ON "customer_site_attachments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_csa_valid_until" ON "customer_site_attachments" USING btree ("valid_until");--> statement-breakpoint
CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "quote_items_quote_idx" ON "quote_items" USING btree ("quote_id");--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD CONSTRAINT "ppe_assignments_signature_token_unique" UNIQUE("signature_token");
CREATE TABLE "billing_document_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"parent_line_id" integer,
	"line_type" text DEFAULT 'material' NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 2) DEFAULT '1' NOT NULL,
	"unit" text,
	"unit_price_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"vat_rate" numeric(5, 2),
	"vat_mode" text DEFAULT 'standard' NOT NULL,
	"total_without_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_with_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"job_id" integer,
	"allocation_type" text DEFAULT 'rebill' NOT NULL,
	"match_confidence" numeric(5, 2),
	"match_confirmed" integer DEFAULT 0 NOT NULL,
	"approved" integer DEFAULT 0 NOT NULL,
	"invoiced_invoice_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"doc_type" text DEFAULT 'invoice' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"object_path" text,
	"file_name" text,
	"content_type" text,
	"file_size" integer,
	"sha256" text,
	"supplier_name" text,
	"supplier_ic" text,
	"supplier_dic" text,
	"supplier_address" text,
	"document_number" text,
	"variable_symbol" text,
	"issue_date" text,
	"taxable_supply_date" text,
	"due_date" text,
	"currency" text DEFAULT 'CZK' NOT NULL,
	"subtotal_without_vat" numeric(12, 2),
	"total_vat" numeric(12, 2),
	"total_with_vat" numeric(12, 2),
	"customer_id" integer,
	"job_id" integer,
	"notes" text,
	"warnings" text,
	"created_by_user_id" integer,
	"reviewed_by_user_id" integer,
	"reviewed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"last_error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_document_id_billing_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."billing_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_parent_line_id_billing_document_lines_id_fk" FOREIGN KEY ("parent_line_id") REFERENCES "public"."billing_document_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_invoiced_invoice_id_invoices_id_fk" FOREIGN KEY ("invoiced_invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_reviewed_by_user_id_users_id_fk" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD CONSTRAINT "extraction_jobs_document_id_billing_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."billing_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_document_lines_document_id_idx" ON "billing_document_lines" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "billing_document_lines_job_id_idx" ON "billing_document_lines" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "billing_document_lines_invoiced_invoice_id_idx" ON "billing_document_lines" USING btree ("invoiced_invoice_id");--> statement-breakpoint
CREATE INDEX "billing_documents_status_idx" ON "billing_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_documents_sha256_idx" ON "billing_documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "billing_documents_supplier_ic_idx" ON "billing_documents" USING btree ("supplier_ic");--> statement-breakpoint
CREATE INDEX "billing_documents_document_number_idx" ON "billing_documents" USING btree ("document_number");--> statement-breakpoint
CREATE INDEX "billing_documents_job_id_idx" ON "billing_documents" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "billing_documents_customer_id_idx" ON "billing_documents" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "extraction_jobs_status_idx" ON "extraction_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "extraction_jobs_document_id_idx" ON "extraction_jobs" USING btree ("document_id");
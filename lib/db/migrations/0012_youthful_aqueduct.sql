CREATE TABLE "billing_document_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"role" text DEFAULT 'attachment' NOT NULL,
	"original_file_name" text,
	"mime_type" text,
	"object_path" text,
	"sha256_hash" text,
	"size_bytes" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_document_references" (
	"id" serial PRIMARY KEY NOT NULL,
	"document_id" integer NOT NULL,
	"reference_type" text DEFAULT 'other' NOT NULL,
	"reference_number" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"confidence" numeric(5, 2),
	"matched_job_id" integer,
	"matched_document_id" integer,
	"matched_attachment_id" integer,
	"match_confidence" numeric(5, 2),
	"match_confirmed" integer DEFAULT 0 NOT NULL,
	"rejected" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_parser_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"supplier_id" integer,
	"supplier_name" text,
	"supplier_name_pattern" text,
	"ico" text,
	"parser_type" text DEFAULT 'generic' NOT NULL,
	"rules_json" text,
	"is_active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "original_unit" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "supplier_sku" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "ean" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "discount_percent" numeric(6, 2);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "list_price_without_vat" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "price_before_discount" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "price_after_discount" numeric(12, 4);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "price_base_quantity" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "price_base_unit" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "fee_type" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "is_environmental_fee" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "environmental_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "recycling_fee" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "related_line_id" integer;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "delivery_note_number" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "supplier_order_number" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "source_line_number" text;--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD COLUMN "warehouse_state" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "delivery_note_number" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "summary_delivery_note_number" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "delivery_number" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "order_number" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "supplier_order_number" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "constant_symbol" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "specific_symbol" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "bank_account" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "iban" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "bic" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "isdoc_uuid" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "merge_group_id" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "primary_document_id" integer;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "source_priority" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "parsed_by" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "extraction_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_document_files" ADD CONSTRAINT "billing_document_files_document_id_billing_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."billing_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_references" ADD CONSTRAINT "billing_document_references_document_id_billing_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."billing_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_references" ADD CONSTRAINT "billing_document_references_matched_job_id_jobs_id_fk" FOREIGN KEY ("matched_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_references" ADD CONSTRAINT "billing_document_references_matched_document_id_billing_documents_id_fk" FOREIGN KEY ("matched_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_references" ADD CONSTRAINT "billing_document_references_matched_attachment_id_attachments_id_fk" FOREIGN KEY ("matched_attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_document_files_document_id_idx" ON "billing_document_files" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "billing_document_files_sha256_idx" ON "billing_document_files" USING btree ("sha256_hash");--> statement-breakpoint
CREATE INDEX "billing_document_references_document_id_idx" ON "billing_document_references" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "billing_document_references_number_idx" ON "billing_document_references" USING btree ("reference_number");--> statement-breakpoint
CREATE INDEX "billing_document_references_matched_job_id_idx" ON "billing_document_references" USING btree ("matched_job_id");--> statement-breakpoint
CREATE INDEX "supplier_parser_profiles_ico_idx" ON "supplier_parser_profiles" USING btree ("ico");--> statement-breakpoint
CREATE INDEX "supplier_parser_profiles_active_idx" ON "supplier_parser_profiles" USING btree ("is_active");--> statement-breakpoint
ALTER TABLE "billing_document_lines" ADD CONSTRAINT "billing_document_lines_related_line_id_billing_document_lines_id_fk" FOREIGN KEY ("related_line_id") REFERENCES "public"."billing_document_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_primary_document_id_billing_documents_id_fk" FOREIGN KEY ("primary_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;
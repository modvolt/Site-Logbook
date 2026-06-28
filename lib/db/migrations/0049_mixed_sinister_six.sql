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
DROP INDEX "ppe_assignments_signature_token_idx";--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "contract_price" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "materials" ALTER COLUMN "purchase_price_per_unit" SET DATA TYPE numeric(10, 2);--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
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
ALTER TABLE "backup_log" ADD COLUMN "sha256" char(64);--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restored_at" timestamp;--> statement-breakpoint
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
CREATE INDEX "ppe_handover_documents_assignment_id_idx" ON "ppe_handover_documents" USING btree ("assignment_id");--> statement-breakpoint
CREATE INDEX "ppe_handover_events_assignment_id_idx" ON "ppe_handover_events" USING btree ("assignment_id");--> statement-breakpoint
ALTER TABLE "customer_site_attachments" ADD CONSTRAINT "customer_site_attachments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_csa_customer_id" ON "customer_site_attachments" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "idx_csa_valid_until" ON "customer_site_attachments" USING btree ("valid_until");--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD CONSTRAINT "ppe_assignments_signature_token_unique" UNIQUE("signature_token");
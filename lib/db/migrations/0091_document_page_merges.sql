CREATE TABLE "billing_document_merge_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"merge_id" integer NOT NULL,
	"document_id" integer NOT NULL,
	"attachment_id" integer,
	"page_order" integer NOT NULL,
	"previous_status" text NOT NULL,
	"previous_primary_document_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_document_merges" (
	"id" serial PRIMARY KEY NOT NULL,
	"primary_document_id" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by_user_id" integer,
	"reverted_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"reverted_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "billing_documents" ALTER COLUMN "doc_type" SET DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "billing_document_id" integer;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "page_index" integer;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "declared_doc_type" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "detected_doc_type" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "detected_doc_type_confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "doc_type_source" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "doc_type_confirmed_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "doc_type_confirmed_at" timestamp;--> statement-breakpoint
ALTER TABLE "billing_document_merge_members" ADD CONSTRAINT "billing_document_merge_members_merge_id_billing_document_merges_id_fk" FOREIGN KEY ("merge_id") REFERENCES "public"."billing_document_merges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merge_members" ADD CONSTRAINT "billing_document_merge_members_document_id_billing_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merge_members" ADD CONSTRAINT "billing_document_merge_members_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merge_members" ADD CONSTRAINT "billing_document_merge_members_previous_primary_document_id_billing_documents_id_fk" FOREIGN KEY ("previous_primary_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merges" ADD CONSTRAINT "billing_document_merges_primary_document_id_billing_documents_id_fk" FOREIGN KEY ("primary_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merges" ADD CONSTRAINT "billing_document_merges_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_document_merges" ADD CONSTRAINT "billing_document_merges_reverted_by_user_id_users_id_fk" FOREIGN KEY ("reverted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_document_merge_members_merge_document_uq" ON "billing_document_merge_members" USING btree ("merge_id","document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_document_merge_members_merge_order_uq" ON "billing_document_merge_members" USING btree ("merge_id","page_order");--> statement-breakpoint
CREATE INDEX "billing_document_merge_members_document_idx" ON "billing_document_merge_members" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "billing_document_merge_members_attachment_idx" ON "billing_document_merge_members" USING btree ("attachment_id");--> statement-breakpoint
CREATE INDEX "billing_document_merges_primary_idx" ON "billing_document_merges" USING btree ("primary_document_id");--> statement-breakpoint
CREATE INDEX "billing_document_merges_status_idx" ON "billing_document_merges" USING btree ("status");--> statement-breakpoint
ALTER TABLE "billing_documents" ADD CONSTRAINT "billing_documents_doc_type_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("doc_type_confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_billing_document_id_idx" ON "attachments" USING btree ("billing_document_id");
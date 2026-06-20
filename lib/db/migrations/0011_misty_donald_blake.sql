CREATE TABLE "email_import_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'gmail' NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"email_address" text,
	"refresh_token_encrypted" text,
	"scope" text,
	"label_filter" text,
	"label_after_import" integer DEFAULT 0 NOT NULL,
	"last_sync_at" timestamp,
	"last_sync_status" text,
	"last_sync_error" text,
	"connected_by_user_id" integer,
	"connected_at" timestamp,
	"disconnected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_import_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"provider_attachment_id" text,
	"file_name" text,
	"content_type" text,
	"size" integer,
	"sha256" text,
	"object_path" text,
	"skipped" integer DEFAULT 0 NOT NULL,
	"skip_reason" text,
	"billing_document_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_import_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" integer NOT NULL,
	"provider_message_id" text NOT NULL,
	"thread_id" text,
	"from_address" text,
	"from_name" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp,
	"status" text DEFAULT 'new' NOT NULL,
	"error" text,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"labeled" integer DEFAULT 0 NOT NULL,
	"processed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_import_accounts" ADD CONSTRAINT "email_import_accounts_connected_by_user_id_users_id_fk" FOREIGN KEY ("connected_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_import_attachments" ADD CONSTRAINT "email_import_attachments_message_id_email_import_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."email_import_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_import_attachments" ADD CONSTRAINT "email_import_attachments_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_import_messages" ADD CONSTRAINT "email_import_messages_account_id_email_import_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."email_import_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "email_import_accounts_status_idx" ON "email_import_accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_import_attachments_message_id_idx" ON "email_import_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "email_import_attachments_sha256_idx" ON "email_import_attachments" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "email_import_messages_provider_message_id_idx" ON "email_import_messages" USING btree ("account_id","provider_message_id");--> statement-breakpoint
CREATE INDEX "email_import_messages_status_idx" ON "email_import_messages" USING btree ("status");
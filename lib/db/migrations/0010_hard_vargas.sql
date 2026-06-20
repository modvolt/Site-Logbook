CREATE TABLE "email_import_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"host" text,
	"port" integer DEFAULT 993 NOT NULL,
	"secure" boolean DEFAULT true NOT NULL,
	"username" text,
	"password" text,
	"folder" text DEFAULT 'INBOX' NOT NULL,
	"mark_seen" boolean DEFAULT true NOT NULL,
	"poll_minutes" integer DEFAULT 15 NOT NULL,
	"last_polled_at" timestamp,
	"last_status" text,
	"last_error" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_import_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"sender" text,
	"subject" text,
	"received_at" timestamp,
	"status" text NOT NULL,
	"attachments_total" integer DEFAULT 0 NOT NULL,
	"attachments_imported" integer DEFAULT 0 NOT NULL,
	"document_ids" text,
	"error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "source_ref" text;--> statement-breakpoint
CREATE UNIQUE INDEX "email_import_log_message_id_idx" ON "email_import_log" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "email_import_log_created_at_idx" ON "email_import_log" USING btree ("created_at");
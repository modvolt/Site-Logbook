CREATE TABLE "object_uploads" (
	"object_path" text PRIMARY KEY NOT NULL,
	"uploaded_by_user_id" integer,
	"original_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"scanner_status" text DEFAULT 'pending' NOT NULL,
	"claim_type" text,
	"claim_id" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"stored_at" timestamp,
	"claimed_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "object_uploads_state_chk" CHECK ("object_uploads"."state" in ('pending', 'stored', 'claimed', 'quarantined', 'failed', 'delete_pending', 'deleted')),
	CONSTRAINT "object_uploads_scanner_status_chk" CHECK ("object_uploads"."scanner_status" in ('pending', 'content_validated', 'clean', 'malicious', 'unavailable')),
	CONSTRAINT "object_uploads_size_chk" CHECK ("object_uploads"."size_bytes" > 0)
);
--> statement-breakpoint
ALTER TABLE "object_uploads" ADD CONSTRAINT "object_uploads_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_uploads_state_created_idx" ON "object_uploads" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "object_uploads_sha256_idx" ON "object_uploads" USING btree ("sha256");
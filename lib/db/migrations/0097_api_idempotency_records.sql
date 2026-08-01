CREATE TABLE "api_idempotency_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"offline_scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_content_type" text,
	"response_body" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_state_chk" CHECK ("api_idempotency_records"."state" in ('pending', 'completed', 'ambiguous'))
);
--> statement-breakpoint
ALTER TABLE "api_idempotency_records" ADD CONSTRAINT "api_idempotency_records_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_idempotency_scope_key_uq" ON "api_idempotency_records" USING btree ("user_id","offline_scope","method","path","idempotency_key");--> statement-breakpoint
CREATE INDEX "api_idempotency_created_idx" ON "api_idempotency_records" USING btree ("created_at");
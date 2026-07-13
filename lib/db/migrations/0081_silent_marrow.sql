CREATE TABLE "switchboard_qr_access_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"switchboard_id" integer,
	"token_prefix" text,
	"outcome" text NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"authenticated_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "switchboards" ADD COLUMN "qr_token_ciphertext" text;--> statement-breakpoint
ALTER TABLE "switchboard_qr_access_logs" ADD CONSTRAINT "switchboard_qr_access_logs_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboard_qr_access_logs" ADD CONSTRAINT "switchboard_qr_access_logs_authenticated_user_id_users_id_fk" FOREIGN KEY ("authenticated_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "switchboard_qr_access_logs_board_idx" ON "switchboard_qr_access_logs" USING btree ("switchboard_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "switchboards_qr_token_hash_unique_idx" ON "switchboards" USING btree ("qr_token_hash");
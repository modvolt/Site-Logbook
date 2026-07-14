ALTER TABLE "jobs" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "archived_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "status_before_archive" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_archived_by_user_id_users_id_fk" FOREIGN KEY ("archived_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_archived_at_idx" ON "jobs" USING btree ("archived_at");
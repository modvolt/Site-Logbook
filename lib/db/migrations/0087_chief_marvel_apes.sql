ALTER TABLE "materials" ADD COLUMN "consumed_at" timestamp;--> statement-breakpoint
ALTER TABLE "materials" ADD COLUMN "consumed_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_consumed_by_user_id_users_id_fk" FOREIGN KEY ("consumed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "materials_consumed_at_idx" ON "materials" USING btree ("consumed_at");--> statement-breakpoint
-- Every existing row was created under the legacy workflow where adding a job
-- material immediately issued stock and made it billable. Preserve that
-- meaning on deploy; only rows created after this migration start as planned.
UPDATE "materials"
SET
  "done" = true,
  "consumed_at" = COALESCE("consumed_at", "created_at")
WHERE "done" = false OR "consumed_at" IS NULL;

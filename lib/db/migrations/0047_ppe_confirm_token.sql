ALTER TABLE "ppe_assignments" ADD COLUMN IF NOT EXISTS "confirm_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ppe_assignments_confirm_token_idx" ON "ppe_assignments" ("confirm_token") WHERE "confirm_token" IS NOT NULL;

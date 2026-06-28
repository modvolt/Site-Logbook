ALTER TABLE "ppe_assignments" ADD COLUMN "confirm_token" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "ppe_assignments_confirm_token_idx" ON "ppe_assignments" ("confirm_token") WHERE "confirm_token" IS NOT NULL;

CREATE UNIQUE INDEX "ppe_assignments_confirm_token_idx" ON "ppe_assignments" ("confirm_token") WHERE "confirm_token" IS NOT NULL;

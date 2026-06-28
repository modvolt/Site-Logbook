ALTER TABLE "ppe_assignments" ADD COLUMN "signature_token" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "signature_object_path" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "ppe_assignments_signature_token_idx" ON "ppe_assignments" ("signature_token") WHERE "signature_token" IS NOT NULL;

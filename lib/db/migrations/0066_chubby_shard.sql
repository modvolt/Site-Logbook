ALTER TABLE "openai_settings" ALTER COLUMN "confidence_threshold" SET DEFAULT 0.8;--> statement-breakpoint
ALTER TABLE "document_linking_settings" ALTER COLUMN "auto_confirm_enabled" SET DEFAULT true;--> statement-breakpoint
UPDATE "document_linking_settings"
SET "auto_confirm_enabled" = true, "updated_at" = now()
WHERE "id" = 1 AND "auto_confirm_enabled" IS DISTINCT FROM true;--> statement-breakpoint
UPDATE "openai_settings"
SET "confidence_threshold" = 0.8, "updated_at" = now()
WHERE "id" = 1 AND "confidence_threshold" IS DISTINCT FROM 0.8;

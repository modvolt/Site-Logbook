ALTER TABLE "document_linking_settings" ALTER COLUMN "auto_confirm_min_score" SET DEFAULT 0.8;--> statement-breakpoint
UPDATE "document_linking_settings"
SET "auto_confirm_enabled" = true,
    "auto_confirm_min_score" = 0.8,
    "updated_at" = now()
WHERE "id" = 1
  AND (
    "auto_confirm_enabled" IS DISTINCT FROM true
    OR "auto_confirm_min_score" IS DISTINCT FROM 0.8
  );

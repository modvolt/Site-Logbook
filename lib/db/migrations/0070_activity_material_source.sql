ALTER TABLE "activity_materials" ADD COLUMN IF NOT EXISTS "source_type" text;--> statement-breakpoint
ALTER TABLE "activity_materials" ADD COLUMN IF NOT EXISTS "source_id" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_materials_source_uq"
  ON "activity_materials" ("source_type", "source_id")
  WHERE "source_type" IS NOT NULL;

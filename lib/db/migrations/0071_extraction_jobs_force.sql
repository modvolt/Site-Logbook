ALTER TABLE "extraction_jobs" ADD COLUMN IF NOT EXISTS "force" boolean DEFAULT false NOT NULL;

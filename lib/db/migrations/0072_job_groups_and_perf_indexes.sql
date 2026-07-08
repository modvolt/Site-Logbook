CREATE TABLE IF NOT EXISTS "job_groups" (
"id" serial PRIMARY KEY NOT NULL,
"name" text NOT NULL,
"customer_id" integer,
"address" text,
"notes" text,
"status" text DEFAULT 'open' NOT NULL,
"date_from" text,
"date_to" text,
"created_at" timestamp DEFAULT now() NOT NULL,
"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "openai_settings" ALTER COLUMN "confidence_threshold" SET DEFAULT 0.8;--> statement-breakpoint
ALTER TABLE "document_linking_settings" ALTER COLUMN "auto_confirm_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "document_linking_settings" ALTER COLUMN "auto_confirm_min_score" SET DEFAULT 0.8;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "group_id" integer;--> statement-breakpoint
ALTER TABLE "activity_materials" ADD COLUMN IF NOT EXISTS "source_type" text;--> statement-breakpoint
ALTER TABLE "activity_materials" ADD COLUMN IF NOT EXISTS "source_id" integer;--> statement-breakpoint
ALTER TABLE "extraction_jobs" ADD COLUMN IF NOT EXISTS "force" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_groups" ADD CONSTRAINT "job_groups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_groups_customer_id_idx" ON "job_groups" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_groups_status_idx" ON "job_groups" USING btree ("status");--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_group_id_job_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."job_groups"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_group_id_idx" ON "jobs" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_job_id_idx" ON "tasks" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_job_id_idx" ON "attachments" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_file_name_idx" ON "attachments" USING btree ("file_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "materials_job_id_idx" ON "materials" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "materials_source_id_idx" ON "materials" USING btree ("source_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "activity_materials_source_uq" ON "activity_materials" USING btree ("source_type","source_id") WHERE "activity_materials"."source_type" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_documents_file_name_idx" ON "billing_documents" USING btree ("file_name");

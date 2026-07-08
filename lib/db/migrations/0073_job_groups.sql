CREATE TABLE IF NOT EXISTS "job_groups" (
  "id" serial PRIMARY KEY,
  "name" text NOT NULL,
  "customer_id" integer,
  "address" text,
  "notes" text,
  "status" text NOT NULL DEFAULT 'open',
  "date_from" text,
  "date_to" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE "job_groups" ADD CONSTRAINT "job_groups_customer_id_customers_id_fk"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "job_groups_customer_id_idx" ON "job_groups" ("customer_id");
CREATE INDEX IF NOT EXISTS "job_groups_status_idx" ON "job_groups" ("status");

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "group_id" integer;

DO $$ BEGIN
  ALTER TABLE "jobs" ADD CONSTRAINT "jobs_group_id_job_groups_id_fk"
    FOREIGN KEY ("group_id") REFERENCES "job_groups"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "jobs_group_id_idx" ON "jobs" ("group_id");

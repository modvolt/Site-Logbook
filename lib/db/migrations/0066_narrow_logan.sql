CREATE SEQUENCE "public"."job_number_seq";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "job_number" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM jobs)
UPDATE jobs SET job_number = ordered.rn FROM ordered WHERE jobs.id = ordered.id;--> statement-breakpoint
DO $$ BEGIN IF (SELECT COUNT(*) FROM jobs) > 0 THEN PERFORM setval('job_number_seq', (SELECT MAX(job_number) FROM jobs)); END IF; END $$;--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "job_number" SET DEFAULT nextval('job_number_seq');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "job_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_number_unique" UNIQUE("job_number");

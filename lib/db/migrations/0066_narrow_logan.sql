CREATE SEQUENCE "public"."job_number_seq";--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "job_number" integer;--> statement-breakpoint
WITH ordered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM jobs)
UPDATE jobs SET job_number = ordered.rn FROM ordered WHERE jobs.id = ordered.id;--> statement-breakpoint
SELECT setval('job_number_seq', COALESCE((SELECT MAX(job_number) FROM jobs), 0));--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "job_number" SET DEFAULT nextval('job_number_seq');--> statement-breakpoint
ALTER TABLE "jobs" ALTER COLUMN "job_number" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_job_number_unique" UNIQUE("job_number");

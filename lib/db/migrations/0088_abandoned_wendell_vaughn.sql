ALTER TABLE "job_visits" ADD COLUMN "start_time" text;--> statement-breakpoint
ALTER TABLE "job_visits" ADD COLUMN "end_time" text;--> statement-breakpoint
ALTER TABLE "job_visits" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "job_visits_date_idx" ON "job_visits" USING btree ("date");--> statement-breakpoint
CREATE INDEX "job_visits_job_date_idx" ON "job_visits" USING btree ("job_id","date");
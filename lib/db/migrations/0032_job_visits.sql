CREATE TABLE "job_visits" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"person_id" integer,
	"date" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_visits" ADD CONSTRAINT "job_visits_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;

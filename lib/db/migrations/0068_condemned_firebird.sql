CREATE TABLE "job_assignees" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"person_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_assignees_job_id_person_id_unique" UNIQUE("job_id","person_id")
);
--> statement-breakpoint
ALTER TABLE "job_assignees" ADD CONSTRAINT "job_assignees_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_assignees" ADD CONSTRAINT "job_assignees_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;
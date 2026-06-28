CREATE TABLE "activity_visits" (
"id" serial PRIMARY KEY NOT NULL,
"activity_id" integer NOT NULL,
"person_id" integer,
"date" text NOT NULL,
"time_from" text,
"time_to" text,
"status" text DEFAULT 'planned' NOT NULL,
"note" text,
"next_step" text,
"created_at" timestamp DEFAULT now() NOT NULL,
"created_by" text
);
--> statement-breakpoint
ALTER TABLE "activity_visits" ADD CONSTRAINT "activity_visits_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_visits" ADD CONSTRAINT "activity_visits_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;

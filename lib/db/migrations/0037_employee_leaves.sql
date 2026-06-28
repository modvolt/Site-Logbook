CREATE TABLE "employee_leaves" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"type" text DEFAULT 'vacation' NOT NULL,
	"start_date" text NOT NULL,
	"end_date" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employee_leaves" ADD CONSTRAINT "employee_leaves_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;

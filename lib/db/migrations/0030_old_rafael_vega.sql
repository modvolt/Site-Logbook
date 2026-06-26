CREATE TABLE "client_errors" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"user_role" text,
	"message" text NOT NULL,
	"stack" text,
	"component_stack" text,
	"path" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_errors" ADD CONSTRAINT "client_errors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
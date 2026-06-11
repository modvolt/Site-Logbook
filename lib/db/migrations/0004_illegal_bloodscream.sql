CREATE TABLE "security_questions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"position" integer NOT NULL,
	"question" text NOT NULL,
	"answer_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_questions_user_position_unique" UNIQUE("user_id","position")
);
--> statement-breakpoint
ALTER TABLE "security_questions" ADD CONSTRAINT "security_questions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
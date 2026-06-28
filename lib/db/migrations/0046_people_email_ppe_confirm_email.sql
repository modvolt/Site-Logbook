ALTER TABLE "people" ADD COLUMN "email" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "confirm_email_sent_at" timestamp;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD COLUMN "confirm_token" text;
--> statement-breakpoint
ALTER TABLE "ppe_assignments" ADD CONSTRAINT "ppe_assignments_confirm_token_unique" UNIQUE("confirm_token");

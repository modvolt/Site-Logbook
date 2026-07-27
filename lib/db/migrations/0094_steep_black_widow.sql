ALTER TABLE "jobs" ADD COLUMN "billing_intent" text DEFAULT 'billable' NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "billing_exclusion_reason" text;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "billing_intent_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "billing_intent_changed_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_billing_intent_changed_by_user_id_users_id_fk" FOREIGN KEY ("billing_intent_changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_billing_intent_idx" ON "jobs" USING btree ("billing_intent");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_billing_intent_check" CHECK ("jobs"."billing_intent" IN ('billable', 'not_billable'));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_billing_exclusion_reason_check" CHECK (("jobs"."billing_intent" = 'billable' AND "jobs"."billing_exclusion_reason" IS NULL) OR ("jobs"."billing_intent" = 'not_billable' AND "jobs"."billing_exclusion_reason" IS NOT NULL AND length(btrim("jobs"."billing_exclusion_reason")) >= 3));
CREATE TABLE "person_hourly_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"person_id" integer NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"cost_rate" numeric(10, 2) NOT NULL,
	"sale_rate" numeric(10, 2) NOT NULL,
	"reason" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"voided_at" timestamp,
	"voided_by_user_id" integer,
	"void_reason" text,
	CONSTRAINT "person_hourly_rates_values_check" CHECK ("person_hourly_rates"."cost_rate" >= 0 and "person_hourly_rates"."sale_rate" >= 0),
	CONSTRAINT "person_hourly_rates_range_check" CHECK ("person_hourly_rates"."valid_to" is null or "person_hourly_rates"."valid_to" >= "person_hourly_rates"."valid_from")
);
--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "hourly_rate_id" integer;--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "cost_rate_snapshot" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "work_sessions" ADD COLUMN "sale_rate_snapshot" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "person_hourly_rates" ADD CONSTRAINT "person_hourly_rates_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_hourly_rates" ADD CONSTRAINT "person_hourly_rates_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_hourly_rates" ADD CONSTRAINT "person_hourly_rates_voided_by_user_id_users_id_fk" FOREIGN KEY ("voided_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_hourly_rates_person_from_active_uq" ON "person_hourly_rates" USING btree ("person_id","valid_from") WHERE "person_hourly_rates"."voided_at" is null;--> statement-breakpoint
CREATE INDEX "person_hourly_rates_person_period_idx" ON "person_hourly_rates" USING btree ("person_id","valid_from","valid_to");--> statement-breakpoint
ALTER TABLE "work_sessions" ADD CONSTRAINT "work_sessions_hourly_rate_id_person_hourly_rates_id_fk" FOREIGN KEY ("hourly_rate_id") REFERENCES "public"."person_hourly_rates"("id") ON DELETE set null ON UPDATE no action;
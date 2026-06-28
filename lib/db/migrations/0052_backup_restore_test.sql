ALTER TABLE "backup_log" ADD COLUMN "restore_tested_at" timestamp;--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restore_status" text;--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restore_error" text;--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restore_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restore_verified_tables" jsonb;--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"restore_test_day_of_week" integer,
	"restore_notify_email" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);

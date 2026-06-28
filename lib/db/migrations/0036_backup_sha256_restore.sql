ALTER TABLE "backup_log" ADD COLUMN "sha256" char(64);--> statement-breakpoint
ALTER TABLE "backup_log" ADD COLUMN "restored_at" timestamp;

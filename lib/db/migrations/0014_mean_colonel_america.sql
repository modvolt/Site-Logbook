ALTER TABLE "openai_settings" ADD COLUMN "system_prompt" text;--> statement-breakpoint
ALTER TABLE "openai_settings" ADD COLUMN "max_file_mb" integer;--> statement-breakpoint
ALTER TABLE "openai_settings" ADD COLUMN "request_timeout_ms" integer;--> statement-breakpoint
ALTER TABLE "openai_settings" ADD COLUMN "confidence_threshold" real;
ALTER TABLE "billing_documents" ADD COLUMN "ai_raw_json" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "ai_confidence" numeric(3, 2);--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "ai_model" text;--> statement-breakpoint
ALTER TABLE "billing_documents" ADD COLUMN "ai_extracted_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN "signature_token" text;
ALTER TABLE "jobs" ADD COLUMN "signature_token_expires_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN "signature_requested_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN "signed_at" timestamp;
ALTER TABLE "jobs" ADD COLUMN "signature_object_path" text;

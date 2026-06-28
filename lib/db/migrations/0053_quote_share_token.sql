-- Add share_token column to quotes for public customer-facing share links
--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN IF NOT EXISTS "share_token" text;

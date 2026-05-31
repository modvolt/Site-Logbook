CREATE TABLE "email_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"host" text,
	"port" integer DEFAULT 587 NOT NULL,
	"secure" boolean DEFAULT false NOT NULL,
	"username" text,
	"password" text,
	"from_address" text,
	"from_name" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "ip_address" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "pin" text;--> statement-breakpoint
ALTER TABLE "device_credentials" ADD COLUMN "users" jsonb DEFAULT '[]'::jsonb NOT NULL;
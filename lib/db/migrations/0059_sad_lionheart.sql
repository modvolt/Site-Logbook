CREATE TABLE "webauthn_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"device_name" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "webauthn_credentials_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
DROP INDEX "rig_template_period_unique";--> statement-breakpoint
ALTER TABLE "recurring_invoice_generations" ALTER COLUMN "invoice_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_invoice_generations" ADD COLUMN "error_message" text;--> statement-breakpoint
ALTER TABLE "webauthn_credentials" ADD CONSTRAINT "webauthn_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
CREATE TABLE "public_access_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by_user_id" integer,
	"legacy_imported_at" timestamp,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revoke_reason" text,
	"consumed_at" timestamp,
	"consume_action" text,
	CONSTRAINT "public_access_tokens_purpose_resource_chk" CHECK ((
		("purpose" = 'job_signature' and "resource_type" = 'job') or
		("purpose" in ('ppe_signature', 'ppe_confirmation') and "resource_type" = 'ppe_assignment') or
		("purpose" = 'quote_decision' and "resource_type" = 'quote')
	)),
	CONSTRAINT "public_access_tokens_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_access_tokens_prefix_chk" CHECK ("token_prefix" ~ '^[A-Za-z0-9_-]{8}$'),
	CONSTRAINT "public_access_tokens_terminal_state_chk" CHECK (not ("revoked_at" is not null and "consumed_at" is not null)),
	CONSTRAINT "public_access_tokens_consume_action_chk" CHECK (("consumed_at" is null and "consume_action" is null) or ("consumed_at" is not null and "consume_action" in ('signed', 'confirmed', 'accepted', 'rejected')))
);
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "public_access_tokens_purpose_hash_uq" ON "public_access_tokens" USING btree ("purpose", "token_hash");
--> statement-breakpoint
CREATE INDEX "public_access_tokens_resource_idx" ON "public_access_tokens" USING btree ("purpose", "resource_type", "resource_id");
--> statement-breakpoint
CREATE INDEX "public_access_tokens_expiry_idx" ON "public_access_tokens" USING btree ("purpose", "expires_at");
--> statement-breakpoint
INSERT INTO "public_access_tokens" (
	"purpose", "resource_type", "resource_id", "token_hash", "token_prefix",
	"expires_at", "created_at", "legacy_imported_at", "consumed_at", "consume_action"
)
SELECT
	'job_signature', 'job', "id",
	encode(sha256(convert_to("signature_token", 'UTF8')), 'hex'),
	left("signature_token", 8),
	coalesce("signature_token_expires_at", "signature_requested_at" + interval '7 days', now() + interval '7 days'),
	now(), now(), "signed_at", case when "signed_at" is not null then 'signed' else null end
FROM "jobs"
WHERE "signature_token" is not null;
--> statement-breakpoint
INSERT INTO "public_access_tokens" (
	"purpose", "resource_type", "resource_id", "token_hash", "token_prefix",
	"expires_at", "created_at", "legacy_imported_at", "consumed_at", "consume_action"
)
SELECT
	'ppe_signature', 'ppe_assignment', "id",
	encode(sha256(convert_to("signature_token", 'UTF8')), 'hex'),
	left("signature_token", 8),
	now() + interval '30 days',
	now(), now(), "employee_confirmed_at", case when "employee_confirmed_at" is not null then 'signed' else null end
FROM "ppe_assignments"
WHERE "signature_token" is not null;
--> statement-breakpoint
INSERT INTO "public_access_tokens" (
	"purpose", "resource_type", "resource_id", "token_hash", "token_prefix",
	"expires_at", "created_at", "legacy_imported_at", "consumed_at", "consume_action"
)
SELECT
	'ppe_confirmation', 'ppe_assignment', "id",
	encode(sha256(convert_to("confirm_token", 'UTF8')), 'hex'),
	left("confirm_token", 8),
	coalesce("confirm_token_expires_at", now() + interval '30 days'),
	now(), now(), "employee_confirmed_at", case when "employee_confirmed_at" is not null then 'confirmed' else null end
FROM "ppe_assignments"
WHERE "confirm_token" is not null;
--> statement-breakpoint
INSERT INTO "public_access_tokens" (
	"purpose", "resource_type", "resource_id", "token_hash", "token_prefix",
	"expires_at", "created_at", "legacy_imported_at",
	"revoked_at", "revoke_reason", "consumed_at", "consume_action"
)
SELECT
	'quote_decision', 'quote', "id",
	encode(sha256(convert_to("share_token", 'UTF8')), 'hex'),
	left("share_token", 8),
	now() + interval '30 days',
	now(), now(),
	case when "status" = 'expired' then "updated_at" else null end,
	case when "status" = 'expired' then 'legacy_quote_expired' else null end,
	case when "status" in ('accepted', 'rejected') then "updated_at" else null end,
	case when "status" in ('accepted', 'rejected') then "status" else null end
FROM "quotes"
WHERE "share_token" is not null;

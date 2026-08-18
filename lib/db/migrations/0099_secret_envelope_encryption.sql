-- Expand-only migration for R05. No existing value is rewritten here: the
-- application dual-reads legacy columns and encrypted envelopes until the
-- separately invoked, dry-run-by-default backfill has been verified.

ALTER TABLE "device_credentials"
  ADD COLUMN "secret_ciphertext" text,
  ADD COLUMN "secret_key_id" text,
  ADD COLUMN "secret_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_settings"
  ADD COLUMN "password_ciphertext" text,
  ADD COLUMN "password_key_id" text,
  ADD COLUMN "password_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_import_settings"
  ADD COLUMN "password_ciphertext" text,
  ADD COLUMN "password_key_id" text,
  ADD COLUMN "password_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "openai_settings"
  ADD COLUMN "api_key_ciphertext" text,
  ADD COLUMN "api_key_key_id" text,
  ADD COLUMN "api_key_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "email_import_accounts"
  ADD COLUMN "refresh_token_key_id" text,
  ADD COLUMN "refresh_token_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "switchboards"
  ADD COLUMN "qr_token_key_id" text,
  ADD COLUMN "qr_token_encrypted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "backup_log"
  ADD COLUMN "encryption_format" text,
  ADD COLUMN "encryption_key_id" text;
--> statement-breakpoint

ALTER TABLE "device_credentials" ADD CONSTRAINT "device_credentials_secret_envelope_chk"
  CHECK (
    ("secret_ciphertext" IS NULL AND "secret_key_id" IS NULL AND "secret_encrypted_at" IS NULL)
    OR
    (
      "secret_ciphertext" IS NOT NULL AND "secret_key_id" IS NOT NULL AND "secret_encrypted_at" IS NOT NULL
      AND "ip_address" IS NULL AND "pin" IS NULL AND "username" IS NULL
      AND "password" IS NULL AND "email" IS NULL AND "note" IS NULL
      AND "users" = '[]'::jsonb AND "network_topology" = '[]'::jsonb
    )
  );
--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_password_envelope_chk"
  CHECK (
    ("password_ciphertext" IS NULL AND "password_key_id" IS NULL AND "password_encrypted_at" IS NULL)
    OR
    ("password_ciphertext" IS NOT NULL AND "password_key_id" IS NOT NULL AND "password_encrypted_at" IS NOT NULL AND "password" IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "email_import_settings" ADD CONSTRAINT "email_import_settings_password_envelope_chk"
  CHECK (
    ("password_ciphertext" IS NULL AND "password_key_id" IS NULL AND "password_encrypted_at" IS NULL)
    OR
    ("password_ciphertext" IS NOT NULL AND "password_key_id" IS NOT NULL AND "password_encrypted_at" IS NOT NULL AND "password" IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "openai_settings" ADD CONSTRAINT "openai_settings_api_key_envelope_chk"
  CHECK (
    ("api_key_ciphertext" IS NULL AND "api_key_key_id" IS NULL AND "api_key_encrypted_at" IS NULL)
    OR
    ("api_key_ciphertext" IS NOT NULL AND "api_key_key_id" IS NOT NULL AND "api_key_encrypted_at" IS NOT NULL AND "api_key" IS NULL)
  );
--> statement-breakpoint
ALTER TABLE "email_import_accounts" ADD CONSTRAINT "email_import_accounts_refresh_envelope_chk"
  CHECK (
    ("refresh_token_encrypted" IS NULL AND "refresh_token_key_id" IS NULL AND "refresh_token_encrypted_at" IS NULL)
    OR
    ("refresh_token_encrypted" IS NOT NULL AND left("refresh_token_encrypted", 5) <> 'mve1.' AND "refresh_token_key_id" IS NULL AND "refresh_token_encrypted_at" IS NULL)
    OR
    ("refresh_token_encrypted" IS NOT NULL AND left("refresh_token_encrypted", 5) = 'mve1.' AND "refresh_token_key_id" IS NOT NULL AND "refresh_token_encrypted_at" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "switchboards" ADD CONSTRAINT "switchboards_qr_envelope_chk"
  CHECK (
    ("qr_token_ciphertext" IS NULL AND "qr_token_key_id" IS NULL AND "qr_token_encrypted_at" IS NULL)
    OR
    (left("qr_token_ciphertext", 3) = 'v1.' AND "qr_token_key_id" IS NULL AND "qr_token_encrypted_at" IS NULL)
    OR
    (left("qr_token_ciphertext", 5) = 'mve1.' AND "qr_token_key_id" IS NOT NULL AND "qr_token_encrypted_at" IS NOT NULL)
  );
--> statement-breakpoint
ALTER TABLE "backup_log" ADD CONSTRAINT "backup_log_encryption_metadata_chk"
  CHECK (
    ("encryption_format" IS NULL AND "encryption_key_id" IS NULL)
    OR
    ("encryption_format" = 'mve1' AND "encryption_key_id" IS NOT NULL)
  );

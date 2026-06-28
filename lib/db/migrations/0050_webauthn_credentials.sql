-- Migration 0047: WebAuthn / passkey credentials
-- Adds the webauthn_credentials table for biometric login and vault re-verification.

CREATE TABLE IF NOT EXISTS "webauthn_credentials" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL,
  "credential_id" text NOT NULL UNIQUE,
  "public_key" text NOT NULL,
  "counter" bigint NOT NULL DEFAULT 0,
  "device_name" text,
  "created_at" timestamp NOT NULL DEFAULT now()
);

ALTER TABLE "webauthn_credentials"
  ADD CONSTRAINT "webauthn_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_webauthn_credentials_user_id"
  ON "webauthn_credentials" ("user_id");

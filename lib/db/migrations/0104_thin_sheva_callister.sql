CREATE TABLE "ppe_public_evidence_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"purpose" text NOT NULL,
	"version" integer NOT NULL,
	"data_snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"confirmation_text" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ppe_public_evidence_versions_assignment_purpose_version_uq" UNIQUE("assignment_id","purpose","version"),
	CONSTRAINT "ppe_public_evidence_versions_purpose_chk" CHECK ("ppe_public_evidence_versions"."purpose" in ('ppe_signature', 'ppe_confirmation')),
	CONSTRAINT "ppe_public_evidence_versions_version_chk" CHECK ("ppe_public_evidence_versions"."version" > 0),
	CONSTRAINT "ppe_public_evidence_versions_hash_chk" CHECK ("ppe_public_evidence_versions"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ppe_public_evidence_versions_confirmation_text_chk" CHECK (length(btrim("ppe_public_evidence_versions"."confirmation_text")) > 0)
);
--> statement-breakpoint
CREATE TABLE "ppe_public_evidence_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"evidence_version_id" integer NOT NULL,
	"public_access_token_id" integer NOT NULL,
	"action" text NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"confirmation_text" text NOT NULL,
	"signature_object_path" text,
	"signature_sha256" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ppe_public_evidence_events_token_uq" UNIQUE("public_access_token_id"),
	CONSTRAINT "ppe_public_evidence_events_action_chk" CHECK ("ppe_public_evidence_events"."action" in ('signed', 'confirmed')),
	CONSTRAINT "ppe_public_evidence_events_snapshot_hash_chk" CHECK ("ppe_public_evidence_events"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ppe_public_evidence_events_signature_chk" CHECK ((
        "ppe_public_evidence_events"."action" = 'signed' and
        "ppe_public_evidence_events"."signature_object_path" is not null and
        "ppe_public_evidence_events"."signature_sha256" ~ '^[0-9a-f]{64}$'
      ) or (
        "ppe_public_evidence_events"."action" = 'confirmed' and
        "ppe_public_evidence_events"."signature_object_path" is null and
        "ppe_public_evidence_events"."signature_sha256" is null
      )),
	CONSTRAINT "ppe_public_evidence_events_confirmation_text_chk" CHECK (length(btrim("ppe_public_evidence_events"."confirmation_text")) > 0)
);
--> statement-breakpoint
ALTER TABLE "public_access_tokens" DROP CONSTRAINT "public_access_tokens_artifact_binding_chk";--> statement-breakpoint
ALTER TABLE "public_access_tokens" DROP CONSTRAINT "public_access_tokens_consume_action_chk";--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "ppe_evidence_version_id" integer;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "owner_kind" text;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "owner_user_id" integer;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "owner_assigned_at" timestamp;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "owner_assignment_source" text;--> statement-breakpoint
ALTER TABLE "switchboards" ADD COLUMN "qr_owner_kind" text;--> statement-breakpoint
ALTER TABLE "switchboards" ADD COLUMN "qr_owner_user_id" integer;--> statement-breakpoint
ALTER TABLE "switchboards" ADD COLUMN "qr_owner_assigned_at" timestamp;--> statement-breakpoint
ALTER TABLE "switchboards" ADD COLUMN "qr_owner_assignment_source" text;--> statement-breakpoint
ALTER TABLE "ppe_public_evidence_versions" ADD CONSTRAINT "ppe_public_evidence_versions_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_public_evidence_versions" ADD CONSTRAINT "ppe_public_evidence_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_public_evidence_events" ADD CONSTRAINT "ppe_public_evidence_events_assignment_id_ppe_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."ppe_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_public_evidence_events" ADD CONSTRAINT "ppe_public_evidence_events_evidence_version_id_ppe_public_evidence_versions_id_fk" FOREIGN KEY ("evidence_version_id") REFERENCES "public"."ppe_public_evidence_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ppe_public_evidence_events" ADD CONSTRAINT "ppe_public_evidence_events_public_access_token_id_public_access_tokens_id_fk" FOREIGN KEY ("public_access_token_id") REFERENCES "public"."public_access_tokens"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ppe_public_evidence_versions_assignment_idx" ON "ppe_public_evidence_versions" USING btree ("assignment_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "ppe_public_evidence_events_assignment_idx" ON "ppe_public_evidence_events" USING btree ("assignment_id","created_at");--> statement-breakpoint
CREATE INDEX "ppe_public_evidence_events_version_idx" ON "ppe_public_evidence_events" USING btree ("evidence_version_id");--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_ppe_evidence_version_id_ppe_public_evidence_versions_id_fk" FOREIGN KEY ("ppe_evidence_version_id") REFERENCES "public"."ppe_public_evidence_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "switchboards" ADD CONSTRAINT "switchboards_qr_owner_user_id_users_id_fk" FOREIGN KEY ("qr_owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "public_access_tokens_active_owner_idx" ON "public_access_tokens" USING btree ("owner_kind","owner_user_id","expires_at") WHERE "public_access_tokens"."revoked_at" is null and "public_access_tokens"."consumed_at" is null;--> statement-breakpoint
CREATE INDEX "public_access_tokens_ppe_evidence_version_idx" ON "public_access_tokens" USING btree ("ppe_evidence_version_id");--> statement-breakpoint
CREATE INDEX "switchboards_qr_enabled_owner_idx" ON "switchboards" USING btree ("qr_owner_kind","qr_owner_user_id","qr_expires_at") WHERE "switchboards"."qr_enabled" = true;--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_owner_assignment_chk" CHECK ((
        "public_access_tokens"."owner_kind" is null and
        "public_access_tokens"."owner_user_id" is null and
        "public_access_tokens"."owner_assigned_at" is null and
        "public_access_tokens"."owner_assignment_source" is null
      ) or (
        "public_access_tokens"."owner_kind" = 'organization' and
        "public_access_tokens"."owner_user_id" is null and
        "public_access_tokens"."owner_assigned_at" is not null and
        "public_access_tokens"."owner_assignment_source" in ('resource_organization', 'legacy_organization_assignment')
      ) or (
        "public_access_tokens"."owner_kind" = 'user' and
        "public_access_tokens"."owner_user_id" is not null and
        "public_access_tokens"."owner_assigned_at" is not null and
        "public_access_tokens"."owner_assignment_source" in ('manual_user_assignment', 'offboarding_transfer')
      ));--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_artifact_binding_chk" CHECK ((
        "public_access_tokens"."purpose" in ('ppe_signature', 'ppe_confirmation') and (
          ("public_access_tokens"."artifact_binding_status" = 'bound' and "public_access_tokens"."ppe_evidence_version_id" is not null and "public_access_tokens"."job_document_version_id" is null and "public_access_tokens"."quote_version_id" is null) or
          ("public_access_tokens"."artifact_binding_status" = 'not_applicable' and "public_access_tokens"."ppe_evidence_version_id" is null and "public_access_tokens"."job_document_version_id" is null and "public_access_tokens"."quote_version_id" is null)
        )
      ) or (
        "public_access_tokens"."purpose" = 'job_signature' and (
          ("public_access_tokens"."artifact_binding_status" = 'bound' and "public_access_tokens"."job_document_version_id" is not null and "public_access_tokens"."quote_version_id" is null and "public_access_tokens"."ppe_evidence_version_id" is null) or
          ("public_access_tokens"."artifact_binding_status" = 'legacy_unbound' and "public_access_tokens"."job_document_version_id" is null and "public_access_tokens"."quote_version_id" is null and "public_access_tokens"."ppe_evidence_version_id" is null)
        )
      ) or (
        "public_access_tokens"."purpose" = 'quote_decision' and (
          ("public_access_tokens"."artifact_binding_status" = 'bound' and "public_access_tokens"."quote_version_id" is not null and "public_access_tokens"."job_document_version_id" is null and "public_access_tokens"."ppe_evidence_version_id" is null) or
          ("public_access_tokens"."artifact_binding_status" = 'legacy_unbound' and "public_access_tokens"."quote_version_id" is null and "public_access_tokens"."job_document_version_id" is null and "public_access_tokens"."ppe_evidence_version_id" is null)
        )
      ));--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_consume_action_chk" CHECK ((
        "public_access_tokens"."consumed_at" is null and "public_access_tokens"."consume_action" is null
      ) or (
        "public_access_tokens"."consumed_at" is not null and (
          ("public_access_tokens"."purpose" in ('job_signature', 'ppe_signature') and "public_access_tokens"."consume_action" = 'signed') or
          ("public_access_tokens"."purpose" = 'ppe_confirmation' and "public_access_tokens"."consume_action" = 'confirmed') or
          ("public_access_tokens"."purpose" = 'quote_decision' and "public_access_tokens"."consume_action" in ('accepted', 'rejected'))
        )
      ));--> statement-breakpoint
ALTER TABLE "switchboards" ADD CONSTRAINT "switchboards_qr_owner_assignment_chk" CHECK ((
      "switchboards"."qr_owner_kind" is null and
      "switchboards"."qr_owner_user_id" is null and
      "switchboards"."qr_owner_assigned_at" is null and
      "switchboards"."qr_owner_assignment_source" is null
    ) or (
      "switchboards"."qr_owner_kind" = 'resource' and
      "switchboards"."qr_owner_user_id" is null and
      "switchboards"."qr_owner_assigned_at" is not null and
      "switchboards"."qr_owner_assignment_source" in ('switchboard_resource', 'legacy_resource_assignment')
    ) or (
      "switchboards"."qr_owner_kind" = 'user' and
      "switchboards"."qr_owner_user_id" is not null and
      "switchboards"."qr_owner_assigned_at" is not null and
      "switchboards"."qr_owner_assignment_source" in ('manual_user_assignment', 'offboarding_transfer')
    ));--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_ppe_public_evidence_event_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  evidence_assignment_id integer;
  evidence_purpose text;
  evidence_snapshot_sha256 text;
  evidence_confirmation_text text;
  token_resource_id integer;
  token_resource_type text;
  token_purpose text;
  token_artifact_binding_status text;
  token_evidence_version_id integer;
BEGIN
  SELECT
    assignment_id,
    purpose,
    snapshot_sha256,
    confirmation_text
  INTO
    evidence_assignment_id,
    evidence_purpose,
    evidence_snapshot_sha256,
    evidence_confirmation_text
  FROM ppe_public_evidence_versions
  WHERE id = NEW.evidence_version_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'PPE public evidence event references a missing evidence version';
  END IF;

  SELECT
    resource_id,
    resource_type,
    purpose,
    artifact_binding_status,
    ppe_evidence_version_id
  INTO
    token_resource_id,
    token_resource_type,
    token_purpose,
    token_artifact_binding_status,
    token_evidence_version_id
  FROM public_access_tokens
  WHERE id = NEW.public_access_token_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'PPE public evidence event references a missing public access token';
  END IF;

  IF NEW.assignment_id IS DISTINCT FROM evidence_assignment_id
    OR NEW.assignment_id IS DISTINCT FROM token_resource_id
    OR NEW.evidence_version_id IS DISTINCT FROM token_evidence_version_id
    OR token_resource_type IS DISTINCT FROM 'ppe_assignment'
    OR token_artifact_binding_status IS DISTINCT FROM 'bound'
    OR token_purpose IS DISTINCT FROM evidence_purpose
    OR NOT (
      (token_purpose = 'ppe_signature' AND NEW.action = 'signed') OR
      (token_purpose = 'ppe_confirmation' AND NEW.action = 'confirmed')
    )
    OR NEW.snapshot_sha256 IS DISTINCT FROM evidence_snapshot_sha256
    OR NEW.confirmation_text IS DISTINCT FROM evidence_confirmation_text
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'PPE public evidence event binding is inconsistent';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER ppe_public_evidence_events_binding
  BEFORE INSERT ON "ppe_public_evidence_events"
  FOR EACH ROW EXECUTE FUNCTION validate_ppe_public_evidence_event_binding();--> statement-breakpoint
CREATE TRIGGER ppe_public_evidence_versions_immutable
  BEFORE UPDATE OR DELETE ON "ppe_public_evidence_versions"
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER ppe_public_evidence_events_immutable
  BEFORE UPDATE OR DELETE ON "ppe_public_evidence_events"
  FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();

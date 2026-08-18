CREATE TABLE "job_document_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'pending_signature' NOT NULL,
	"supersedes_version_id" integer,
	"data_snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"renderer_version" text NOT NULL,
	"confirmation_text" text NOT NULL,
	"signatory_name" text,
	"identity_assurance" text,
	"signature_object_path" text,
	"signature_sha256" text,
	"pdf_object_path" text,
	"pdf_sha256" text,
	"signed_at" timestamp,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_document_versions_status_chk" CHECK ("status" in ('pending_signature', 'signed')),
	CONSTRAINT "job_document_versions_snapshot_hash_chk" CHECK ("snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "job_document_versions_signed_fields_chk" CHECK ((
		"status" = 'pending_signature' and
		"signatory_name" is null and "identity_assurance" is null and
		"signature_object_path" is null and "signature_sha256" is null and
		"pdf_object_path" is null and "pdf_sha256" is null and "signed_at" is null
	) or (
		"status" = 'signed' and
		length(btrim("signatory_name")) >= 2 and "identity_assurance" = 'self_declared_name' and
		"signature_object_path" is not null and "signature_sha256" ~ '^[0-9a-f]{64}$' and
		"pdf_object_path" is not null and "pdf_sha256" ~ '^[0-9a-f]{64}$' and
		"signed_at" is not null
	))
);
--> statement-breakpoint
CREATE TABLE "job_signature_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"document_version_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" integer,
	"actor_name" text,
	"identity_assurance" text,
	"confirmation_text" text,
	"reason" text,
	"user_agent_sha256" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_signature_events_type_chk" CHECK ("event_type" in ('signed', 'superseded', 'cancelled')),
	CONSTRAINT "job_signature_events_actor_type_chk" CHECK ("actor_type" in ('public_signer', 'admin', 'system')),
	CONSTRAINT "job_signature_events_user_agent_hash_chk" CHECK ("user_agent_sha256" is null or "user_agent_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "quote_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"version" integer NOT NULL,
	"supersedes_version_id" integer,
	"data_snapshot" jsonb NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"pdf_object_path" text NOT NULL,
	"pdf_sha256" text NOT NULL,
	"renderer_version" text NOT NULL,
	"created_by_user_id" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "quote_versions_snapshot_hash_chk" CHECK ("snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "quote_versions_pdf_hash_chk" CHECK ("pdf_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "quote_decision_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"quote_id" integer NOT NULL,
	"quote_version_id" integer NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" integer,
	"actor_name" text,
	"identity_assurance" text,
	"confirmation_text" text,
	"reason" text,
	"user_agent_sha256" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "quote_decision_events_action_chk" CHECK ("action" in ('accepted', 'rejected', 'expired', 'superseded')),
	CONSTRAINT "quote_decision_events_actor_type_chk" CHECK ("actor_type" in ('public_recipient', 'admin', 'system')),
	CONSTRAINT "quote_decision_events_user_agent_hash_chk" CHECK ("user_agent_sha256" is null or "user_agent_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "job_document_versions" ADD CONSTRAINT "job_document_versions_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_document_versions" ADD CONSTRAINT "job_document_versions_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."job_document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_document_versions" ADD CONSTRAINT "job_document_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_signature_events" ADD CONSTRAINT "job_signature_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_signature_events" ADD CONSTRAINT "job_signature_events_document_version_id_job_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."job_document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "job_signature_events" ADD CONSTRAINT "job_signature_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_versions" ADD CONSTRAINT "quote_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_decision_events" ADD CONSTRAINT "quote_decision_events_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_decision_events" ADD CONSTRAINT "quote_decision_events_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "quote_decision_events" ADD CONSTRAINT "quote_decision_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "job_document_versions_job_version_uq" ON "job_document_versions" USING btree ("job_id", "version");
--> statement-breakpoint
CREATE INDEX "job_document_versions_job_created_idx" ON "job_document_versions" USING btree ("job_id", "created_at");
--> statement-breakpoint
CREATE INDEX "job_signature_events_job_created_idx" ON "job_signature_events" USING btree ("job_id", "created_at");
--> statement-breakpoint
CREATE INDEX "job_signature_events_version_idx" ON "job_signature_events" USING btree ("document_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "quote_versions_quote_version_uq" ON "quote_versions" USING btree ("quote_id", "version");
--> statement-breakpoint
CREATE INDEX "quote_versions_quote_created_idx" ON "quote_versions" USING btree ("quote_id", "created_at");
--> statement-breakpoint
CREATE INDEX "quote_decision_events_quote_created_idx" ON "quote_decision_events" USING btree ("quote_id", "created_at");
--> statement-breakpoint
CREATE INDEX "quote_decision_events_version_idx" ON "quote_decision_events" USING btree ("quote_version_id");
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "artifact_binding_status" text;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "job_document_version_id" integer;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD COLUMN "quote_version_id" integer;
--> statement-breakpoint
UPDATE "public_access_tokens"
SET "artifact_binding_status" = CASE
	WHEN "purpose" IN ('ppe_signature', 'ppe_confirmation') THEN 'not_applicable'
	ELSE 'legacy_unbound'
END;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ALTER COLUMN "artifact_binding_status" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_job_document_version_id_job_document_versions_id_fk" FOREIGN KEY ("job_document_version_id") REFERENCES "public"."job_document_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_quote_version_id_quote_versions_id_fk" FOREIGN KEY ("quote_version_id") REFERENCES "public"."quote_versions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "public_access_tokens_job_version_idx" ON "public_access_tokens" USING btree ("job_document_version_id");
--> statement-breakpoint
CREATE INDEX "public_access_tokens_quote_version_idx" ON "public_access_tokens" USING btree ("quote_version_id");
--> statement-breakpoint
ALTER TABLE "public_access_tokens" ADD CONSTRAINT "public_access_tokens_artifact_binding_chk" CHECK ((
	"purpose" in ('ppe_signature', 'ppe_confirmation') and
	"artifact_binding_status" = 'not_applicable' and
	"job_document_version_id" is null and "quote_version_id" is null
) or (
	"purpose" = 'job_signature' and (
		("artifact_binding_status" = 'bound' and "job_document_version_id" is not null and "quote_version_id" is null) or
		("artifact_binding_status" = 'legacy_unbound' and "job_document_version_id" is null and "quote_version_id" is null)
	)
) or (
	"purpose" = 'quote_decision' and (
		("artifact_binding_status" = 'bound' and "quote_version_id" is not null and "job_document_version_id" is null) or
		("artifact_binding_status" = 'legacy_unbound' and "quote_version_id" is null and "job_document_version_id" is null)
	)
));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION deny_immutable_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	-- A user-account erasure may activate an ON DELETE SET NULL foreign key.
	-- The self-declared/authenticated actor name and every other evidence field
	-- remain frozen; only the now-invalid database identifier may be cleared.
	IF TG_OP = 'UPDATE' AND (
		(
			to_jsonb(OLD) ? 'actor_user_id'
			AND to_jsonb(OLD)->'actor_user_id' <> 'null'::jsonb
			AND to_jsonb(NEW)->'actor_user_id' = 'null'::jsonb
			AND to_jsonb(NEW) - 'actor_user_id' = to_jsonb(OLD) - 'actor_user_id'
		) OR (
			to_jsonb(OLD) ? 'created_by_user_id'
			AND to_jsonb(OLD)->'created_by_user_id' <> 'null'::jsonb
			AND to_jsonb(NEW)->'created_by_user_id' = 'null'::jsonb
			AND to_jsonb(NEW) - 'created_by_user_id' = to_jsonb(OLD) - 'created_by_user_id'
		)
	) THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION '% is immutable; append a correction event or a new version', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_job_document_version_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'job_document_versions is immutable; append a correction event or a new version';
	END IF;
	IF OLD.created_by_user_id IS NOT NULL
		AND NEW.created_by_user_id IS NULL
		AND to_jsonb(NEW) - 'created_by_user_id' = to_jsonb(OLD) - 'created_by_user_id'
	THEN
		RETURN NEW;
	END IF;
	IF OLD.status = 'pending_signature' AND NEW.status = 'signed'
		AND NEW.id = OLD.id
		AND NEW.job_id = OLD.job_id
		AND NEW.version = OLD.version
		AND NEW.supersedes_version_id IS NOT DISTINCT FROM OLD.supersedes_version_id
		AND NEW.data_snapshot = OLD.data_snapshot
		AND NEW.snapshot_sha256 = OLD.snapshot_sha256
		AND NEW.renderer_version = OLD.renderer_version
		AND NEW.confirmation_text = OLD.confirmation_text
		AND NEW.created_by_user_id IS NOT DISTINCT FROM OLD.created_by_user_id
		AND NEW.created_at = OLD.created_at
	THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'job_document_versions permits only one pending_signature to signed transition';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "job_document_versions_immutable_trg"
BEFORE UPDATE OR DELETE ON "job_document_versions"
FOR EACH ROW EXECUTE FUNCTION guard_job_document_version_transition();
--> statement-breakpoint
CREATE TRIGGER "job_signature_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "job_signature_events"
FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "quote_versions_immutable_trg"
BEFORE UPDATE OR DELETE ON "quote_versions"
FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();
--> statement-breakpoint
CREATE TRIGGER "quote_decision_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "quote_decision_events"
FOR EACH ROW EXECUTE FUNCTION deny_immutable_evidence_mutation();

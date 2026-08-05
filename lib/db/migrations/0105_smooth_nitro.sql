CREATE TABLE "external_account_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_user_id" integer NOT NULL,
	"scope_id" integer,
	"actor_user_id" integer,
	"event_type" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_account_events_type_chk" CHECK ("external_account_events"."event_type" in (
        'account_created',
        'account_activated',
        'account_suspended',
        'account_access_reviewed',
        'account_revoked',
        'custodian_transferred',
        'scope_granted',
        'scope_revoked'
      ))
);
--> statement-breakpoint
CREATE TABLE "external_account_scopes" (
	"id" serial PRIMARY KEY NOT NULL,
	"external_user_id" integer NOT NULL,
	"job_id" integer,
	"quote_id" integer,
	"switchboard_id" integer,
	"capability" text DEFAULT 'read' NOT NULL,
	"starts_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revocation_reason" text,
	CONSTRAINT "external_account_scopes_resource_chk" CHECK (num_nonnulls("external_account_scopes"."job_id", "external_account_scopes"."quote_id", "external_account_scopes"."switchboard_id") = 1),
	CONSTRAINT "external_account_scopes_capability_chk" CHECK ("external_account_scopes"."capability" = 'read'),
	CONSTRAINT "external_account_scopes_expiry_chk" CHECK ("external_account_scopes"."expires_at" > "external_account_scopes"."starts_at"),
	CONSTRAINT "external_account_scopes_revocation_chk" CHECK ((
        "external_account_scopes"."revoked_at" is null and
        "external_account_scopes"."revoked_by_user_id" is null and
        "external_account_scopes"."revocation_reason" is null
      ) or (
        "external_account_scopes"."revoked_at" is not null and
        "external_account_scopes"."revoked_by_user_id" is not null and
        "external_account_scopes"."revocation_reason" is not null and
        length(btrim("external_account_scopes"."revocation_reason")) >= 3
      ))
);
--> statement-breakpoint
CREATE TABLE "external_accounts" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"custodian_user_id" integer NOT NULL,
	"access_reviewed_at" timestamp DEFAULT now() NOT NULL,
	"access_expires_at" timestamp NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_by_user_id" integer NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by_user_id" integer,
	"revocation_reason" text,
	CONSTRAINT "external_accounts_status_chk" CHECK ("external_accounts"."status" in ('draft', 'active', 'suspended', 'revoked')),
	CONSTRAINT "external_accounts_version_chk" CHECK ("external_accounts"."version" > 0),
	CONSTRAINT "external_accounts_custodian_chk" CHECK ("external_accounts"."custodian_user_id" <> "external_accounts"."user_id"),
	CONSTRAINT "external_accounts_review_window_chk" CHECK ("external_accounts"."access_expires_at" > "external_accounts"."access_reviewed_at" and "external_accounts"."access_expires_at" <= "external_accounts"."access_reviewed_at" + interval '1 year'),
	CONSTRAINT "external_accounts_revocation_chk" CHECK ((
        "external_accounts"."status" = 'revoked' and
        "external_accounts"."revoked_at" is not null and
        "external_accounts"."revoked_by_user_id" is not null and
        "external_accounts"."revocation_reason" is not null and
        length(btrim("external_accounts"."revocation_reason")) >= 3
      ) or (
        "external_accounts"."status" <> 'revoked' and
        "external_accounts"."revoked_at" is null and
        "external_accounts"."revoked_by_user_id" is null and
        "external_accounts"."revocation_reason" is null
      ))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "account_type" text DEFAULT 'internal' NOT NULL;--> statement-breakpoint
ALTER TABLE "external_account_events" ADD CONSTRAINT "external_account_events_external_user_id_external_accounts_user_id_fk" FOREIGN KEY ("external_user_id") REFERENCES "public"."external_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_events" ADD CONSTRAINT "external_account_events_scope_id_external_account_scopes_id_fk" FOREIGN KEY ("scope_id") REFERENCES "public"."external_account_scopes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_events" ADD CONSTRAINT "external_account_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_external_user_id_external_accounts_user_id_fk" FOREIGN KEY ("external_user_id") REFERENCES "public"."external_accounts"("user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_switchboard_id_switchboards_id_fk" FOREIGN KEY ("switchboard_id") REFERENCES "public"."switchboards"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_account_scopes" ADD CONSTRAINT "external_account_scopes_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_custodian_user_id_users_id_fk" FOREIGN KEY ("custodian_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_account_events_user_idx" ON "external_account_events" USING btree ("external_user_id","created_at");--> statement-breakpoint
CREATE INDEX "external_account_scopes_lookup_idx" ON "external_account_scopes" USING btree ("external_user_id","starts_at","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "external_account_scopes_active_job_uq" ON "external_account_scopes" USING btree ("external_user_id","job_id","capability") WHERE "external_account_scopes"."revoked_at" is null and "external_account_scopes"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_account_scopes_active_quote_uq" ON "external_account_scopes" USING btree ("external_user_id","quote_id","capability") WHERE "external_account_scopes"."revoked_at" is null and "external_account_scopes"."quote_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "external_account_scopes_active_switchboard_uq" ON "external_account_scopes" USING btree ("external_user_id","switchboard_id","capability") WHERE "external_account_scopes"."revoked_at" is null and "external_account_scopes"."switchboard_id" is not null;--> statement-breakpoint
CREATE INDEX "external_accounts_custodian_idx" ON "external_accounts" USING btree ("custodian_user_id","status");--> statement-breakpoint
CREATE INDEX "external_accounts_expiry_idx" ON "external_accounts" USING btree ("status","access_expires_at");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_account_type_chk" CHECK ("users"."account_type" in ('internal', 'external'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_external_identity_shape_chk" CHECK ("users"."account_type" = 'internal' or ("users"."role" = 'guest' and "users"."person_id" is null));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_external_account_row()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	target_type text;
	target_role text;
	target_person_id integer;
	custodian_type text;
	custodian_active boolean;
BEGIN
	SELECT account_type, role, person_id
	  INTO target_type, target_role, target_person_id
	  FROM users
	 WHERE id = NEW.user_id;
	IF target_type IS DISTINCT FROM 'external'
		OR target_role IS DISTINCT FROM 'guest'
		OR target_person_id IS NOT NULL
	THEN
		RAISE EXCEPTION 'external account requires an external guest identity without person linkage';
	END IF;

	SELECT account_type, is_active
	  INTO custodian_type, custodian_active
	  FROM users
	 WHERE id = NEW.custodian_user_id;
	IF custodian_type IS DISTINCT FROM 'internal' OR custodian_active IS DISTINCT FROM true THEN
		RAISE EXCEPTION 'external account custodian must be an active internal user';
	END IF;

	IF TG_OP = 'UPDATE' AND NEW.version <> OLD.version + 1 THEN
		RAISE EXCEPTION 'external account mutation must increment version exactly once';
	END IF;

	IF NEW.status = 'active' AND (
		NEW.access_expires_at <= now()
		OR NOT EXISTS (
			SELECT 1
			  FROM external_account_scopes s
			 WHERE s.external_user_id = NEW.user_id
			   AND s.revoked_at IS NULL
			   AND s.starts_at <= now()
			   AND s.expires_at > now()
		)
	) THEN
		RAISE EXCEPTION 'active external account requires future expiry and at least one current scope';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER external_accounts_validate_trg
BEFORE INSERT OR UPDATE ON external_accounts
FOR EACH ROW EXECUTE FUNCTION validate_external_account_row();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION validate_external_account_scope_row()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
	account_status text;
	account_expiry timestamp;
BEGIN
	SELECT status, access_expires_at
	  INTO account_status, account_expiry
	  FROM external_accounts
	 WHERE user_id = NEW.external_user_id;
	IF account_status IS NULL OR account_status = 'revoked' THEN
		RAISE EXCEPTION 'scope requires a non-revoked external account';
	END IF;
	IF NEW.expires_at > account_expiry OR NEW.starts_at >= account_expiry THEN
		RAISE EXCEPTION 'scope may not outlive its external account';
	END IF;
	IF TG_OP = 'UPDATE' AND (
		NEW.external_user_id IS DISTINCT FROM OLD.external_user_id
		OR NEW.job_id IS DISTINCT FROM OLD.job_id
		OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
		OR NEW.switchboard_id IS DISTINCT FROM OLD.switchboard_id
		OR NEW.capability IS DISTINCT FROM OLD.capability
		OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
		OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
		OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
		OR NEW.created_at IS DISTINCT FROM OLD.created_at
	) THEN
		RAISE EXCEPTION 'external scope identity is immutable; revoke and append a replacement';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER external_account_scopes_validate_trg
BEFORE INSERT OR UPDATE ON external_account_scopes
FOR EACH ROW EXECUTE FUNCTION validate_external_account_scope_row();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION guard_external_identity_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF NEW.account_type = 'external' AND EXISTS (
		SELECT 1 FROM user_permission_overrides WHERE user_id = NEW.id
	) THEN
		RAISE EXCEPTION 'external accounts cannot have internal permission overrides';
	END IF;
	IF OLD.account_type = 'external' AND NEW.account_type <> 'external' AND EXISTS (
		SELECT 1 FROM external_accounts WHERE user_id = NEW.id
	) THEN
		RAISE EXCEPTION 'external account type cannot be converted in place';
	END IF;
	IF OLD.account_type = 'internal' AND OLD.is_active AND NOT NEW.is_active AND EXISTS (
		SELECT 1
		  FROM external_accounts
		 WHERE custodian_user_id = NEW.id
		   AND status <> 'revoked'
		   AND access_expires_at > now()
	) THEN
		RAISE EXCEPTION 'custodian has live external accounts; transfer or revoke them first';
	END IF;
	IF NEW.account_type = 'external' AND NEW.is_active AND NOT EXISTS (
		SELECT 1
		  FROM external_accounts
		 WHERE user_id = NEW.id
		   AND status = 'active'
		   AND revoked_at IS NULL
		   AND access_expires_at > now()
	) THEN
		RAISE EXCEPTION 'active external identity requires an active, unexpired profile';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_external_identity_guard_trg
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION guard_external_identity_row();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_external_permission_override()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (
		SELECT 1 FROM users WHERE id = NEW.user_id AND account_type = 'external'
	) THEN
		RAISE EXCEPTION 'external accounts cannot have internal permission overrides';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_permission_overrides_external_guard_trg
BEFORE INSERT OR UPDATE ON user_permission_overrides
FOR EACH ROW EXECUTE FUNCTION reject_external_permission_override();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION deny_external_ledger_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION '% is append-only; revoke or append an event instead', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER external_account_events_immutable_trg
BEFORE UPDATE OR DELETE ON external_account_events
FOR EACH ROW EXECUTE FUNCTION deny_external_ledger_delete();
--> statement-breakpoint
CREATE TRIGGER external_account_scopes_no_delete_trg
BEFORE DELETE ON external_account_scopes
FOR EACH ROW EXECUTE FUNCTION deny_external_ledger_delete();
--> statement-breakpoint
CREATE TRIGGER external_accounts_no_delete_trg
BEFORE DELETE ON external_accounts
FOR EACH ROW EXECUTE FUNCTION deny_external_ledger_delete();

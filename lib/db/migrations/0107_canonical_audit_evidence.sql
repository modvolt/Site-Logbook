CREATE TABLE "audit_chain_heads" (
	"stream_id" text PRIMARY KEY NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL,
	"ledger_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_heads_stream_chk" CHECK ("audit_chain_heads"."stream_id" = 'site-logbook:audit:global:v1'),
	CONSTRAINT "audit_chain_heads_state_chk" CHECK (("audit_chain_heads"."sequence" = 0 and "audit_chain_heads"."ledger_sha256" is null) or ("audit_chain_heads"."sequence" >= 1 and "audit_chain_heads"."ledger_sha256" is not null)),
	CONSTRAINT "audit_chain_heads_hash_chk" CHECK ("audit_chain_heads"."ledger_sha256" is null or "audit_chain_heads"."ledger_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"stream_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"canonical_event_json" text NOT NULL,
	"event_sha256" text NOT NULL,
	"canonical_ledger_json" text NOT NULL,
	"previous_ledger_sha256" text,
	"ledger_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_stream_chk" CHECK ("audit_events"."stream_id" = 'site-logbook:audit:global:v1'),
	CONSTRAINT "audit_events_sequence_chk" CHECK ("audit_events"."sequence" >= 1),
	CONSTRAINT "audit_events_previous_chk" CHECK (("audit_events"."sequence" = 1 and "audit_events"."previous_ledger_sha256" is null) or ("audit_events"."sequence" > 1 and "audit_events"."previous_ledger_sha256" is not null)),
	CONSTRAINT "audit_events_event_json_chk" CHECK ((jsonb_typeof(("audit_events"."canonical_event_json")::jsonb) = 'object') is true),
	CONSTRAINT "audit_events_ledger_json_chk" CHECK ((jsonb_typeof(("audit_events"."canonical_ledger_json")::jsonb) = 'object') is true),
	CONSTRAINT "audit_events_event_hash_chk" CHECK ("audit_events"."event_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_events_previous_hash_chk" CHECK ("audit_events"."previous_ledger_sha256" is null or "audit_events"."previous_ledger_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_events_ledger_hash_chk" CHECK ("audit_events"."ledger_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_events_event_shape_chk" CHECK ((("audit_events"."canonical_event_json"::jsonb - array['schemaVersion','eventId','occurredAt','actor','source','action','entity','reason','state','correlation','artifactRefs','integrity']) = '{}'::jsonb
        and "audit_events"."canonical_event_json"::jsonb ?& array['schemaVersion','eventId','occurredAt','actor','source','action','entity','reason','state','correlation','artifactRefs','integrity']) is true),
	CONSTRAINT "audit_events_ledger_shape_chk" CHECK ((("audit_events"."canonical_ledger_json"::jsonb - array['schemaVersion','streamId','sequence','eventId','eventSha256','recordedAt','previousLedgerSha256','integrity']) = '{}'::jsonb
        and "audit_events"."canonical_ledger_json"::jsonb ?& array['schemaVersion','streamId','sequence','eventId','eventSha256','recordedAt','previousLedgerSha256','integrity']
        and (("audit_events"."canonical_ledger_json"::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','ledgerSha256']) = '{}'::jsonb
        and ("audit_events"."canonical_ledger_json"::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','ledgerSha256']) is true),
	CONSTRAINT "audit_events_event_binding_chk" CHECK ((("audit_events"."canonical_event_json"::jsonb ->> 'schemaVersion') = 'site-logbook.audit-event/v1'
        and ("audit_events"."canonical_event_json"::jsonb ->> 'eventId') = "audit_events"."event_id"::text
        and ("audit_events"."canonical_event_json"::jsonb ->> 'occurredAt')::timestamptz = "audit_events"."occurred_at"
        and ("audit_events"."canonical_event_json"::jsonb #>> '{integrity,eventSha256}') = "audit_events"."event_sha256") is true),
	CONSTRAINT "audit_events_ledger_binding_chk" CHECK ((("audit_events"."canonical_ledger_json"::jsonb ->> 'schemaVersion') = 'site-logbook.audit-chain-record/v1'
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'streamId') = "audit_events"."stream_id"
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'sequence') = "audit_events"."sequence"::text
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'eventId') = "audit_events"."event_id"::text
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'eventSha256') = "audit_events"."event_sha256"
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'recordedAt')::timestamptz = "audit_events"."occurred_at"
        and ("audit_events"."canonical_ledger_json"::jsonb ->> 'previousLedgerSha256') is not distinct from "audit_events"."previous_ledger_sha256"
        and ("audit_events"."canonical_ledger_json"::jsonb #>> '{integrity,ledgerSha256}') = "audit_events"."ledger_sha256") is true)
);
--> statement-breakpoint
CREATE TABLE "audit_export_outbox" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"stream_id" text NOT NULL,
	"through_sequence" bigint NOT NULL,
	"through_ledger_sha256" text NOT NULL,
	"event_sha256" text NOT NULL,
	"intent_created_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"intent_sha256" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"object_key" text,
	"object_version_id" text,
	"object_sha256" text,
	"exported_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_failure_category" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_export_outbox_identity_chk" CHECK ("audit_export_outbox"."intent_id" = "audit_export_outbox"."event_id" and "audit_export_outbox"."stream_id" = 'site-logbook:audit:global:v1'),
	CONSTRAINT "audit_export_outbox_sequence_chk" CHECK ("audit_export_outbox"."through_sequence" >= 1),
	CONSTRAINT "audit_export_outbox_hashes_chk" CHECK ("audit_export_outbox"."through_ledger_sha256" ~ '^[0-9a-f]{64}$' and "audit_export_outbox"."event_sha256" ~ '^[0-9a-f]{64}$' and "audit_export_outbox"."intent_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "audit_export_outbox_state_chk" CHECK ("audit_export_outbox"."state" in ('pending', 'exporting', 'exported', 'dead_letter')),
	CONSTRAINT "audit_export_outbox_attempt_chk" CHECK ("audit_export_outbox"."attempt_count" >= 0),
	CONSTRAINT "audit_export_outbox_lease_chk" CHECK (("audit_export_outbox"."state" = 'exporting' and "audit_export_outbox"."lease_token" is not null and "audit_export_outbox"."lease_expires_at" is not null) or ("audit_export_outbox"."state" <> 'exporting' and "audit_export_outbox"."lease_token" is null and "audit_export_outbox"."lease_expires_at" is null)),
	CONSTRAINT "audit_export_outbox_terminal_chk" CHECK ((("audit_export_outbox"."state" = 'exported' and "audit_export_outbox"."exported_at" is not null and length(btrim("audit_export_outbox"."object_key")) > 0 and length(btrim("audit_export_outbox"."object_version_id")) between 1 and 512 and "audit_export_outbox"."object_sha256" ~ '^[0-9a-f]{64}$' and "audit_export_outbox"."dead_lettered_at" is null) or ("audit_export_outbox"."state" = 'dead_letter' and "audit_export_outbox"."dead_lettered_at" is not null and "audit_export_outbox"."exported_at" is null and num_nonnulls("audit_export_outbox"."object_key", "audit_export_outbox"."object_version_id", "audit_export_outbox"."object_sha256") = 0) or ("audit_export_outbox"."state" in ('pending', 'exporting') and "audit_export_outbox"."exported_at" is null and "audit_export_outbox"."dead_lettered_at" is null and num_nonnulls("audit_export_outbox"."object_key", "audit_export_outbox"."object_version_id", "audit_export_outbox"."object_sha256") = 0)) is true),
	CONSTRAINT "audit_export_outbox_receipt_binding_chk" CHECK (("audit_export_outbox"."object_key" is null or ("audit_export_outbox"."object_key" = 'audit-evidence/v1/' || "audit_export_outbox"."intent_id"::text || '/' || "audit_export_outbox"."intent_sha256" || '/audit.jsonl' and "audit_export_outbox"."object_version_id" !~ '[[:space:][:cntrl:]]')) is true),
	CONSTRAINT "audit_export_outbox_failure_category_chk" CHECK ("audit_export_outbox"."last_failure_category" is null or "audit_export_outbox"."last_failure_category" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "audit_export_outbox_canonical_json_chk" CHECK ((jsonb_typeof(("audit_export_outbox"."canonical_json")::jsonb) = 'object') is true),
	CONSTRAINT "audit_export_outbox_canonical_shape_chk" CHECK ((("audit_export_outbox"."canonical_json"::jsonb - array['schemaVersion','intentId','kind','createdAt','streamId','throughSequence','throughLedgerSha256','eventId','eventSha256','destination','initialState','integrity']) = '{}'::jsonb
        and "audit_export_outbox"."canonical_json"::jsonb ?& array['schemaVersion','intentId','kind','createdAt','streamId','throughSequence','throughLedgerSha256','eventId','eventSha256','destination','initialState','integrity']
        and (("audit_export_outbox"."canonical_json"::jsonb -> 'destination') - array['kind','namespace','format']) = '{}'::jsonb
        and ("audit_export_outbox"."canonical_json"::jsonb -> 'destination') ?& array['kind','namespace','format']
        and (("audit_export_outbox"."canonical_json"::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','intentSha256']) = '{}'::jsonb
        and ("audit_export_outbox"."canonical_json"::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','intentSha256']) is true),
	CONSTRAINT "audit_export_outbox_canonical_binding_chk" CHECK ((("audit_export_outbox"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.audit-export-intent/v1'
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'intentId') = "audit_export_outbox"."intent_id"::text
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'kind') = 'audit-chain-export'
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'createdAt')::timestamptz = "audit_export_outbox"."intent_created_at"
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'streamId') = "audit_export_outbox"."stream_id"
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'throughSequence') = "audit_export_outbox"."through_sequence"::text
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'throughLedgerSha256') = "audit_export_outbox"."through_ledger_sha256"
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'eventId') = "audit_export_outbox"."event_id"::text
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'eventSha256') = "audit_export_outbox"."event_sha256"
        and ("audit_export_outbox"."canonical_json"::jsonb #>> '{destination,kind}') = 'versioned-object-storage'
        and ("audit_export_outbox"."canonical_json"::jsonb #>> '{destination,namespace}') = 'audit-evidence/v1'
        and ("audit_export_outbox"."canonical_json"::jsonb #>> '{destination,format}') = 'site-logbook.audit-jsonl/v1'
        and ("audit_export_outbox"."canonical_json"::jsonb ->> 'initialState') = 'pending'
        and ("audit_export_outbox"."canonical_json"::jsonb #>> '{integrity,intentSha256}') = "audit_export_outbox"."intent_sha256") is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_stream_sequence_uq" ON "audit_events" USING btree ("stream_id","sequence");--> statement-breakpoint
ALTER TABLE "audit_export_outbox" ADD CONSTRAINT "audit_export_outbox_event_id_audit_events_event_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."audit_events"("event_id") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
ALTER TABLE "audit_export_outbox" ADD CONSTRAINT "audit_export_outbox_event_sequence_fk" FOREIGN KEY ("stream_id","through_sequence") REFERENCES "public"."audit_events"("stream_id","sequence") ON DELETE restrict ON UPDATE restrict;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_event_hash_uq" ON "audit_events" USING btree ("event_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_events_ledger_hash_uq" ON "audit_events" USING btree ("ledger_sha256");--> statement-breakpoint
CREATE INDEX "audit_events_occurred_idx" ON "audit_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_export_outbox_event_uq" ON "audit_export_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "audit_export_outbox_claim_idx" ON "audit_export_outbox" USING btree ("state","available_at","lease_expires_at");

-- Reviewed R09 integrity tail. PostgreSQL recomputes the same compact,
-- lexicographically-keyed canonical bytes as the application contract. Audit
-- envelopes contain only safe integer JSON numbers; decimal or unsafe numeric
-- values are rejected instead of being assigned ambiguous JS/PG semantics.
CREATE OR REPLACE FUNCTION audit_json_has_exact_keys(value jsonb, expected text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'object'
     AND (value - expected) = '{}'::jsonb
     AND value ?& expected;
$$;

CREATE OR REPLACE FUNCTION audit_json_is_sha256(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'string'
     AND (value #>> '{}') ~ '^[0-9a-f]{64}$';
$$;

CREATE OR REPLACE FUNCTION audit_json_is_string_or_null(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) IN ('string', 'null');
$$;

CREATE OR REPLACE FUNCTION audit_json_is_safe_integer(
  value jsonb,
  minimum numeric,
  maximum numeric
)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'number'
     AND (value #>> '{}')::numeric = trunc((value #>> '{}')::numeric)
     AND (value #>> '{}')::numeric BETWEEN minimum AND maximum;
$$;

CREATE OR REPLACE FUNCTION audit_canonical_json(value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  kind text := jsonb_typeof(value);
  result text;
  numeric_value numeric;
BEGIN
  CASE kind
    WHEN 'null' THEN RETURN 'null';
    WHEN 'boolean' THEN RETURN value::text;
    WHEN 'string' THEN RETURN to_json(value #>> '{}')::text;
    WHEN 'number' THEN
      numeric_value := (value #>> '{}')::numeric;
      IF numeric_value <> trunc(numeric_value) OR
         abs(numeric_value) > 9007199254740991 THEN
        RAISE EXCEPTION 'audit canonical JSON permits only safe integer numbers';
      END IF;
      RETURN trim_scale(numeric_value)::text;
    WHEN 'array' THEN
      SELECT '[' || coalesce(
        string_agg(audit_canonical_json(item), ',' ORDER BY ordinal),
        ''
      ) || ']'
      INTO result
      FROM jsonb_array_elements(value) WITH ORDINALITY AS element(item, ordinal);
      RETURN result;
    WHEN 'object' THEN
      SELECT '{' || coalesce(
        string_agg(
          to_json(key)::text || ':' || audit_canonical_json(value -> key),
          ',' ORDER BY key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO result
      FROM jsonb_object_keys(value) AS object_key(key);
      RETURN result;
    ELSE
      RAISE EXCEPTION 'unsupported audit canonical JSON type: %', kind;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION audit_domain_sha256(domain text, canonical_json text)
RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT encode(
    sha256(
      convert_to(domain, 'UTF8') ||
      decode('00', 'hex') ||
      convert_to(canonical_json, 'UTF8')
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION audit_state_json_is_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  availability text;
  projection text;
  data jsonb;
BEGIN
  IF audit_json_has_exact_keys(
    value,
    array['availability','completeness','projection','data','sha256','missingFields','reason']
  ) IS NOT TRUE OR
     jsonb_typeof(value -> 'availability') <> 'string' OR
     jsonb_typeof(value -> 'completeness') <> 'string' OR
     jsonb_typeof(value -> 'missingFields') <> 'array' OR
     jsonb_array_length(value -> 'missingFields') <> 0 THEN
    RETURN false;
  END IF;

  availability := value ->> 'availability';
  IF availability = 'present' THEN
    IF value ->> 'completeness' <> 'complete' OR
       jsonb_typeof(value -> 'projection') <> 'string' OR
       audit_json_is_sha256(value -> 'sha256') IS NOT TRUE OR
       jsonb_typeof(value -> 'reason') <> 'null' THEN
      RETURN false;
    END IF;
    projection := value ->> 'projection';
    data := value -> 'data';
    IF projection IN ('job.audit/v1', 'job-summary.audit/v1') THEN
      RETURN audit_json_has_exact_keys(data, array['id','notePresent']) IS TRUE
         AND audit_json_is_safe_integer(data -> 'id', 1, 9007199254740991) IS TRUE
         AND jsonb_typeof(data -> 'notePresent') = 'boolean';
    ELSIF projection = 'critical-aggregate.audit/v1' THEN
      RETURN audit_json_has_exact_keys(
        data,
        array['entityType','entityId','aggregateVersion','lifecycleState','contentSha256','relationSetSha256']
      ) IS TRUE
         AND jsonb_typeof(data -> 'entityType') = 'string'
         AND jsonb_typeof(data -> 'entityId') = 'string'
         AND jsonb_typeof(data -> 'aggregateVersion') = 'string'
         AND jsonb_typeof(data -> 'lifecycleState') = 'string'
         AND audit_json_is_sha256(data -> 'contentSha256') IS TRUE
         AND (
           jsonb_typeof(data -> 'relationSetSha256') = 'null' OR
           audit_json_is_sha256(data -> 'relationSetSha256') IS TRUE
         );
    END IF;
    RETURN false;
  ELSIF availability IN ('absent', 'not-captured') THEN
    RETURN value ->> 'completeness' = 'not-applicable'
       AND jsonb_typeof(value -> 'projection') = 'null'
       AND jsonb_typeof(value -> 'data') = 'null'
       AND jsonb_typeof(value -> 'sha256') = 'null'
       AND jsonb_typeof(value -> 'reason') = 'string'
       AND (
         (availability = 'absent' AND value ->> 'reason' IN ('not-created', 'deleted')) OR
         (availability = 'not-captured' AND value ->> 'reason' IN ('operation-not-applied', 'not-applicable'))
       );
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION audit_event_json_is_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  artifact jsonb;
BEGIN
  IF audit_json_has_exact_keys(
    value,
    array['schemaVersion','eventId','occurredAt','actor','source','action','entity','reason','state','correlation','artifactRefs','integrity']
  ) IS NOT TRUE OR
     value ->> 'schemaVersion' <> 'site-logbook.audit-event/v1' OR
     jsonb_typeof(value -> 'eventId') <> 'string' OR
     (value ->> 'eventId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' OR
     jsonb_typeof(value -> 'occurredAt') <> 'string' OR
     (value ->> 'occurredAt') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' OR
     audit_json_has_exact_keys(value -> 'actor', array['kind','id','authentication','delegatedById']) IS NOT TRUE OR
     jsonb_typeof(value #> '{actor,kind}') <> 'string' OR
     (value #>> '{actor,kind}') NOT IN ('user','system','external','anonymous') OR
     jsonb_typeof(value #> '{actor,id}') <> 'string' OR
     jsonb_typeof(value #> '{actor,authentication}') <> 'string' OR
     audit_json_is_string_or_null(value #> '{actor,delegatedById}') IS NOT TRUE OR
     audit_json_has_exact_keys(value -> 'source', array['kind','component','operation','buildRevision','requestIdSha256']) IS NOT TRUE OR
     jsonb_typeof(value #> '{source,kind}') <> 'string' OR
     (value #>> '{source,kind}') NOT IN ('api','worker','scheduler','import','ai','migration','repair') OR
     jsonb_typeof(value #> '{source,component}') <> 'string' OR
     jsonb_typeof(value #> '{source,operation}') <> 'string' OR
     jsonb_typeof(value #> '{source,buildRevision}') <> 'string' OR
     NOT (
       (value #>> '{source,buildRevision}') = 'unknown' OR
       (value #>> '{source,buildRevision}') ~ '^[0-9a-f]{40}$'
     ) OR
     NOT (
       jsonb_typeof(value #> '{source,requestIdSha256}') = 'null' OR
       audit_json_is_sha256(value #> '{source,requestIdSha256}') IS TRUE
     ) OR
     audit_json_has_exact_keys(value -> 'action', array['code','class','outcome','policyVersion','critical']) IS NOT TRUE OR
     jsonb_typeof(value #> '{action,code}') <> 'string' OR
     (value #>> '{action,class}') NOT IN ('create','update','delete','access','execute','decision') OR
     (value #>> '{action,outcome}') NOT IN ('succeeded','denied','failed') OR
     (value #>> '{action,policyVersion}') <> 'audit-action-policy/v1' OR
     jsonb_typeof(value #> '{action,critical}') <> 'boolean' OR
     audit_json_has_exact_keys(value -> 'entity', array['type','id','version']) IS NOT TRUE OR
     jsonb_typeof(value #> '{entity,type}') <> 'string' OR
     jsonb_typeof(value #> '{entity,id}') <> 'string' OR
     audit_json_is_string_or_null(value #> '{entity,version}') IS NOT TRUE OR
     audit_json_has_exact_keys(value -> 'reason', array['code','detailArtifactRef','detailSha256']) IS NOT TRUE OR
     audit_json_is_string_or_null(value #> '{reason,code}') IS NOT TRUE OR
     audit_json_is_string_or_null(value #> '{reason,detailArtifactRef}') IS NOT TRUE OR
     NOT (
       jsonb_typeof(value #> '{reason,detailSha256}') = 'null' OR
       audit_json_is_sha256(value #> '{reason,detailSha256}') IS TRUE
     ) OR
     audit_json_has_exact_keys(value -> 'state', array['before','after']) IS NOT TRUE OR
     audit_state_json_is_valid(value #> '{state,before}') IS NOT TRUE OR
     audit_state_json_is_valid(value #> '{state,after}') IS NOT TRUE OR
     audit_json_has_exact_keys(value -> 'correlation', array['correlationIdSha256','causationEventSha256','idempotencyKeySha256']) IS NOT TRUE OR
     audit_json_is_sha256(value #> '{correlation,correlationIdSha256}') IS NOT TRUE OR
     NOT (
       jsonb_typeof(value #> '{correlation,causationEventSha256}') = 'null' OR
       audit_json_is_sha256(value #> '{correlation,causationEventSha256}') IS TRUE
     ) OR
     NOT (
       jsonb_typeof(value #> '{correlation,idempotencyKeySha256}') = 'null' OR
       audit_json_is_sha256(value #> '{correlation,idempotencyKeySha256}') IS TRUE
     ) OR
     jsonb_typeof(value -> 'artifactRefs') <> 'array' OR
     jsonb_array_length(value -> 'artifactRefs') > 64 OR
     audit_json_has_exact_keys(value -> 'integrity', array['canonicalization','hashAlgorithm','hashDomain','eventSha256']) IS NOT TRUE OR
     (value #>> '{integrity,canonicalization}') <> 'site-logbook-cjson/v1' OR
     (value #>> '{integrity,hashAlgorithm}') <> 'sha256' OR
     (value #>> '{integrity,hashDomain}') <> 'site-logbook.audit-event/v1' OR
     audit_json_is_sha256(value #> '{integrity,eventSha256}') IS NOT TRUE THEN
    RETURN false;
  END IF;

  FOR artifact IN SELECT item FROM jsonb_array_elements(value -> 'artifactRefs') item LOOP
    IF audit_json_has_exact_keys(artifact, array['role','ref','sha256','byteLength','mediaType']) IS NOT TRUE OR
       jsonb_typeof(artifact -> 'role') <> 'string' OR
       jsonb_typeof(artifact -> 'ref') <> 'string' OR
       audit_json_is_sha256(artifact -> 'sha256') IS NOT TRUE OR
       NOT (
         jsonb_typeof(artifact -> 'byteLength') = 'null' OR
         audit_json_is_safe_integer(artifact -> 'byteLength', 0, 9007199254740991) IS TRUE
       ) OR
       audit_json_is_string_or_null(artifact -> 'mediaType') IS NOT TRUE THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION audit_ledger_json_is_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT audit_json_has_exact_keys(
           value,
           array['schemaVersion','streamId','sequence','eventId','eventSha256','recordedAt','previousLedgerSha256','integrity']
         ) IS TRUE
     AND value ->> 'schemaVersion' = 'site-logbook.audit-chain-record/v1'
     AND value ->> 'streamId' = 'site-logbook:audit:global:v1'
     AND jsonb_typeof(value -> 'sequence') = 'string'
     AND (value ->> 'sequence') ~ '^[1-9][0-9]*$'
     AND jsonb_typeof(value -> 'eventId') = 'string'
     AND audit_json_is_sha256(value -> 'eventSha256') IS TRUE
     AND jsonb_typeof(value -> 'recordedAt') = 'string'
     AND (
       jsonb_typeof(value -> 'previousLedgerSha256') = 'null' OR
       audit_json_is_sha256(value -> 'previousLedgerSha256') IS TRUE
     )
     AND audit_json_has_exact_keys(
           value -> 'integrity',
           array['canonicalization','hashAlgorithm','hashDomain','ledgerSha256']
         ) IS TRUE
     AND value #>> '{integrity,canonicalization}' = 'site-logbook-cjson/v1'
     AND value #>> '{integrity,hashAlgorithm}' = 'sha256'
     AND value #>> '{integrity,hashDomain}' = 'site-logbook.audit-chain-record/v1'
     AND audit_json_is_sha256(value #> '{integrity,ledgerSha256}') IS TRUE;
$$;

CREATE OR REPLACE FUNCTION audit_export_intent_json_is_valid(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT audit_json_has_exact_keys(
           value,
           array['schemaVersion','intentId','kind','createdAt','streamId','throughSequence','throughLedgerSha256','eventId','eventSha256','destination','initialState','integrity']
         ) IS TRUE
     AND value ->> 'schemaVersion' = 'site-logbook.audit-export-intent/v1'
     AND jsonb_typeof(value -> 'intentId') = 'string'
     AND value ->> 'kind' = 'audit-chain-export'
     AND jsonb_typeof(value -> 'createdAt') = 'string'
     AND value ->> 'streamId' = 'site-logbook:audit:global:v1'
     AND jsonb_typeof(value -> 'throughSequence') = 'string'
     AND (value ->> 'throughSequence') ~ '^[1-9][0-9]*$'
     AND audit_json_is_sha256(value -> 'throughLedgerSha256') IS TRUE
     AND jsonb_typeof(value -> 'eventId') = 'string'
     AND audit_json_is_sha256(value -> 'eventSha256') IS TRUE
     AND audit_json_has_exact_keys(value -> 'destination', array['kind','namespace','format']) IS TRUE
     AND value #>> '{destination,kind}' = 'versioned-object-storage'
     AND value #>> '{destination,namespace}' = 'audit-evidence/v1'
     AND value #>> '{destination,format}' = 'site-logbook.audit-jsonl/v1'
     AND value ->> 'initialState' = 'pending'
     AND audit_json_has_exact_keys(
           value -> 'integrity',
           array['canonicalization','hashAlgorithm','hashDomain','intentSha256']
         ) IS TRUE
     AND value #>> '{integrity,canonicalization}' = 'site-logbook-cjson/v1'
     AND value #>> '{integrity,hashAlgorithm}' = 'sha256'
     AND value #>> '{integrity,hashDomain}' = 'site-logbook.audit-export-intent/v1'
     AND audit_json_is_sha256(value #> '{integrity,intentSha256}') IS TRUE;
$$;

CREATE OR REPLACE FUNCTION audit_event_core_semantics_are_valid(value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  actor_kind text := value #>> '{actor,kind}';
  actor_id text := value #>> '{actor,id}';
  actor_auth text := value #>> '{actor,authentication}';
  source_kind text := value #>> '{source,kind}';
  source_component text := value #>> '{source,component}';
  action_code text := value #>> '{action,code}';
  action_class text := value #>> '{action,class}';
  action_critical boolean := (value #>> '{action,critical}')::boolean;
  entity_type text := value #>> '{entity,type}';
  state_value jsonb;
BEGIN
  IF NOT (
    (actor_kind = 'user' AND actor_auth IN ('session', 'step-up') AND
      actor_id ~ '^user:(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$' AND
      (jsonb_typeof(value #> '{actor,delegatedById}') = 'null' OR
       (value #>> '{actor,delegatedById}') ~ '^user:(?:[1-9][0-9]*|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$')) OR
    (actor_kind = 'system' AND actor_auth IN ('service', 'scheduler', 'migration') AND
      actor_id ~ '^system:[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$' AND
      jsonb_typeof(value #> '{actor,delegatedById}') = 'null') OR
    (actor_kind = 'external' AND actor_auth = 'public-token' AND
      actor_id ~ '^external:[0-9a-f]{64}$' AND
      jsonb_typeof(value #> '{actor,delegatedById}') = 'null') OR
    (actor_kind = 'anonymous' AND actor_auth = 'none' AND
      actor_id = 'anonymous:unknown' AND
      jsonb_typeof(value #> '{actor,delegatedById}') = 'null')
  ) THEN
    RETURN false;
  END IF;

  IF NOT (
    (source_kind = 'api' AND source_component = 'api-server' AND actor_kind IN ('user','external')) OR
    (source_kind = 'worker' AND source_component = 'api-worker' AND actor_kind = 'system' AND actor_id = 'system:api-worker' AND actor_auth = 'service') OR
    (source_kind = 'scheduler' AND source_component = 'api-scheduler' AND actor_kind = 'system' AND actor_id = 'system:api-scheduler' AND actor_auth = 'scheduler') OR
    (source_kind = 'import' AND source_component = 'billing-import' AND actor_kind <> 'anonymous' AND (actor_kind <> 'system' OR actor_id = 'system:billing-import')) OR
    (source_kind = 'ai' AND source_component = 'ai-analyzer' AND actor_kind <> 'anonymous' AND (actor_kind <> 'system' OR actor_id = 'system:ai-analyzer')) OR
    (source_kind = 'migration' AND source_component = 'migration-runner' AND actor_kind = 'system' AND actor_id = 'system:migration-runner' AND actor_auth = 'migration') OR
    (source_kind = 'repair' AND source_component = 'repair-runner' AND actor_kind <> 'anonymous' AND (actor_kind <> 'system' OR actor_id = 'system:repair-runner'))
  ) OR value #>> '{source,operation}' <> action_code THEN
    RETURN false;
  END IF;

  IF NOT (CASE action_code
    WHEN 'job.note.update' THEN action_class = 'update' AND NOT action_critical AND entity_type = 'job'
    WHEN 'vault.credential.reveal' THEN action_class = 'access' AND action_critical AND entity_type = 'device-credential'
    WHEN 'user.role.update' THEN action_class = 'update' AND action_critical AND entity_type = 'user'
    WHEN 'user.permission.update' THEN action_class = 'update' AND action_critical AND entity_type = 'user'
    WHEN 'user.offboard.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'user'
    WHEN 'invoice.payment.record' THEN action_class = 'update' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.payment.correct' THEN action_class = 'update' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.correction.create' THEN action_class = 'create' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.void.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.issue' THEN action_class = 'execute' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.cancel' THEN action_class = 'execute' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.status.change' THEN action_class = 'update' AND action_critical AND entity_type = 'invoice'
    WHEN 'invoice.refund.record' THEN action_class = 'update' AND action_critical AND entity_type = 'invoice'
    WHEN 'billing-document.approve' THEN action_class = 'decision' AND action_critical AND entity_type = 'billing-document'
    WHEN 'billing-document.correct' THEN action_class = 'update' AND action_critical AND entity_type = 'billing-document'
    WHEN 'billing-document.delete' THEN action_class = 'delete' AND action_critical AND entity_type = 'billing-document'
    WHEN 'billing-document.return-to-review' THEN action_class = 'decision' AND action_critical AND entity_type = 'billing-document'
    WHEN 'signature.create' THEN action_class = 'create' AND action_critical AND entity_type = 'signature'
    WHEN 'signature.sign' THEN action_class = 'decision' AND action_critical AND entity_type = 'signature'
    WHEN 'signature.consume' THEN action_class = 'execute' AND action_critical AND entity_type = 'signature'
    WHEN 'signature.revoke' THEN action_class = 'execute' AND action_critical AND entity_type = 'signature'
    WHEN 'signature.supersede' THEN action_class = 'execute' AND action_critical AND entity_type = 'signature'
    WHEN 'privacy.export.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'privacy.access.execute' THEN action_class = 'access' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'privacy.rectify.execute' THEN action_class = 'update' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'privacy.restrict.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'privacy.erase.execute' THEN action_class = 'delete' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'privacy.hold.update' THEN action_class = 'update' AND action_critical AND entity_type = 'privacy-request'
    WHEN 'time.session.approve' THEN action_class = 'decision' AND action_critical AND entity_type = 'work-session'
    WHEN 'time.session.reject' THEN action_class = 'decision' AND action_critical AND entity_type = 'work-session'
    WHEN 'time.session.correct' THEN action_class = 'update' AND action_critical AND entity_type = 'work-session'
    WHEN 'time.session.void' THEN action_class = 'execute' AND action_critical AND entity_type = 'work-session'
    WHEN 'time.session.bill' THEN action_class = 'execute' AND action_critical AND entity_type = 'work-session'
    WHEN 'external-account.grant' THEN action_class = 'create' AND action_critical AND entity_type = 'external-account'
    WHEN 'external-account.revoke' THEN action_class = 'execute' AND action_critical AND entity_type = 'external-account'
    WHEN 'backup.create' THEN action_class = 'execute' AND action_critical AND entity_type = 'backup'
    WHEN 'backup.restore' THEN action_class = 'execute' AND action_critical AND entity_type = 'backup'
    WHEN 'key.rotate' THEN action_class = 'execute' AND action_critical AND entity_type = 'key'
    WHEN 'migration.apply' THEN action_class = 'execute' AND action_critical AND entity_type = 'migration'
    WHEN 'backfill.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'backfill'
    WHEN 'repair.execute' THEN action_class = 'execute' AND action_critical AND entity_type = 'repair'
    WHEN 'warehouse.override' THEN action_class = 'execute' AND action_critical AND entity_type = 'warehouse-item'
    ELSE false
  END) THEN
    RETURN false;
  END IF;

  FOREACH state_value IN ARRAY array[
    value #> '{state,before}',
    value #> '{state,after}'
  ] LOOP
    IF state_value ->> 'availability' = 'present' AND
       state_value ->> 'sha256' <> audit_domain_sha256(
         'site-logbook.audit-projection/v1:' || (state_value ->> 'projection'),
         audit_canonical_json(state_value -> 'data')
       ) THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION guard_audit_event_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  current_head audit_chain_heads%ROWTYPE;
  event_json jsonb := NEW.canonical_event_json::jsonb;
  ledger_json jsonb := NEW.canonical_ledger_json::jsonb;
  expected_event_sha256 text;
  expected_ledger_sha256 text;
BEGIN
  IF audit_event_json_is_valid(event_json) IS NOT TRUE OR
     audit_event_core_semantics_are_valid(event_json) IS NOT TRUE OR
     audit_ledger_json_is_valid(ledger_json) IS NOT TRUE THEN
    RAISE EXCEPTION 'canonical audit event, core semantics or ledger shape is invalid';
  END IF;
  IF audit_canonical_json(event_json) <> NEW.canonical_event_json OR
     audit_canonical_json(ledger_json) <> NEW.canonical_ledger_json THEN
    RAISE EXCEPTION 'audit event and ledger JSON must use exact canonical bytes';
  END IF;

  expected_event_sha256 := audit_domain_sha256(
    'site-logbook.audit-event/v1',
    audit_canonical_json(
      jsonb_set(event_json, '{integrity,eventSha256}', 'null'::jsonb, false)
    )
  );
  expected_ledger_sha256 := audit_domain_sha256(
    'site-logbook.audit-chain-record/v1',
    audit_canonical_json(
      jsonb_set(ledger_json, '{integrity,ledgerSha256}', 'null'::jsonb, false)
    )
  );
  IF expected_event_sha256 <> NEW.event_sha256 OR
     expected_ledger_sha256 <> NEW.ledger_sha256 THEN
    RAISE EXCEPTION 'audit event or ledger domain-separated digest mismatch';
  END IF;

  SELECT * INTO current_head
  FROM audit_chain_heads
  WHERE stream_id = 'site-logbook:audit:global:v1'
  FOR UPDATE;
  IF NOT FOUND OR
     NEW.stream_id <> current_head.stream_id OR
     NEW.sequence <> current_head.sequence + 1 OR
     NEW.previous_ledger_sha256 IS DISTINCT FROM current_head.ledger_sha256 THEN
    RAISE EXCEPTION 'audit event must be the exact successor of the locked singleton head';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_events_insert_guard_trg"
BEFORE INSERT ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION guard_audit_event_insert();

CREATE OR REPLACE FUNCTION deny_audit_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'canonical audit events and chain records are immutable';
END;
$$;

CREATE TRIGGER "audit_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION deny_audit_event_mutation();

CREATE OR REPLACE FUNCTION guard_audit_chain_head_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit chain head cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.stream_id <> 'site-logbook:audit:global:v1' OR
       NEW.sequence <> 0 OR
       NEW.ledger_sha256 IS NOT NULL OR
       EXISTS (SELECT 1 FROM audit_chain_heads) THEN
      RAISE EXCEPTION 'audit chain head insert must create the unique genesis state';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.stream_id <> OLD.stream_id OR
     NEW.created_at <> OLD.created_at OR
     NEW.sequence <> OLD.sequence + 1 OR
     NEW.ledger_sha256 IS NULL OR
     NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'audit chain head must advance the same stream by exactly one record';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_events event
    WHERE event.stream_id = NEW.stream_id
      AND event.sequence = NEW.sequence
      AND event.ledger_sha256 = NEW.ledger_sha256
      AND event.previous_ledger_sha256 IS NOT DISTINCT FROM OLD.ledger_sha256
  ) THEN
    RAISE EXCEPTION 'audit chain head successor is not the exact persisted event';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_chain_heads_guard_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "audit_chain_heads"
FOR EACH ROW EXECUTE FUNCTION guard_audit_chain_head_transition();

CREATE OR REPLACE FUNCTION guard_audit_export_outbox_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  intent_json jsonb;
  expected_intent_sha256 text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'audit export outbox rows cannot be deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    intent_json := NEW.canonical_json::jsonb;
    IF audit_export_intent_json_is_valid(intent_json) IS NOT TRUE OR
       audit_canonical_json(intent_json) <> NEW.canonical_json THEN
      RAISE EXCEPTION 'audit export intent shape or canonical bytes are invalid';
    END IF;
    expected_intent_sha256 := audit_domain_sha256(
      'site-logbook.audit-export-intent/v1',
      audit_canonical_json(
        jsonb_set(intent_json, '{integrity,intentSha256}', 'null'::jsonb, false)
      )
    );
    IF expected_intent_sha256 <> NEW.intent_sha256 OR
       NOT EXISTS (
         SELECT 1 FROM audit_events event
         WHERE event.event_id = NEW.event_id
           AND event.stream_id = NEW.stream_id
           AND event.sequence = NEW.through_sequence
           AND event.ledger_sha256 = NEW.through_ledger_sha256
           AND event.event_sha256 = NEW.event_sha256
       ) THEN
      RAISE EXCEPTION 'audit export intent digest or event binding is invalid';
    END IF;
    IF NEW.state <> 'pending' OR NEW.attempt_count <> 0 OR
       NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL OR
       NEW.exported_at IS NOT NULL OR NEW.dead_lettered_at IS NOT NULL OR
       num_nonnulls(NEW.object_key, NEW.object_version_id, NEW.object_sha256) <> 0 THEN
      RAISE EXCEPTION 'audit export intent must start in the pending state';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.intent_id <> OLD.intent_id OR NEW.event_id <> OLD.event_id OR
     NEW.stream_id <> OLD.stream_id OR NEW.through_sequence <> OLD.through_sequence OR
     NEW.through_ledger_sha256 <> OLD.through_ledger_sha256 OR
     NEW.event_sha256 <> OLD.event_sha256 OR
     NEW.intent_created_at <> OLD.intent_created_at OR
     NEW.canonical_json <> OLD.canonical_json OR
     NEW.intent_sha256 <> OLD.intent_sha256 OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'audit export intent evidence is immutable';
  END IF;
  IF OLD.state IN ('exported', 'dead_letter') THEN
    RAISE EXCEPTION 'terminal audit export outbox rows are immutable';
  END IF;
  IF OLD.state = 'pending' AND NEW.state <> 'exporting' THEN
    RAISE EXCEPTION 'pending audit export must be claimed before transition';
  END IF;
  IF OLD.state = 'exporting' AND NEW.state = 'exporting' THEN
    RAISE EXCEPTION 'audit export lease renewal is not supported';
  END IF;
  IF OLD.state = 'exporting' AND NEW.state NOT IN ('pending', 'exported', 'dead_letter') THEN
    RAISE EXCEPTION 'audit export transition is invalid';
  END IF;
  IF OLD.state <> 'exporting' AND NEW.state = 'exporting' AND
     NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'audit export claim must increment attempt count exactly once';
  END IF;
  IF NOT (OLD.state <> 'exporting' AND NEW.state = 'exporting') AND
     NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'audit export transition cannot change attempt count';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'audit export timestamps cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "audit_export_outbox_guard_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "audit_export_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_audit_export_outbox_transition();

CREATE OR REPLACE FUNCTION guard_audit_event_commit_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM audit_export_outbox outbox
    WHERE outbox.intent_id = NEW.event_id AND outbox.event_id = NEW.event_id
      AND outbox.stream_id = NEW.stream_id
      AND outbox.through_sequence = NEW.sequence
      AND outbox.through_ledger_sha256 = NEW.ledger_sha256
      AND outbox.event_sha256 = NEW.event_sha256
  ) THEN
    RAISE EXCEPTION 'canonical audit event requires its exact export intent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM audit_chain_heads head
    JOIN audit_events current_head
      ON current_head.stream_id = head.stream_id
     AND current_head.sequence = head.sequence
     AND current_head.ledger_sha256 = head.ledger_sha256
    WHERE head.stream_id = NEW.stream_id AND head.sequence >= NEW.sequence
  ) THEN
    RAISE EXCEPTION 'canonical audit event requires an advanced durable chain head';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "audit_events_commit_binding_trg"
AFTER INSERT ON "audit_events"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION guard_audit_event_commit_binding();

INSERT INTO audit_chain_heads (stream_id, sequence, ledger_sha256)
VALUES ('site-logbook:audit:global:v1', 0, NULL);

REVOKE ALL ON audit_events, audit_chain_heads, audit_export_outbox FROM PUBLIC;

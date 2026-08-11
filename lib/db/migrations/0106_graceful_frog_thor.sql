CREATE TABLE "accounting_aggregate_heads" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "accounting_aggregate_heads_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"invoice_id" integer,
	"billing_document_id" integer,
	"revision" bigint DEFAULT 0 NOT NULL,
	"version_head_version" bigint,
	"version_head_id" uuid,
	"version_head_sha256" text,
	"lifecycle_head_sequence" bigint,
	"lifecycle_head_id" uuid,
	"lifecycle_head_sha256" text,
	"payment_head_sequence" bigint,
	"payment_head_id" uuid,
	"payment_head_sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_aggregate_heads_root_chk" CHECK (num_nonnulls("accounting_aggregate_heads"."invoice_id", "accounting_aggregate_heads"."billing_document_id") = 1),
	CONSTRAINT "accounting_aggregate_heads_revision_chk" CHECK ("accounting_aggregate_heads"."revision" >= 0),
	CONSTRAINT "accounting_aggregate_heads_version_tuple_chk" CHECK (num_nonnulls("accounting_aggregate_heads"."version_head_version", "accounting_aggregate_heads"."version_head_id", "accounting_aggregate_heads"."version_head_sha256") in (0, 3)),
	CONSTRAINT "accounting_aggregate_heads_lifecycle_tuple_chk" CHECK (num_nonnulls("accounting_aggregate_heads"."lifecycle_head_sequence", "accounting_aggregate_heads"."lifecycle_head_id", "accounting_aggregate_heads"."lifecycle_head_sha256") in (0, 3)),
	CONSTRAINT "accounting_aggregate_heads_payment_tuple_chk" CHECK (num_nonnulls("accounting_aggregate_heads"."payment_head_sequence", "accounting_aggregate_heads"."payment_head_id", "accounting_aggregate_heads"."payment_head_sha256") in (0, 3)),
	CONSTRAINT "accounting_aggregate_heads_dependency_chk" CHECK ("accounting_aggregate_heads"."version_head_id" is not null or ("accounting_aggregate_heads"."lifecycle_head_id" is null and "accounting_aggregate_heads"."payment_head_id" is null)),
	CONSTRAINT "accounting_aggregate_heads_cost_payment_chk" CHECK ("accounting_aggregate_heads"."billing_document_id" is null or "accounting_aggregate_heads"."payment_head_id" is null),
	CONSTRAINT "accounting_aggregate_heads_hashes_chk" CHECK (("accounting_aggregate_heads"."version_head_sha256" is null or "accounting_aggregate_heads"."version_head_sha256" ~ '^[0-9a-f]{64}$') and ("accounting_aggregate_heads"."lifecycle_head_sha256" is null or "accounting_aggregate_heads"."lifecycle_head_sha256" ~ '^[0-9a-f]{64}$') and ("accounting_aggregate_heads"."payment_head_sha256" is null or "accounting_aggregate_heads"."payment_head_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "accounting_document_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" integer,
	"billing_document_id" integer,
	"version" bigint NOT NULL,
	"purpose" text NOT NULL,
	"supersedes_version_id" uuid,
	"historical_completeness" text NOT NULL,
	"effective_at" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"artifact_set_sha256" text NOT NULL,
	"version_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_document_versions_root_chk" CHECK (num_nonnulls("accounting_document_versions"."invoice_id", "accounting_document_versions"."billing_document_id") = 1),
	CONSTRAINT "accounting_document_versions_number_chk" CHECK ("accounting_document_versions"."version" >= 1),
	CONSTRAINT "accounting_document_versions_purpose_chk" CHECK ("accounting_document_versions"."purpose" in ('issued', 'approved', 'correction', 'credit', 'cancellation_notice', 'discarded_observation', 'legacy_observation')),
	CONSTRAINT "accounting_document_versions_completeness_chk" CHECK ("accounting_document_versions"."historical_completeness" in ('complete', 'unknown')),
	CONSTRAINT "accounting_document_versions_supersedes_self_chk" CHECK ("accounting_document_versions"."supersedes_version_id" is null or "accounting_document_versions"."supersedes_version_id" <> "accounting_document_versions"."id"),
	CONSTRAINT "accounting_document_versions_canonical_json_chk" CHECK (jsonb_typeof(("accounting_document_versions"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_document_versions_canonical_binding_chk" CHECK (("accounting_document_versions"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-document-version/v1'
        and ("accounting_document_versions"."canonical_json"::jsonb ->> 'versionId') = "accounting_document_versions"."id"::text
        and ("accounting_document_versions"."canonical_json"::jsonb #>> '{aggregate,kind}') = case when "accounting_document_versions"."invoice_id" is not null then 'outgoing-invoice' else 'incoming-cost-document' end
        and ("accounting_document_versions"."canonical_json"::jsonb #>> '{aggregate,id}') = coalesce("accounting_document_versions"."invoice_id", "accounting_document_versions"."billing_document_id")::text
        and ("accounting_document_versions"."canonical_json"::jsonb ->> 'version') = "accounting_document_versions"."version"::text
        and ("accounting_document_versions"."canonical_json"::jsonb ->> 'purpose') = "accounting_document_versions"."purpose"
        and ("accounting_document_versions"."canonical_json"::jsonb ->> 'historicalCompleteness') = "accounting_document_versions"."historical_completeness"
        and ("accounting_document_versions"."canonical_json"::jsonb ->> 'supersedesVersionId') is not distinct from "accounting_document_versions"."supersedes_version_id"::text
        and ("accounting_document_versions"."canonical_json"::jsonb #>> '{integrity,snapshotSha256}') = "accounting_document_versions"."snapshot_sha256"
        and ("accounting_document_versions"."canonical_json"::jsonb #>> '{integrity,artifactSetSha256}') = "accounting_document_versions"."artifact_set_sha256"
        and ("accounting_document_versions"."canonical_json"::jsonb #>> '{integrity,versionSha256}') = "accounting_document_versions"."version_sha256"),
	CONSTRAINT "accounting_document_versions_snapshot_hash_chk" CHECK ("accounting_document_versions"."snapshot_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_document_versions_artifact_hash_chk" CHECK ("accounting_document_versions"."artifact_set_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_document_versions_version_hash_chk" CHECK ("accounting_document_versions"."version_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_export_outbox" (
	"intent_id" uuid PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"manifest_object_key" text,
	"manifest_version_id" text,
	"manifest_sha256" text,
	"bundle_sha256" text,
	"checksum_sha256" text,
	"exported_at" timestamp with time zone,
	"dead_lettered_at" timestamp with time zone,
	"last_failure_category" text,
	"canonical_json" text NOT NULL,
	"intent_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_export_outbox_operation_chk" CHECK ("accounting_export_outbox"."operation" in ('initial-version', 'legacy-observation', 'lifecycle-event', 'payment-event', 'correction-bundle', 'warehouse-price-observation', 'warehouse-price-legacy-observation', 'reason-artifact')),
	CONSTRAINT "accounting_export_outbox_state_chk" CHECK ("accounting_export_outbox"."state" in ('pending', 'exporting', 'exported', 'dead_letter')),
	CONSTRAINT "accounting_export_outbox_attempt_chk" CHECK ("accounting_export_outbox"."attempt_count" >= 0),
	CONSTRAINT "accounting_export_outbox_lease_chk" CHECK (("accounting_export_outbox"."state" = 'exporting' and "accounting_export_outbox"."lease_token" is not null and "accounting_export_outbox"."lease_expires_at" is not null) or ("accounting_export_outbox"."state" <> 'exporting' and "accounting_export_outbox"."lease_token" is null and "accounting_export_outbox"."lease_expires_at" is null)),
	CONSTRAINT "accounting_export_outbox_terminal_chk" CHECK (("accounting_export_outbox"."state" = 'exported' and "accounting_export_outbox"."exported_at" is not null and length(btrim("accounting_export_outbox"."manifest_object_key")) > 0 and length(btrim("accounting_export_outbox"."manifest_version_id")) > 0 and "accounting_export_outbox"."manifest_sha256" ~ '^[0-9a-f]{64}$' and "accounting_export_outbox"."bundle_sha256" ~ '^[0-9a-f]{64}$' and "accounting_export_outbox"."checksum_sha256" ~ '^[0-9a-f]{64}$' and "accounting_export_outbox"."dead_lettered_at" is null) or ("accounting_export_outbox"."state" = 'dead_letter' and "accounting_export_outbox"."dead_lettered_at" is not null and "accounting_export_outbox"."exported_at" is null and num_nonnulls("accounting_export_outbox"."manifest_object_key", "accounting_export_outbox"."manifest_version_id", "accounting_export_outbox"."manifest_sha256", "accounting_export_outbox"."bundle_sha256", "accounting_export_outbox"."checksum_sha256") = 0) or ("accounting_export_outbox"."state" in ('pending', 'exporting') and "accounting_export_outbox"."exported_at" is null and "accounting_export_outbox"."dead_lettered_at" is null and num_nonnulls("accounting_export_outbox"."manifest_object_key", "accounting_export_outbox"."manifest_version_id", "accounting_export_outbox"."manifest_sha256", "accounting_export_outbox"."bundle_sha256", "accounting_export_outbox"."checksum_sha256") = 0)),
	CONSTRAINT "accounting_export_outbox_receipt_binding_chk" CHECK ("accounting_export_outbox"."manifest_object_key" is null or ("accounting_export_outbox"."manifest_object_key" = (case when "accounting_export_outbox"."operation" = 'reason-artifact' then 'accounting-evidence-restricted/v1/' else 'accounting-evidence/v1/' end) || "accounting_export_outbox"."intent_id"::text || '/' || "accounting_export_outbox"."intent_sha256" || '/manifest.json' and length("accounting_export_outbox"."manifest_version_id") between 1 and 512 and "accounting_export_outbox"."manifest_version_id" !~ '[[:space:][:cntrl:]]')),
	CONSTRAINT "accounting_export_outbox_failure_category_chk" CHECK ("accounting_export_outbox"."last_failure_category" is null or "accounting_export_outbox"."last_failure_category" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "accounting_export_outbox_canonical_json_chk" CHECK (jsonb_typeof(("accounting_export_outbox"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_export_outbox_canonical_binding_chk" CHECK (("accounting_export_outbox"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-export-intent/v1'
        and ("accounting_export_outbox"."canonical_json"::jsonb ->> 'intentId') = "accounting_export_outbox"."intent_id"::text
        and ("accounting_export_outbox"."canonical_json"::jsonb ->> 'operation') = "accounting_export_outbox"."operation"
        and ("accounting_export_outbox"."canonical_json"::jsonb ->> 'initialState') = 'pending'
        and ("accounting_export_outbox"."canonical_json"::jsonb #>> '{destination,namespace}') = case when "accounting_export_outbox"."operation" = 'reason-artifact' then 'accounting-evidence-restricted/v1' else 'accounting-evidence/v1' end
        and ("accounting_export_outbox"."canonical_json"::jsonb #>> '{integrity,intentSha256}') = "accounting_export_outbox"."intent_sha256"),
	CONSTRAINT "accounting_export_outbox_intent_hash_chk" CHECK ("accounting_export_outbox"."intent_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_lifecycle_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" integer,
	"billing_document_id" integer,
	"document_version_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"previous_event_sha256" text,
	"event_type" text NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"entry_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_lifecycle_events_root_chk" CHECK (num_nonnulls("accounting_lifecycle_events"."invoice_id", "accounting_lifecycle_events"."billing_document_id") = 1),
	CONSTRAINT "accounting_lifecycle_events_sequence_chk" CHECK ("accounting_lifecycle_events"."sequence" >= 0),
	CONSTRAINT "accounting_lifecycle_events_previous_chk" CHECK (("accounting_lifecycle_events"."sequence" = 0 and "accounting_lifecycle_events"."previous_event_sha256" is null) or ("accounting_lifecycle_events"."sequence" > 0 and "accounting_lifecycle_events"."previous_event_sha256" is not null)),
	CONSTRAINT "accounting_lifecycle_events_type_chk" CHECK ("accounting_lifecycle_events"."event_type" in ('issued', 'sent', 'cancellation_requested', 'void_confirmed', 'credit_linked', 'correction_linked', 'approved', 'review_reopened', 'ignored')),
	CONSTRAINT "accounting_lifecycle_events_previous_hash_chk" CHECK ("accounting_lifecycle_events"."previous_event_sha256" is null or "accounting_lifecycle_events"."previous_event_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_lifecycle_events_canonical_json_chk" CHECK (jsonb_typeof(("accounting_lifecycle_events"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_lifecycle_events_canonical_binding_chk" CHECK (("accounting_lifecycle_events"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-lifecycle-event/v1'
        and ("accounting_lifecycle_events"."canonical_json"::jsonb ->> 'eventId') = "accounting_lifecycle_events"."id"::text
        and ("accounting_lifecycle_events"."canonical_json"::jsonb #>> '{aggregate,kind}') = case when "accounting_lifecycle_events"."invoice_id" is not null then 'outgoing-invoice' else 'incoming-cost-document' end
        and ("accounting_lifecycle_events"."canonical_json"::jsonb #>> '{aggregate,id}') = coalesce("accounting_lifecycle_events"."invoice_id", "accounting_lifecycle_events"."billing_document_id")::text
        and ("accounting_lifecycle_events"."canonical_json"::jsonb #>> '{aggregate,versionId}') = "accounting_lifecycle_events"."document_version_id"::text
        and ("accounting_lifecycle_events"."canonical_json"::jsonb ->> 'sequence') = "accounting_lifecycle_events"."sequence"::text
        and ("accounting_lifecycle_events"."canonical_json"::jsonb ->> 'previousEventSha256') is not distinct from "accounting_lifecycle_events"."previous_event_sha256"
        and ("accounting_lifecycle_events"."canonical_json"::jsonb ->> 'eventType') = "accounting_lifecycle_events"."event_type"
        and ("accounting_lifecycle_events"."canonical_json"::jsonb #>> '{integrity,entrySha256}') = "accounting_lifecycle_events"."entry_sha256"),
	CONSTRAINT "accounting_lifecycle_events_entry_hash_chk" CHECK ("accounting_lifecycle_events"."entry_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_payment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"invoice_version_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"previous_event_sha256" text,
	"event_type" text NOT NULL,
	"amount_delta" text NOT NULL,
	"currency" text NOT NULL,
	"occurred_on" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"corrects_payment_event_id" uuid,
	"canonical_json" text NOT NULL,
	"entry_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_payment_events_sequence_chk" CHECK ("accounting_payment_events"."sequence" >= 0),
	CONSTRAINT "accounting_payment_events_previous_chk" CHECK (("accounting_payment_events"."sequence" = 0 and "accounting_payment_events"."previous_event_sha256" is null) or ("accounting_payment_events"."sequence" > 0 and "accounting_payment_events"."previous_event_sha256" is not null)),
	CONSTRAINT "accounting_payment_events_type_chk" CHECK ("accounting_payment_events"."event_type" in ('received', 'corrected', 'refunded', 'reversed')),
	CONSTRAINT "accounting_payment_events_currency_chk" CHECK ("accounting_payment_events"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounting_payment_events_occurred_on_chk" CHECK ("accounting_payment_events"."occurred_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
	CONSTRAINT "accounting_payment_events_previous_hash_chk" CHECK ("accounting_payment_events"."previous_event_sha256" is null or "accounting_payment_events"."previous_event_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_payment_events_correction_self_chk" CHECK ("accounting_payment_events"."corrects_payment_event_id" is null or "accounting_payment_events"."corrects_payment_event_id" <> "accounting_payment_events"."id"),
	CONSTRAINT "accounting_payment_events_canonical_json_chk" CHECK (jsonb_typeof(("accounting_payment_events"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_payment_events_canonical_binding_chk" CHECK (("accounting_payment_events"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-payment-event/v1'
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'paymentEventId') = "accounting_payment_events"."id"::text
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'invoiceId') = "accounting_payment_events"."invoice_id"::text
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'invoiceVersionId') = "accounting_payment_events"."invoice_version_id"::text
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'sequence') = "accounting_payment_events"."sequence"::text
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'previousEventSha256') is not distinct from "accounting_payment_events"."previous_event_sha256"
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'eventType') = "accounting_payment_events"."event_type"
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'amountDelta') = "accounting_payment_events"."amount_delta"
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'currency') = "accounting_payment_events"."currency"
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'occurredOn') = "accounting_payment_events"."occurred_on"
        and ("accounting_payment_events"."canonical_json"::jsonb ->> 'correctsPaymentEventId') is not distinct from "accounting_payment_events"."corrects_payment_event_id"::text
        and ("accounting_payment_events"."canonical_json"::jsonb #>> '{integrity,entrySha256}') = "accounting_payment_events"."entry_sha256"),
	CONSTRAINT "accounting_payment_events_entry_hash_chk" CHECK ("accounting_payment_events"."entry_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_reason_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"billing_document_id" integer NOT NULL,
	"accounting_version_id" uuid NOT NULL,
	"lifecycle_event_id" uuid NOT NULL,
	"lifecycle_event_sha256" text NOT NULL,
	"reason_code" text NOT NULL,
	"reason_detail_sha256" text NOT NULL,
	"digest_domain" text NOT NULL,
	"reason_text" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_reason_artifacts_code_chk" CHECK ("accounting_reason_artifacts"."reason_code" in ('review_reopened', 'duplicate_document', 'invalid_document')),
	CONSTRAINT "accounting_reason_artifacts_domain_chk" CHECK ("accounting_reason_artifacts"."digest_domain" in ('site-logbook.cost-document-review-reopen-reason/v1', 'site-logbook.cost-document-reviewed-rejection-reason/v1')),
	CONSTRAINT "accounting_reason_artifacts_text_chk" CHECK (char_length("accounting_reason_artifacts"."reason_text") between 3 and 1000 and "accounting_reason_artifacts"."reason_text" = btrim("accounting_reason_artifacts"."reason_text") and "accounting_reason_artifacts"."reason_text" !~ '[[:cntrl:]]'),
	CONSTRAINT "accounting_reason_artifacts_hashes_chk" CHECK ("accounting_reason_artifacts"."lifecycle_event_sha256" ~ '^[0-9a-f]{64}$' and "accounting_reason_artifacts"."reason_detail_sha256" ~ '^[0-9a-f]{64}$' and "accounting_reason_artifacts"."artifact_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_reason_artifacts_canonical_json_chk" CHECK (jsonb_typeof(("accounting_reason_artifacts"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_reason_artifacts_canonical_shape_chk" CHECK (("accounting_reason_artifacts"."canonical_json"::jsonb - array['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity']) = '{}'::jsonb
        and "accounting_reason_artifacts"."canonical_json"::jsonb ?& array['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'aggregate') - array['kind','id','versionId']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'aggregate') ?& array['kind','id','versionId']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'lifecycleEvent') - array['eventId','eventSha256']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'lifecycleEvent') ?& array['eventId','eventSha256']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'reason') - array['code','text','textSha256','digestDomain']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'reason') ?& array['code','text','textSha256','digestDomain']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'retention') - array['class','legalHoldAware','selectivePlaintextRewriteSupported']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'retention') ?& array['class','legalHoldAware','selectivePlaintextRewriteSupported']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'accessPolicy') - array['mode','listing','plaintextExport']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'accessPolicy') ?& array['mode','listing','plaintextExport']
        and (("accounting_reason_artifacts"."canonical_json"::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','artifactSha256']) = '{}'::jsonb
        and ("accounting_reason_artifacts"."canonical_json"::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','artifactSha256']),
	CONSTRAINT "accounting_reason_artifacts_canonical_binding_chk" CHECK (("accounting_reason_artifacts"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-reason-artifact/v1'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb ->> 'artifactId') = "accounting_reason_artifacts"."id"::text
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{aggregate,kind}') = 'incoming-cost-document'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{aggregate,id}') = "accounting_reason_artifacts"."billing_document_id"::text
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{aggregate,versionId}') = "accounting_reason_artifacts"."accounting_version_id"::text
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{lifecycleEvent,eventId}') = "accounting_reason_artifacts"."lifecycle_event_id"::text
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{lifecycleEvent,eventSha256}') = "accounting_reason_artifacts"."lifecycle_event_sha256"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{reason,code}') = "accounting_reason_artifacts"."reason_code"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{reason,text}') = "accounting_reason_artifacts"."reason_text"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{reason,textSha256}') = "accounting_reason_artifacts"."reason_detail_sha256"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{reason,digestDomain}') = "accounting_reason_artifacts"."digest_domain"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{retention,class}') = 'restricted-accounting-evidence'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{retention,legalHoldAware}') = 'true'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{retention,selectivePlaintextRewriteSupported}') = 'false'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{accessPolicy,mode}') = 'restricted'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{accessPolicy,listing}') = 'metadata-only'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{accessPolicy,plaintextExport}') = 'authorized-audit-only'
        and (("accounting_reason_artifacts"."canonical_json"::jsonb ->> 'recordedAt')::timestamptz) = "accounting_reason_artifacts"."recorded_at"
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{integrity,canonicalization}') = 'site-logbook-cjson/v1'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{integrity,hashAlgorithm}') = 'sha256'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{integrity,hashDomain}') = 'site-logbook.accounting-reason-artifact/v1'
        and ("accounting_reason_artifacts"."canonical_json"::jsonb #>> '{integrity,artifactSha256}') = "accounting_reason_artifacts"."artifact_sha256")
);
--> statement-breakpoint
CREATE TABLE "accounting_version_relations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"relation_type" text NOT NULL,
	"source_version_id" uuid NOT NULL,
	"target_version_id" uuid NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"entry_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_version_relations_type_chk" CHECK ("accounting_version_relations"."relation_type" in ('supersedes', 'corrects', 'credits', 'voids')),
	CONSTRAINT "accounting_version_relations_distinct_chk" CHECK ("accounting_version_relations"."source_version_id" <> "accounting_version_relations"."target_version_id"),
	CONSTRAINT "accounting_version_relations_canonical_json_chk" CHECK (jsonb_typeof(("accounting_version_relations"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_version_relations_canonical_binding_chk" CHECK (("accounting_version_relations"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-version-relation/v1'
        and ("accounting_version_relations"."canonical_json"::jsonb ->> 'relationId') = "accounting_version_relations"."id"::text
        and ("accounting_version_relations"."canonical_json"::jsonb ->> 'relationType') = "accounting_version_relations"."relation_type"
        and ("accounting_version_relations"."canonical_json"::jsonb #>> '{source,versionId}') = "accounting_version_relations"."source_version_id"::text
        and ("accounting_version_relations"."canonical_json"::jsonb #>> '{target,versionId}') = "accounting_version_relations"."target_version_id"::text
        and ("accounting_version_relations"."canonical_json"::jsonb #>> '{integrity,entrySha256}') = "accounting_version_relations"."entry_sha256"),
	CONSTRAINT "accounting_version_relations_entry_hash_chk" CHECK ("accounting_version_relations"."entry_sha256" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "accounting_warehouse_price_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"warehouse_item_id" integer NOT NULL,
	"billing_document_id" integer,
	"accounting_version_id" uuid,
	"lifecycle_event_id" uuid,
	"source_line_id" integer,
	"sequence" bigint NOT NULL,
	"previous_observation_sha256" text,
	"supersedes_observation_id" uuid,
	"transition" text NOT NULL,
	"purchase_price" text,
	"currency" text NOT NULL,
	"warehouse_match_mode" text,
	"warehouse_match_evidence_sha256" text,
	"effective_at" timestamp with time zone,
	"recorded_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"entry_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_warehouse_price_sequence_chk" CHECK ("accounting_warehouse_price_observations"."sequence" >= 0),
	CONSTRAINT "accounting_warehouse_price_previous_chk" CHECK (("accounting_warehouse_price_observations"."sequence" = 0 and "accounting_warehouse_price_observations"."previous_observation_sha256" is null and "accounting_warehouse_price_observations"."supersedes_observation_id" is null) or ("accounting_warehouse_price_observations"."sequence" > 0 and "accounting_warehouse_price_observations"."previous_observation_sha256" is not null and "accounting_warehouse_price_observations"."supersedes_observation_id" is not null)),
	CONSTRAINT "accounting_warehouse_price_transition_chk" CHECK ("accounting_warehouse_price_observations"."transition" in ('legacy_observation', 'observed', 'corrected', 'withdrawn')),
	CONSTRAINT "accounting_warehouse_price_amount_chk" CHECK (("accounting_warehouse_price_observations"."transition" = 'withdrawn' and "accounting_warehouse_price_observations"."purchase_price" is null) or ("accounting_warehouse_price_observations"."transition" <> 'withdrawn' and "accounting_warehouse_price_observations"."purchase_price" ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$')),
	CONSTRAINT "accounting_warehouse_price_currency_chk" CHECK ("accounting_warehouse_price_observations"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounting_warehouse_price_match_tuple_chk" CHECK (("accounting_warehouse_price_observations"."transition" in ('withdrawn', 'legacy_observation') and num_nonnulls("accounting_warehouse_price_observations"."warehouse_match_mode", "accounting_warehouse_price_observations"."warehouse_match_evidence_sha256") = 0) or ("accounting_warehouse_price_observations"."transition" in ('observed', 'corrected') and num_nonnulls("accounting_warehouse_price_observations"."warehouse_match_mode", "accounting_warehouse_price_observations"."warehouse_match_evidence_sha256") = 2)),
	CONSTRAINT "accounting_warehouse_price_match_mode_chk" CHECK ("accounting_warehouse_price_observations"."warehouse_match_mode" is null or "accounting_warehouse_price_observations"."warehouse_match_mode" in ('code', 'name', 'created', 'manual')),
	CONSTRAINT "accounting_warehouse_price_hashes_chk" CHECK (("accounting_warehouse_price_observations"."previous_observation_sha256" is null or "accounting_warehouse_price_observations"."previous_observation_sha256" ~ '^[0-9a-f]{64}$') and ("accounting_warehouse_price_observations"."warehouse_match_evidence_sha256" is null or "accounting_warehouse_price_observations"."warehouse_match_evidence_sha256" ~ '^[0-9a-f]{64}$') and "accounting_warehouse_price_observations"."entry_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_warehouse_price_time_chk" CHECK (("accounting_warehouse_price_observations"."transition" = 'legacy_observation' and "accounting_warehouse_price_observations"."effective_at" is null) or ("accounting_warehouse_price_observations"."transition" <> 'legacy_observation' and "accounting_warehouse_price_observations"."effective_at" is not null and "accounting_warehouse_price_observations"."effective_at" <= "accounting_warehouse_price_observations"."recorded_at")),
	CONSTRAINT "accounting_warehouse_price_source_tuple_chk" CHECK (("accounting_warehouse_price_observations"."transition" = 'legacy_observation' and num_nonnulls("accounting_warehouse_price_observations"."billing_document_id", "accounting_warehouse_price_observations"."accounting_version_id", "accounting_warehouse_price_observations"."lifecycle_event_id", "accounting_warehouse_price_observations"."source_line_id") = 0) or ("accounting_warehouse_price_observations"."transition" <> 'legacy_observation' and num_nonnulls("accounting_warehouse_price_observations"."billing_document_id", "accounting_warehouse_price_observations"."accounting_version_id", "accounting_warehouse_price_observations"."lifecycle_event_id", "accounting_warehouse_price_observations"."source_line_id") = 4)),
	CONSTRAINT "accounting_warehouse_price_canonical_json_chk" CHECK (jsonb_typeof(("accounting_warehouse_price_observations"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_warehouse_price_canonical_shape_chk" CHECK ((
        ("accounting_warehouse_price_observations"."transition" <> 'legacy_observation'
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb - array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity']) = '{}'::jsonb
          and "accounting_warehouse_price_observations"."canonical_json"::jsonb ?& array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity']
          and (("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'source') - array['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId']) = '{}'::jsonb
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'source') ?& array['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId']
          and (jsonb_typeof("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'warehouseMatch') = 'null' or ((("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'warehouseMatch') - array['mode','evidenceSha256']) = '{}'::jsonb and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'warehouseMatch') ?& array['mode','evidenceSha256'])))
        or
        ("accounting_warehouse_price_observations"."transition" = 'legacy_observation'
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb - array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity']) = '{}'::jsonb
          and "accounting_warehouse_price_observations"."canonical_json"::jsonb ?& array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity']
          and (("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'source') - array['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow']) = '{}'::jsonb
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'source') ?& array['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow']
          and (("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{source,latestLegacyRow}') - array['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence']) = '{}'::jsonb
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{source,latestLegacyRow}') ?& array['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence']
          and (("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'valuationPolicy') - array['mode','fxConversionApplied']) = '{}'::jsonb
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'valuationPolicy') ?& array['mode','fxConversionApplied']
          and (("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'provenance') - array['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId']) = '{}'::jsonb
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'provenance') ?& array['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId'])
        )
        and (("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','entrySha256']) = '{}'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','entrySha256']),
	CONSTRAINT "accounting_warehouse_price_canonical_binding_chk" CHECK (("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'schemaVersion') is not distinct from case when "accounting_warehouse_price_observations"."transition" = 'legacy_observation' then 'site-logbook.warehouse-price-legacy-observation/v1' else 'site-logbook.warehouse-price-observation/v1' end
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'observationId') is not distinct from "accounting_warehouse_price_observations"."id"::text
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'warehouseItemId') is not distinct from "accounting_warehouse_price_observations"."warehouse_item_id"::text
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'sequence') is not distinct from "accounting_warehouse_price_observations"."sequence"::text
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'previousObservationSha256') is not distinct from "accounting_warehouse_price_observations"."previous_observation_sha256"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'supersedesObservationId') is not distinct from "accounting_warehouse_price_observations"."supersedes_observation_id"::text
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'transition') is not distinct from "accounting_warehouse_price_observations"."transition"
        and ("accounting_warehouse_price_observations"."transition" = 'legacy_observation' or (("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,aggregateId}') is not distinct from "accounting_warehouse_price_observations"."billing_document_id"::text
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,accountingVersionId}') is not distinct from "accounting_warehouse_price_observations"."accounting_version_id"::text
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,lifecycleEventId}') is not distinct from "accounting_warehouse_price_observations"."lifecycle_event_id"::text
          and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,sourceLineId}') is not distinct from "accounting_warehouse_price_observations"."source_line_id"::text))
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'purchasePrice') is not distinct from "accounting_warehouse_price_observations"."purchase_price"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'currency') is not distinct from "accounting_warehouse_price_observations"."currency"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{warehouseMatch,mode}') is not distinct from "accounting_warehouse_price_observations"."warehouse_match_mode"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{warehouseMatch,evidenceSha256}') is not distinct from "accounting_warehouse_price_observations"."warehouse_match_evidence_sha256"
        and (case when "accounting_warehouse_price_observations"."transition" = 'legacy_observation' then (("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{provenance,capturedAt}')::timestamptz) else (("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'recordedAt')::timestamptz) end) is not distinct from "accounting_warehouse_price_observations"."recorded_at"
        and ("accounting_warehouse_price_observations"."transition" = 'legacy_observation' or (("accounting_warehouse_price_observations"."canonical_json"::jsonb ->> 'effectiveAt')::timestamptz) is not distinct from "accounting_warehouse_price_observations"."effective_at")
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{integrity,canonicalization}') is not distinct from 'site-logbook-cjson/v1'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{integrity,hashAlgorithm}') is not distinct from 'sha256'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{integrity,hashDomain}') is not distinct from case when "accounting_warehouse_price_observations"."transition" = 'legacy_observation' then 'site-logbook.warehouse-price-legacy-observation/v1' else 'site-logbook.warehouse-price-observation/v1' end
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{integrity,entrySha256}') is not distinct from "accounting_warehouse_price_observations"."entry_sha256"),
	CONSTRAINT "accounting_warehouse_price_legacy_semantics_chk" CHECK ("accounting_warehouse_price_observations"."transition" <> 'legacy_observation' or (
        ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{valuationPolicy,mode}') = 'source-currency'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{provenance,captureMode}') = 'legacy-observation'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{provenance,historicalCompleteness}') = 'unknown'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{provenance,actorKnown}') = 'false'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{provenance,effectiveAtKnown}') = 'false'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{provenance,eventHistoryFabricated}') = 'false'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{provenance,accountingVersionId}') = 'null'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{provenance,lifecycleEventId}') = 'null'::jsonb
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,parityReportSha256}') ~ '^[0-9a-f]{64}$'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,parityReportFileSha256}') ~ '^[0-9a-f]{64}$'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,legacyRowsSha256}') ~ '^[0-9a-f]{64}$'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,legacyRowCount}') ~ '^[1-9][0-9]{0,5}$'
        and (("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,legacyRowCount}')::integer) <= 500000
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,legacyRowId}') ~ '^[1-9][0-9]*$'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,rowSha256}') ~ '^[0-9a-f]{64}$'
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,purchasePrice}') = "accounting_warehouse_price_observations"."purchase_price"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,currency}') = "accounting_warehouse_price_observations"."currency"
        and ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,referenceConfidence}') = 'unverified-legacy-reference'
        and (("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,sourceRecordedAt}')::timestamptz) <= "accounting_warehouse_price_observations"."recorded_at"
        and (("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{source,latestLegacyRow,observedBillingDocumentId}') = 'null'::jsonb or ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentId}') ~ '^[1-9][0-9]*$')
        and (("accounting_warehouse_price_observations"."canonical_json"::jsonb #> '{source,latestLegacyRow,observedBillingDocumentLineId}') = 'null'::jsonb or ("accounting_warehouse_price_observations"."canonical_json"::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentLineId}') ~ '^[1-9][0-9]*$')
      ))
);
--> statement-breakpoint
CREATE TABLE "accounting_warehouse_price_projection_heads" (
	"warehouse_item_id" integer PRIMARY KEY NOT NULL,
	"stream_head_observation_id" uuid NOT NULL,
	"stream_head_observation_sha256" text NOT NULL,
	"stream_head_sequence" bigint NOT NULL,
	"effective_observation_id" uuid,
	"effective_observation_sha256" text,
	"purchase_price" text,
	"currency" text,
	"projected_at" timestamp with time zone NOT NULL,
	"canonical_json" text NOT NULL,
	"projection_sha256" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounting_warehouse_price_projection_sequence_chk" CHECK ("accounting_warehouse_price_projection_heads"."stream_head_sequence" >= 0),
	CONSTRAINT "accounting_warehouse_price_projection_effective_tuple_chk" CHECK (num_nonnulls("accounting_warehouse_price_projection_heads"."effective_observation_id", "accounting_warehouse_price_projection_heads"."effective_observation_sha256", "accounting_warehouse_price_projection_heads"."purchase_price", "accounting_warehouse_price_projection_heads"."currency") in (0, 4)),
	CONSTRAINT "accounting_warehouse_price_projection_price_chk" CHECK ("accounting_warehouse_price_projection_heads"."purchase_price" is null or "accounting_warehouse_price_projection_heads"."purchase_price" ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$'),
	CONSTRAINT "accounting_warehouse_price_projection_currency_chk" CHECK ("accounting_warehouse_price_projection_heads"."currency" is null or "accounting_warehouse_price_projection_heads"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "accounting_warehouse_price_projection_hashes_chk" CHECK ("accounting_warehouse_price_projection_heads"."stream_head_observation_sha256" ~ '^[0-9a-f]{64}$' and ("accounting_warehouse_price_projection_heads"."effective_observation_sha256" is null or "accounting_warehouse_price_projection_heads"."effective_observation_sha256" ~ '^[0-9a-f]{64}$') and "accounting_warehouse_price_projection_heads"."projection_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "accounting_warehouse_price_projection_canonical_json_chk" CHECK (jsonb_typeof(("accounting_warehouse_price_projection_heads"."canonical_json")::jsonb) = 'object'),
	CONSTRAINT "accounting_warehouse_price_projection_canonical_shape_chk" CHECK (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb - array['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity']) = '{}'::jsonb
        and "accounting_warehouse_price_projection_heads"."canonical_json"::jsonb ?& array['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity']
        and (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'streamHead') - array['observationId','observationSha256','sequence']) = '{}'::jsonb
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'streamHead') ?& array['observationId','observationSha256','sequence']
        and (jsonb_typeof("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'effectivePrice') = 'null' or ((("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'effectivePrice') - array['observationId','observationSha256','purchasePrice','currency']) = '{}'::jsonb and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'effectivePrice') ?& array['observationId','observationSha256','purchasePrice','currency']))
        and (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'valuationPolicy') - array['mode','fxConversionApplied']) = '{}'::jsonb
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'valuationPolicy') ?& array['mode','fxConversionApplied']
        and (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','projectionSha256']) = '{}'::jsonb
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','projectionSha256']),
	CONSTRAINT "accounting_warehouse_price_projection_canonical_binding_chk" CHECK (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb ->> 'schemaVersion') = 'site-logbook.warehouse-price-projection-head/v1'
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb ->> 'warehouseItemId') = "accounting_warehouse_price_projection_heads"."warehouse_item_id"::text
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{streamHead,observationId}') = "accounting_warehouse_price_projection_heads"."stream_head_observation_id"::text
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{streamHead,observationSha256}') = "accounting_warehouse_price_projection_heads"."stream_head_observation_sha256"
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{streamHead,sequence}') = "accounting_warehouse_price_projection_heads"."stream_head_sequence"::text
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{effectivePrice,observationId}') is not distinct from "accounting_warehouse_price_projection_heads"."effective_observation_id"::text
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{effectivePrice,observationSha256}') is not distinct from "accounting_warehouse_price_projection_heads"."effective_observation_sha256"
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{effectivePrice,purchasePrice}') is not distinct from "accounting_warehouse_price_projection_heads"."purchase_price"
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{effectivePrice,currency}') is not distinct from "accounting_warehouse_price_projection_heads"."currency"
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{valuationPolicy,mode}') = 'source-currency'
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb
        and (("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb ->> 'projectedAt')::timestamptz) = "accounting_warehouse_price_projection_heads"."projected_at"
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{integrity,canonicalization}') = 'site-logbook-cjson/v1'
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{integrity,hashAlgorithm}') = 'sha256'
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{integrity,hashDomain}') = 'site-logbook.warehouse-price-projection-head/v1'
        and ("accounting_warehouse_price_projection_heads"."canonical_json"::jsonb #>> '{integrity,projectionSha256}') = "accounting_warehouse_price_projection_heads"."projection_sha256")
);
--> statement-breakpoint
ALTER TABLE "accounting_aggregate_heads" ADD CONSTRAINT "accounting_aggregate_heads_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_aggregate_heads" ADD CONSTRAINT "accounting_aggregate_heads_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_aggregate_heads" ADD CONSTRAINT "accounting_aggregate_heads_version_head_id_accounting_document_versions_id_fk" FOREIGN KEY ("version_head_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_aggregate_heads" ADD CONSTRAINT "accounting_aggregate_heads_lifecycle_head_id_accounting_lifecycle_events_id_fk" FOREIGN KEY ("lifecycle_head_id") REFERENCES "public"."accounting_lifecycle_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_aggregate_heads" ADD CONSTRAINT "accounting_aggregate_heads_payment_head_id_accounting_payment_events_id_fk" FOREIGN KEY ("payment_head_id") REFERENCES "public"."accounting_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_document_versions" ADD CONSTRAINT "accounting_document_versions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_document_versions" ADD CONSTRAINT "accounting_document_versions_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_document_versions" ADD CONSTRAINT "accounting_document_versions_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_lifecycle_events" ADD CONSTRAINT "accounting_lifecycle_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_lifecycle_events" ADD CONSTRAINT "accounting_lifecycle_events_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_lifecycle_events" ADD CONSTRAINT "accounting_lifecycle_events_document_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("document_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_payment_events" ADD CONSTRAINT "accounting_payment_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_payment_events" ADD CONSTRAINT "accounting_payment_events_invoice_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("invoice_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_payment_events" ADD CONSTRAINT "accounting_payment_events_corrects_fk" FOREIGN KEY ("corrects_payment_event_id") REFERENCES "public"."accounting_payment_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_reason_artifacts" ADD CONSTRAINT "accounting_reason_artifacts_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_reason_artifacts" ADD CONSTRAINT "accounting_reason_artifacts_accounting_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("accounting_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_reason_artifacts" ADD CONSTRAINT "accounting_reason_artifacts_lifecycle_event_id_accounting_lifecycle_events_id_fk" FOREIGN KEY ("lifecycle_event_id") REFERENCES "public"."accounting_lifecycle_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_version_relations" ADD CONSTRAINT "accounting_version_relations_source_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_version_relations" ADD CONSTRAINT "accounting_version_relations_target_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("target_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_observations" ADD CONSTRAINT "accounting_warehouse_price_observations_warehouse_item_id_warehouse_items_id_fk" FOREIGN KEY ("warehouse_item_id") REFERENCES "public"."warehouse_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_observations" ADD CONSTRAINT "accounting_warehouse_price_observations_billing_document_id_billing_documents_id_fk" FOREIGN KEY ("billing_document_id") REFERENCES "public"."billing_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_observations" ADD CONSTRAINT "accounting_warehouse_price_observations_accounting_version_id_accounting_document_versions_id_fk" FOREIGN KEY ("accounting_version_id") REFERENCES "public"."accounting_document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_observations" ADD CONSTRAINT "accounting_warehouse_price_observations_lifecycle_event_id_accounting_lifecycle_events_id_fk" FOREIGN KEY ("lifecycle_event_id") REFERENCES "public"."accounting_lifecycle_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_observations" ADD CONSTRAINT "accounting_warehouse_price_supersedes_fk" FOREIGN KEY ("supersedes_observation_id") REFERENCES "public"."accounting_warehouse_price_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_projection_heads" ADD CONSTRAINT "accounting_warehouse_price_projection_heads_warehouse_item_id_warehouse_items_id_fk" FOREIGN KEY ("warehouse_item_id") REFERENCES "public"."warehouse_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_projection_heads" ADD CONSTRAINT "accounting_warehouse_price_projection_heads_stream_head_observation_id_accounting_warehouse_price_observations_id_fk" FOREIGN KEY ("stream_head_observation_id") REFERENCES "public"."accounting_warehouse_price_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_warehouse_price_projection_heads" ADD CONSTRAINT "accounting_warehouse_price_projection_heads_effective_observation_id_accounting_warehouse_price_observations_id_fk" FOREIGN KEY ("effective_observation_id") REFERENCES "public"."accounting_warehouse_price_observations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_aggregate_heads_invoice_uq" ON "accounting_aggregate_heads" USING btree ("invoice_id") WHERE "accounting_aggregate_heads"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_aggregate_heads_cost_uq" ON "accounting_aggregate_heads" USING btree ("billing_document_id") WHERE "accounting_aggregate_heads"."billing_document_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_document_versions_invoice_version_uq" ON "accounting_document_versions" USING btree ("invoice_id","version") WHERE "accounting_document_versions"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_document_versions_cost_version_uq" ON "accounting_document_versions" USING btree ("billing_document_id","version") WHERE "accounting_document_versions"."billing_document_id" is not null;--> statement-breakpoint
CREATE INDEX "accounting_document_versions_recorded_idx" ON "accounting_document_versions" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "accounting_export_outbox_claim_idx" ON "accounting_export_outbox" USING btree ("state","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_lifecycle_events_invoice_sequence_uq" ON "accounting_lifecycle_events" USING btree ("invoice_id","sequence") WHERE "accounting_lifecycle_events"."invoice_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_lifecycle_events_cost_sequence_uq" ON "accounting_lifecycle_events" USING btree ("billing_document_id","sequence") WHERE "accounting_lifecycle_events"."billing_document_id" is not null;--> statement-breakpoint
CREATE INDEX "accounting_lifecycle_events_version_idx" ON "accounting_lifecycle_events" USING btree ("document_version_id");--> statement-breakpoint
CREATE INDEX "accounting_lifecycle_events_recorded_idx" ON "accounting_lifecycle_events" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_payment_events_invoice_sequence_uq" ON "accounting_payment_events" USING btree ("invoice_id","sequence");--> statement-breakpoint
CREATE INDEX "accounting_payment_events_version_idx" ON "accounting_payment_events" USING btree ("invoice_version_id");--> statement-breakpoint
CREATE INDEX "accounting_payment_events_recorded_idx" ON "accounting_payment_events" USING btree ("recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_reason_artifacts_lifecycle_uq" ON "accounting_reason_artifacts" USING btree ("lifecycle_event_id");--> statement-breakpoint
CREATE INDEX "accounting_reason_artifacts_document_idx" ON "accounting_reason_artifacts" USING btree ("billing_document_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_version_relations_exact_uq" ON "accounting_version_relations" USING btree ("relation_type","source_version_id","target_version_id");--> statement-breakpoint
CREATE INDEX "accounting_version_relations_source_idx" ON "accounting_version_relations" USING btree ("source_version_id");--> statement-breakpoint
CREATE INDEX "accounting_version_relations_target_idx" ON "accounting_version_relations" USING btree ("target_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_warehouse_price_item_sequence_uq" ON "accounting_warehouse_price_observations" USING btree ("warehouse_item_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "accounting_warehouse_price_source_event_line_uq" ON "accounting_warehouse_price_observations" USING btree ("lifecycle_event_id","source_line_id") WHERE "accounting_warehouse_price_observations"."transition" <> 'legacy_observation';--> statement-breakpoint
CREATE INDEX "accounting_warehouse_price_version_idx" ON "accounting_warehouse_price_observations" USING btree ("accounting_version_id");--> statement-breakpoint
CREATE INDEX "accounting_warehouse_price_document_line_idx" ON "accounting_warehouse_price_observations" USING btree ("billing_document_id","source_line_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION deny_accounting_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is immutable; append a correction, relation or new event', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "accounting_document_versions_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_document_versions"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();
CREATE TRIGGER "accounting_lifecycle_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_lifecycle_events"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();
CREATE TRIGGER "accounting_reason_artifacts_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_reason_artifacts"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();
CREATE TRIGGER "accounting_payment_events_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_payment_events"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();
CREATE TRIGGER "accounting_version_relations_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_version_relations"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();
CREATE TRIGGER "accounting_warehouse_price_observations_immutable_trg"
BEFORE UPDATE OR DELETE ON "accounting_warehouse_price_observations"
FOR EACH ROW EXECUTE FUNCTION deny_accounting_evidence_mutation();

CREATE OR REPLACE FUNCTION guard_accounting_evidence_insert_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound_version accounting_document_versions%ROWTYPE;
  corrected_payment accounting_payment_events%ROWTYPE;
  bound_lifecycle accounting_lifecycle_events%ROWTYPE;
  previous_price accounting_warehouse_price_observations%ROWTYPE;
  superseded_price accounting_warehouse_price_observations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'accounting_lifecycle_events' THEN
    SELECT * INTO bound_version FROM accounting_document_versions
      WHERE id = NEW.document_version_id;
    IF NOT FOUND OR
       bound_version.invoice_id IS DISTINCT FROM NEW.invoice_id OR
       bound_version.billing_document_id IS DISTINCT FROM NEW.billing_document_id THEN
      RAISE EXCEPTION 'lifecycle event root does not match its document version';
    END IF;
    IF NEW.event_type = 'ignored' AND bound_version.purpose <> 'discarded_observation' THEN
      RAISE EXCEPTION 'ignored lifecycle event requires a discarded-observation version';
    END IF;
  ELSIF TG_TABLE_NAME = 'accounting_reason_artifacts' THEN
    SELECT * INTO bound_version FROM accounting_document_versions
      WHERE id = NEW.accounting_version_id;
    IF NOT FOUND OR bound_version.billing_document_id IS DISTINCT FROM NEW.billing_document_id OR
       bound_version.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'reason artifact root does not match its document version';
    END IF;
    SELECT * INTO bound_lifecycle FROM accounting_lifecycle_events
      WHERE id = NEW.lifecycle_event_id;
    IF NOT FOUND OR bound_lifecycle.billing_document_id IS DISTINCT FROM NEW.billing_document_id OR
       bound_lifecycle.invoice_id IS NOT NULL OR
       bound_lifecycle.document_version_id IS DISTINCT FROM NEW.accounting_version_id OR
       bound_lifecycle.entry_sha256 IS DISTINCT FROM NEW.lifecycle_event_sha256 OR
       (bound_lifecycle.canonical_json::jsonb ->> 'reasonCode') IS DISTINCT FROM NEW.reason_code OR
       (bound_lifecycle.canonical_json::jsonb ->> 'reasonDetailSha256') IS DISTINCT FROM NEW.reason_detail_sha256 OR
       bound_lifecycle.recorded_at IS DISTINCT FROM NEW.recorded_at OR
       (NEW.digest_domain = 'site-logbook.cost-document-review-reopen-reason/v1' AND bound_lifecycle.event_type <> 'review_reopened') OR
       (NEW.digest_domain = 'site-logbook.cost-document-reviewed-rejection-reason/v1' AND bound_lifecycle.event_type <> 'ignored') THEN
      RAISE EXCEPTION 'reason artifact does not match its lifecycle event';
    END IF;
  ELSIF TG_TABLE_NAME = 'accounting_payment_events' THEN
    SELECT * INTO bound_version FROM accounting_document_versions
      WHERE id = NEW.invoice_version_id;
    IF NOT FOUND OR bound_version.invoice_id IS DISTINCT FROM NEW.invoice_id OR
       bound_version.billing_document_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment event invoice does not match its document version';
    END IF;
    IF NEW.corrects_payment_event_id IS NOT NULL THEN
      SELECT * INTO corrected_payment FROM accounting_payment_events
        WHERE id = NEW.corrects_payment_event_id;
      IF NOT FOUND OR corrected_payment.invoice_id <> NEW.invoice_id OR
         corrected_payment.sequence >= NEW.sequence THEN
        RAISE EXCEPTION 'payment correction must reference an earlier event from the same invoice';
      END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'accounting_warehouse_price_observations' THEN
    IF NEW.transition <> 'legacy_observation' THEN
      SELECT * INTO bound_version FROM accounting_document_versions
        WHERE id = NEW.accounting_version_id;
      SELECT * INTO bound_lifecycle FROM accounting_lifecycle_events
        WHERE id = NEW.lifecycle_event_id;
      IF NOT FOUND OR bound_version.billing_document_id IS DISTINCT FROM NEW.billing_document_id OR
         bound_version.invoice_id IS NOT NULL OR
         bound_lifecycle.billing_document_id IS DISTINCT FROM NEW.billing_document_id OR
         bound_lifecycle.invoice_id IS NOT NULL OR
         bound_lifecycle.document_version_id IS DISTINCT FROM NEW.accounting_version_id OR
         bound_lifecycle.entry_sha256 IS DISTINCT FROM (NEW.canonical_json::jsonb #>> '{source,lifecycleEventSha256}') OR
         bound_version.version_sha256 IS DISTINCT FROM (NEW.canonical_json::jsonb #>> '{source,accountingVersionSha256}') OR
         (NEW.canonical_json::jsonb -> 'actor') IS DISTINCT FROM (bound_lifecycle.canonical_json::jsonb -> 'actor') OR
         (NEW.canonical_json::jsonb ->> 'reasonCode') IS DISTINCT FROM (bound_lifecycle.canonical_json::jsonb ->> 'reasonCode') OR
         (NEW.canonical_json::jsonb ->> 'reasonDetailSha256') IS DISTINCT FROM (bound_lifecycle.canonical_json::jsonb ->> 'reasonDetailSha256') OR
         (NEW.canonical_json::jsonb ->> 'effectiveAt') IS DISTINCT FROM (bound_lifecycle.canonical_json::jsonb ->> 'effectiveAt') OR
         (NEW.canonical_json::jsonb ->> 'recordedAt') IS DISTINCT FROM (bound_lifecycle.canonical_json::jsonb ->> 'recordedAt') OR
         (bound_version.canonical_json::jsonb #>> '{snapshot,document,currency}') IS DISTINCT FROM NEW.currency OR
         NOT EXISTS (
           SELECT 1
           FROM jsonb_array_elements(bound_version.canonical_json::jsonb #> '{snapshot,lines}') AS source_line
           WHERE source_line ->> 'sourceLineId' = NEW.source_line_id::text
             AND source_line ->> 'lineType' = 'material'
             AND (NEW.transition = 'withdrawn' OR source_line ->> 'unitPriceWithoutVat' = NEW.purchase_price)
         ) THEN
        RAISE EXCEPTION 'warehouse-price observation source does not match accounting evidence';
      END IF;
    END IF;

    IF NEW.sequence = 0 THEN
      IF NEW.transition = 'withdrawn' THEN
        RAISE EXCEPTION 'first warehouse-price observation cannot be a withdrawal';
      END IF;
      IF EXISTS (SELECT 1 FROM accounting_warehouse_price_observations WHERE warehouse_item_id = NEW.warehouse_item_id) THEN
        RAISE EXCEPTION 'first warehouse-price observation requires an empty item stream';
      END IF;
    ELSE
      IF NEW.transition = 'legacy_observation' THEN
        RAISE EXCEPTION 'legacy warehouse-price observation can only initialize an empty stream';
      END IF;
      SELECT * INTO previous_price FROM accounting_warehouse_price_observations
        WHERE warehouse_item_id = NEW.warehouse_item_id AND sequence = NEW.sequence - 1;
      IF NOT FOUND OR previous_price.entry_sha256 IS DISTINCT FROM NEW.previous_observation_sha256 THEN
        RAISE EXCEPTION 'warehouse-price observation is not the exact next chain step';
      END IF;
      SELECT * INTO superseded_price FROM accounting_warehouse_price_observations
        WHERE id = NEW.supersedes_observation_id;
      IF NOT FOUND OR superseded_price.warehouse_item_id IS DISTINCT FROM NEW.warehouse_item_id OR
         superseded_price.sequence >= NEW.sequence THEN
        RAISE EXCEPTION 'warehouse-price supersession must reference an earlier item observation';
      END IF;
      IF previous_price.transition = 'legacy_observation' THEN
        IF NEW.transition NOT IN ('observed', 'corrected') OR
           superseded_price.id IS DISTINCT FROM previous_price.id THEN
          RAISE EXCEPTION 'first native warehouse price must supersede the legacy item head';
        END IF;
      ELSE
        IF superseded_price.transition = 'legacy_observation' THEN
          RAISE EXCEPTION 'later native warehouse-price transition cannot target legacy evidence';
        END IF;
        IF NEW.transition = 'observed' AND
           superseded_price.id IS DISTINCT FROM previous_price.id THEN
          RAISE EXCEPTION 'observed warehouse price must supersede the previous item head';
        END IF;
        IF NEW.transition = 'withdrawn' AND
           (superseded_price.transition = 'withdrawn' OR
            superseded_price.billing_document_id IS DISTINCT FROM NEW.billing_document_id OR
            superseded_price.accounting_version_id IS DISTINCT FROM NEW.accounting_version_id OR
            superseded_price.source_line_id IS DISTINCT FROM NEW.source_line_id) THEN
          RAISE EXCEPTION 'warehouse-price withdrawal must target its active source observation';
        END IF;
        IF NEW.transition = 'corrected' AND
           superseded_price.id IS DISTINCT FROM previous_price.id AND
           (superseded_price.transition <> 'withdrawn' OR
            superseded_price.billing_document_id IS DISTINCT FROM NEW.billing_document_id) THEN
          RAISE EXCEPTION 'corrected warehouse price must supersede the previous item head or a withdrawal from the same document';
        END IF;
      END IF;
    END IF;
    IF NEW.transition <> 'legacy_observation' AND ((NEW.transition = 'observed' AND
        (bound_version.purpose <> 'approved' OR bound_lifecycle.event_type <> 'approved')) OR
       (NEW.transition = 'corrected' AND
        (bound_version.purpose <> 'correction' OR bound_lifecycle.event_type <> 'correction_linked')) OR
       (NEW.transition = 'withdrawn' AND
        (bound_version.purpose NOT IN ('approved', 'correction') OR bound_lifecycle.event_type <> 'review_reopened'))) THEN
      RAISE EXCEPTION 'warehouse-price transition does not match accounting version and lifecycle event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_lifecycle_events_binding_trg"
BEFORE INSERT ON "accounting_lifecycle_events"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_evidence_insert_binding();
CREATE TRIGGER "accounting_reason_artifacts_binding_trg"
BEFORE INSERT ON "accounting_reason_artifacts"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_evidence_insert_binding();
CREATE TRIGGER "accounting_payment_events_binding_trg"
BEFORE INSERT ON "accounting_payment_events"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_evidence_insert_binding();
CREATE TRIGGER "accounting_warehouse_price_observations_binding_trg"
BEFORE INSERT ON "accounting_warehouse_price_observations"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_evidence_insert_binding();

CREATE OR REPLACE FUNCTION guard_accounting_warehouse_price_projection_head()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  stream_observation accounting_warehouse_price_observations%ROWTYPE;
  expected_effective accounting_warehouse_price_observations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'warehouse-price projection heads cannot be deleted; append evidence and advance the projection';
  END IF;

  SELECT * INTO stream_observation
  FROM accounting_warehouse_price_observations
  WHERE id = NEW.stream_head_observation_id;
  IF NOT FOUND OR
     stream_observation.warehouse_item_id IS DISTINCT FROM NEW.warehouse_item_id OR
     stream_observation.entry_sha256 IS DISTINCT FROM NEW.stream_head_observation_sha256 OR
     stream_observation.sequence IS DISTINCT FROM NEW.stream_head_sequence OR
     EXISTS (
       SELECT 1 FROM accounting_warehouse_price_observations later
       WHERE later.warehouse_item_id = NEW.warehouse_item_id
         AND later.sequence > NEW.stream_head_sequence
     ) THEN
    RAISE EXCEPTION 'warehouse-price projection stream head is not the exact latest observation';
  END IF;

  SELECT candidate.* INTO expected_effective
  FROM accounting_warehouse_price_observations candidate
  WHERE candidate.warehouse_item_id = NEW.warehouse_item_id
    AND candidate.sequence <= NEW.stream_head_sequence
    AND candidate.transition <> 'withdrawn'
    AND NOT EXISTS (
      SELECT 1 FROM accounting_warehouse_price_observations withdrawal
      WHERE withdrawal.warehouse_item_id = candidate.warehouse_item_id
        AND withdrawal.sequence <= NEW.stream_head_sequence
        AND withdrawal.transition = 'withdrawn'
        AND withdrawal.supersedes_observation_id = candidate.id
    )
  ORDER BY candidate.sequence DESC
  LIMIT 1;

  IF FOUND THEN
    IF expected_effective.id IS DISTINCT FROM NEW.effective_observation_id OR
       expected_effective.entry_sha256 IS DISTINCT FROM NEW.effective_observation_sha256 OR
       expected_effective.purchase_price IS DISTINCT FROM NEW.purchase_price OR
       expected_effective.currency IS DISTINCT FROM NEW.currency THEN
      RAISE EXCEPTION 'warehouse-price projection effective price does not match the immutable stream';
    END IF;
  ELSIF num_nonnulls(NEW.effective_observation_id, NEW.effective_observation_sha256, NEW.purchase_price, NEW.currency) <> 0 THEN
    RAISE EXCEPTION 'warehouse-price projection must be empty when no effective observation remains';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.warehouse_item_id IS DISTINCT FROM OLD.warehouse_item_id OR
       NEW.stream_head_sequence IS DISTINCT FROM OLD.stream_head_sequence + 1 OR
       stream_observation.previous_observation_sha256 IS DISTINCT FROM OLD.stream_head_observation_sha256 THEN
      RAISE EXCEPTION 'warehouse-price projection update must advance exactly one observation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_warehouse_price_projection_heads_guard_trg"
BEFORE INSERT OR UPDATE OR DELETE ON "accounting_warehouse_price_projection_heads"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_warehouse_price_projection_head();

CREATE OR REPLACE FUNCTION guard_accounting_outbox_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting export outbox rows cannot be deleted';
  END IF;
  IF NEW.intent_id <> OLD.intent_id OR
     NEW.operation <> OLD.operation OR
     NEW.canonical_json <> OLD.canonical_json OR
     NEW.intent_sha256 <> OLD.intent_sha256 OR
     NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'accounting export intent evidence is immutable';
  END IF;
  IF OLD.state IN ('exported', 'dead_letter') THEN
    RAISE EXCEPTION 'terminal accounting export outbox rows are immutable';
  END IF;
  IF OLD.state = 'pending' AND NEW.state <> 'exporting' THEN
    RAISE EXCEPTION 'pending accounting export must be claimed before transition';
  END IF;
  IF OLD.state = 'exporting' AND NEW.state NOT IN ('exporting', 'pending', 'exported', 'dead_letter') THEN
    RAISE EXCEPTION 'accounting export transition is invalid';
  END IF;
  IF NEW.state = 'exporting' AND NEW.attempt_count <> OLD.attempt_count + 1 THEN
    RAISE EXCEPTION 'accounting export claim must increment attempt count exactly once';
  END IF;
  IF NEW.state <> 'exporting' AND NEW.attempt_count <> OLD.attempt_count THEN
    RAISE EXCEPTION 'accounting export completion cannot change attempt count';
  END IF;
  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'accounting export timestamps cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_export_outbox_guard_trg"
BEFORE UPDATE OR DELETE ON "accounting_export_outbox"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_outbox_transition();

CREATE OR REPLACE FUNCTION guard_accounting_aggregate_head_transition()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  version_changed boolean;
  lifecycle_changed boolean;
  payment_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'accounting aggregate heads cannot be deleted';
  END IF;
  IF NEW.id <> OLD.id OR
     NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR
     NEW.billing_document_id IS DISTINCT FROM OLD.billing_document_id OR
     NEW.created_at <> OLD.created_at OR
     NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'accounting aggregate head must advance the same root by exactly one revision';
  END IF;

  version_changed := ROW(NEW.version_head_version, NEW.version_head_id, NEW.version_head_sha256)
    IS DISTINCT FROM ROW(OLD.version_head_version, OLD.version_head_id, OLD.version_head_sha256);
  lifecycle_changed := ROW(NEW.lifecycle_head_sequence, NEW.lifecycle_head_id, NEW.lifecycle_head_sha256)
    IS DISTINCT FROM ROW(OLD.lifecycle_head_sequence, OLD.lifecycle_head_id, OLD.lifecycle_head_sha256);
  payment_changed := ROW(NEW.payment_head_sequence, NEW.payment_head_id, NEW.payment_head_sha256)
    IS DISTINCT FROM ROW(OLD.payment_head_sequence, OLD.payment_head_id, OLD.payment_head_sha256);

  IF NOT (version_changed OR lifecycle_changed OR payment_changed) THEN
    RAISE EXCEPTION 'accounting aggregate revision cannot advance without a new evidence head';
  END IF;

  IF version_changed AND NOT EXISTS (
    SELECT 1 FROM accounting_document_versions version
    WHERE version.id = NEW.version_head_id
      AND version.invoice_id IS NOT DISTINCT FROM NEW.invoice_id
      AND version.billing_document_id IS NOT DISTINCT FROM NEW.billing_document_id
      AND version.version = NEW.version_head_version
      AND version.version_sha256 = NEW.version_head_sha256
      AND version.version = COALESCE(OLD.version_head_version + 1, 1)
      AND version.supersedes_version_id IS NOT DISTINCT FROM OLD.version_head_id
  ) THEN
    RAISE EXCEPTION 'accounting document version head is not an exact persisted successor';
  END IF;

  IF lifecycle_changed AND NOT EXISTS (
    SELECT 1 FROM accounting_lifecycle_events event
    WHERE event.id = NEW.lifecycle_head_id
      AND event.invoice_id IS NOT DISTINCT FROM NEW.invoice_id
      AND event.billing_document_id IS NOT DISTINCT FROM NEW.billing_document_id
      AND event.sequence = NEW.lifecycle_head_sequence
      AND event.entry_sha256 = NEW.lifecycle_head_sha256
      AND event.sequence = COALESCE(OLD.lifecycle_head_sequence + 1, 0)
      AND event.previous_event_sha256 IS NOT DISTINCT FROM OLD.lifecycle_head_sha256
  ) THEN
    RAISE EXCEPTION 'accounting lifecycle head is not an exact persisted successor';
  END IF;

  IF payment_changed AND NOT EXISTS (
    SELECT 1 FROM accounting_payment_events event
    WHERE event.id = NEW.payment_head_id
      AND event.invoice_id = NEW.invoice_id
      AND NEW.billing_document_id IS NULL
      AND event.sequence = NEW.payment_head_sequence
      AND event.entry_sha256 = NEW.payment_head_sha256
      AND event.sequence = COALESCE(OLD.payment_head_sequence + 1, 0)
      AND event.previous_event_sha256 IS NOT DISTINCT FROM OLD.payment_head_sha256
  ) THEN
    RAISE EXCEPTION 'accounting payment head is not an exact persisted successor';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "accounting_aggregate_heads_guard_trg"
BEFORE UPDATE OR DELETE ON "accounting_aggregate_heads"
FOR EACH ROW EXECUTE FUNCTION guard_accounting_aggregate_head_transition();

-- R13-D2 + R13-D9B expand-only template. This file is intentionally not a numbered
-- migration. Allocate its final migration number only after the public-main
-- 0096 lineage conflict is resolved. Migration 0100 remains excluded.

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
  CONSTRAINT "accounting_document_versions_root_chk"
    CHECK (num_nonnulls("invoice_id", "billing_document_id") = 1),
  CONSTRAINT "accounting_document_versions_number_chk" CHECK ("version" >= 1),
  CONSTRAINT "accounting_document_versions_purpose_chk"
    CHECK ("purpose" IN ('issued', 'approved', 'correction', 'credit', 'cancellation_notice', 'discarded_observation', 'legacy_observation')),
  CONSTRAINT "accounting_document_versions_completeness_chk"
    CHECK ("historical_completeness" IN ('complete', 'unknown')),
  CONSTRAINT "accounting_document_versions_supersedes_self_chk"
    CHECK ("supersedes_version_id" IS NULL OR "supersedes_version_id" <> "id"),
  CONSTRAINT "accounting_document_versions_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_document_versions_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-document-version/v1' AND
           (("canonical_json")::jsonb ->> 'versionId') = "id"::text AND
           (("canonical_json")::jsonb #>> '{aggregate,kind}') = CASE WHEN "invoice_id" IS NOT NULL THEN 'outgoing-invoice' ELSE 'incoming-cost-document' END AND
           (("canonical_json")::jsonb #>> '{aggregate,id}') = coalesce("invoice_id", "billing_document_id")::text AND
           (("canonical_json")::jsonb ->> 'version') = "version"::text AND
           (("canonical_json")::jsonb ->> 'purpose') = "purpose" AND
           (("canonical_json")::jsonb ->> 'historicalCompleteness') = "historical_completeness" AND
           (("canonical_json")::jsonb ->> 'supersedesVersionId') IS NOT DISTINCT FROM "supersedes_version_id"::text AND
           (("canonical_json")::jsonb #>> '{integrity,snapshotSha256}') = "snapshot_sha256" AND
           (("canonical_json")::jsonb #>> '{integrity,artifactSetSha256}') = "artifact_set_sha256" AND
           (("canonical_json")::jsonb #>> '{integrity,versionSha256}') = "version_sha256"),
  CONSTRAINT "accounting_document_versions_snapshot_hash_chk"
    CHECK ("snapshot_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_document_versions_artifact_hash_chk"
    CHECK ("artifact_set_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_document_versions_version_hash_chk"
    CHECK ("version_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "accounting_document_versions"
  ADD CONSTRAINT "accounting_document_versions_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_document_versions"
  ADD CONSTRAINT "accounting_document_versions_cost_fk"
  FOREIGN KEY ("billing_document_id") REFERENCES "billing_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_document_versions"
  ADD CONSTRAINT "accounting_document_versions_supersedes_fk"
  FOREIGN KEY ("supersedes_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_document_versions_invoice_version_uq"
  ON "accounting_document_versions" ("invoice_id", "version")
  WHERE "invoice_id" IS NOT NULL;
CREATE UNIQUE INDEX "accounting_document_versions_cost_version_uq"
  ON "accounting_document_versions" ("billing_document_id", "version")
  WHERE "billing_document_id" IS NOT NULL;
CREATE INDEX "accounting_document_versions_recorded_idx"
  ON "accounting_document_versions" ("recorded_at");

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
  CONSTRAINT "accounting_lifecycle_events_root_chk"
    CHECK (num_nonnulls("invoice_id", "billing_document_id") = 1),
  CONSTRAINT "accounting_lifecycle_events_sequence_chk" CHECK ("sequence" >= 0),
  CONSTRAINT "accounting_lifecycle_events_previous_chk"
    CHECK (("sequence" = 0 AND "previous_event_sha256" IS NULL) OR
           ("sequence" > 0 AND "previous_event_sha256" IS NOT NULL)),
  CONSTRAINT "accounting_lifecycle_events_type_chk"
    CHECK ("event_type" IN ('issued', 'sent', 'cancellation_requested', 'void_confirmed', 'credit_linked', 'correction_linked', 'approved', 'review_reopened', 'ignored')),
  CONSTRAINT "accounting_lifecycle_events_previous_hash_chk"
    CHECK ("previous_event_sha256" IS NULL OR "previous_event_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_lifecycle_events_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_lifecycle_events_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-lifecycle-event/v1' AND
           (("canonical_json")::jsonb ->> 'eventId') = "id"::text AND
           (("canonical_json")::jsonb #>> '{aggregate,kind}') = CASE WHEN "invoice_id" IS NOT NULL THEN 'outgoing-invoice' ELSE 'incoming-cost-document' END AND
           (("canonical_json")::jsonb #>> '{aggregate,id}') = coalesce("invoice_id", "billing_document_id")::text AND
           (("canonical_json")::jsonb #>> '{aggregate,versionId}') = "document_version_id"::text AND
           (("canonical_json")::jsonb ->> 'sequence') = "sequence"::text AND
           (("canonical_json")::jsonb ->> 'previousEventSha256') IS NOT DISTINCT FROM "previous_event_sha256" AND
           (("canonical_json")::jsonb ->> 'eventType') = "event_type" AND
           (("canonical_json")::jsonb #>> '{integrity,entrySha256}') = "entry_sha256"),
  CONSTRAINT "accounting_lifecycle_events_entry_hash_chk"
    CHECK ("entry_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "accounting_lifecycle_events"
  ADD CONSTRAINT "accounting_lifecycle_events_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_lifecycle_events"
  ADD CONSTRAINT "accounting_lifecycle_events_cost_fk"
  FOREIGN KEY ("billing_document_id") REFERENCES "billing_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_lifecycle_events"
  ADD CONSTRAINT "accounting_lifecycle_events_version_fk"
  FOREIGN KEY ("document_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_lifecycle_events_invoice_sequence_uq"
  ON "accounting_lifecycle_events" ("invoice_id", "sequence")
  WHERE "invoice_id" IS NOT NULL;
CREATE UNIQUE INDEX "accounting_lifecycle_events_cost_sequence_uq"
  ON "accounting_lifecycle_events" ("billing_document_id", "sequence")
  WHERE "billing_document_id" IS NOT NULL;
CREATE INDEX "accounting_lifecycle_events_version_idx"
  ON "accounting_lifecycle_events" ("document_version_id");
CREATE INDEX "accounting_lifecycle_events_recorded_idx"
  ON "accounting_lifecycle_events" ("recorded_at");

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
  CONSTRAINT "accounting_reason_artifacts_code_chk"
    CHECK ("reason_code" IN ('review_reopened', 'duplicate_document', 'invalid_document')),
  CONSTRAINT "accounting_reason_artifacts_domain_chk"
    CHECK ("digest_domain" IN ('site-logbook.cost-document-review-reopen-reason/v1', 'site-logbook.cost-document-reviewed-rejection-reason/v1')),
  CONSTRAINT "accounting_reason_artifacts_text_chk"
    CHECK (char_length("reason_text") BETWEEN 3 AND 1000 AND "reason_text" = btrim("reason_text") AND "reason_text" !~ '[[:cntrl:]]'),
  CONSTRAINT "accounting_reason_artifacts_hashes_chk"
    CHECK ("lifecycle_event_sha256" ~ '^[0-9a-f]{64}$' AND "reason_detail_sha256" ~ '^[0-9a-f]{64}$' AND "artifact_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_reason_artifacts_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_reason_artifacts_canonical_shape_chk"
    CHECK ((("canonical_json")::jsonb - ARRAY['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity']) = '{}'::jsonb AND
           ("canonical_json")::jsonb ?& ARRAY['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity'] AND
           ((("canonical_json")::jsonb -> 'aggregate') - ARRAY['kind','id','versionId']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'aggregate') ?& ARRAY['kind','id','versionId'] AND
           ((("canonical_json")::jsonb -> 'lifecycleEvent') - ARRAY['eventId','eventSha256']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'lifecycleEvent') ?& ARRAY['eventId','eventSha256'] AND
           ((("canonical_json")::jsonb -> 'reason') - ARRAY['code','text','textSha256','digestDomain']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'reason') ?& ARRAY['code','text','textSha256','digestDomain'] AND
           ((("canonical_json")::jsonb -> 'retention') - ARRAY['class','legalHoldAware','selectivePlaintextRewriteSupported']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'retention') ?& ARRAY['class','legalHoldAware','selectivePlaintextRewriteSupported'] AND
           ((("canonical_json")::jsonb -> 'accessPolicy') - ARRAY['mode','listing','plaintextExport']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'accessPolicy') ?& ARRAY['mode','listing','plaintextExport'] AND
           ((("canonical_json")::jsonb -> 'integrity') - ARRAY['canonicalization','hashAlgorithm','hashDomain','artifactSha256']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'integrity') ?& ARRAY['canonicalization','hashAlgorithm','hashDomain','artifactSha256']),
  CONSTRAINT "accounting_reason_artifacts_canonical_binding_chk"
    CHECK (("canonical_json")::jsonb ->> 'schemaVersion' = 'site-logbook.accounting-reason-artifact/v1' AND
           ("canonical_json")::jsonb ->> 'artifactId' = "id"::text AND
           ("canonical_json")::jsonb #>> '{aggregate,kind}' = 'incoming-cost-document' AND
           ("canonical_json")::jsonb #>> '{aggregate,id}' = "billing_document_id"::text AND
           ("canonical_json")::jsonb #>> '{aggregate,versionId}' = "accounting_version_id"::text AND
           ("canonical_json")::jsonb #>> '{lifecycleEvent,eventId}' = "lifecycle_event_id"::text AND
           ("canonical_json")::jsonb #>> '{lifecycleEvent,eventSha256}' = "lifecycle_event_sha256" AND
           ("canonical_json")::jsonb #>> '{reason,code}' = "reason_code" AND
           ("canonical_json")::jsonb #>> '{reason,text}' = "reason_text" AND
           ("canonical_json")::jsonb #>> '{reason,textSha256}' = "reason_detail_sha256" AND
           ("canonical_json")::jsonb #>> '{reason,digestDomain}' = "digest_domain" AND
           ("canonical_json")::jsonb #>> '{retention,class}' = 'restricted-accounting-evidence' AND
           ("canonical_json")::jsonb #>> '{retention,legalHoldAware}' = 'true' AND
           ("canonical_json")::jsonb #>> '{retention,selectivePlaintextRewriteSupported}' = 'false' AND
           ("canonical_json")::jsonb #>> '{accessPolicy,mode}' = 'restricted' AND
           ("canonical_json")::jsonb #>> '{accessPolicy,listing}' = 'metadata-only' AND
           ("canonical_json")::jsonb #>> '{accessPolicy,plaintextExport}' = 'authorized-audit-only' AND
           ((("canonical_json")::jsonb ->> 'recordedAt')::timestamptz) = "recorded_at" AND
           ("canonical_json")::jsonb #>> '{integrity,canonicalization}' = 'site-logbook-cjson/v1' AND
           ("canonical_json")::jsonb #>> '{integrity,hashAlgorithm}' = 'sha256' AND
           ("canonical_json")::jsonb #>> '{integrity,hashDomain}' = 'site-logbook.accounting-reason-artifact/v1' AND
           ("canonical_json")::jsonb #>> '{integrity,artifactSha256}' = "artifact_sha256")
);

ALTER TABLE "accounting_reason_artifacts"
  ADD CONSTRAINT "accounting_reason_artifacts_document_fk"
  FOREIGN KEY ("billing_document_id") REFERENCES "billing_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_reason_artifacts"
  ADD CONSTRAINT "accounting_reason_artifacts_version_fk"
  FOREIGN KEY ("accounting_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_reason_artifacts"
  ADD CONSTRAINT "accounting_reason_artifacts_lifecycle_fk"
  FOREIGN KEY ("lifecycle_event_id") REFERENCES "accounting_lifecycle_events"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_reason_artifacts_lifecycle_uq"
  ON "accounting_reason_artifacts" ("lifecycle_event_id");
CREATE INDEX "accounting_reason_artifacts_document_idx"
  ON "accounting_reason_artifacts" ("billing_document_id", "recorded_at");

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
  CONSTRAINT "accounting_warehouse_price_sequence_chk" CHECK ("sequence" >= 0),
  CONSTRAINT "accounting_warehouse_price_previous_chk"
    CHECK (("sequence" = 0 AND "previous_observation_sha256" IS NULL AND "supersedes_observation_id" IS NULL) OR
           ("sequence" > 0 AND "previous_observation_sha256" IS NOT NULL AND "supersedes_observation_id" IS NOT NULL)),
  CONSTRAINT "accounting_warehouse_price_transition_chk"
    CHECK ("transition" IN ('legacy_observation', 'observed', 'corrected', 'withdrawn')),
  CONSTRAINT "accounting_warehouse_price_amount_chk"
    CHECK (("transition" = 'withdrawn' AND "purchase_price" IS NULL) OR
           ("transition" <> 'withdrawn' AND "purchase_price" ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$')),
  CONSTRAINT "accounting_warehouse_price_currency_chk"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "accounting_warehouse_price_match_tuple_chk"
    CHECK (("transition" IN ('withdrawn', 'legacy_observation') AND num_nonnulls("warehouse_match_mode", "warehouse_match_evidence_sha256") = 0) OR
           ("transition" IN ('observed', 'corrected') AND num_nonnulls("warehouse_match_mode", "warehouse_match_evidence_sha256") = 2)),
  CONSTRAINT "accounting_warehouse_price_match_mode_chk"
    CHECK ("warehouse_match_mode" IS NULL OR "warehouse_match_mode" IN ('code', 'name', 'created', 'manual')),
  CONSTRAINT "accounting_warehouse_price_hashes_chk"
    CHECK (("previous_observation_sha256" IS NULL OR "previous_observation_sha256" ~ '^[0-9a-f]{64}$') AND
           ("warehouse_match_evidence_sha256" IS NULL OR "warehouse_match_evidence_sha256" ~ '^[0-9a-f]{64}$') AND
           "entry_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_warehouse_price_time_chk"
    CHECK (("transition" = 'legacy_observation' AND "effective_at" IS NULL) OR
           ("transition" <> 'legacy_observation' AND "effective_at" IS NOT NULL AND "effective_at" <= "recorded_at")),
  CONSTRAINT "accounting_warehouse_price_source_tuple_chk"
    CHECK (("transition" = 'legacy_observation' AND num_nonnulls("billing_document_id", "accounting_version_id", "lifecycle_event_id", "source_line_id") = 0) OR
           ("transition" <> 'legacy_observation' AND num_nonnulls("billing_document_id", "accounting_version_id", "lifecycle_event_id", "source_line_id") = 4)),
  CONSTRAINT "accounting_warehouse_price_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_warehouse_price_canonical_shape_chk"
    CHECK ("transition" = 'legacy_observation' OR ((("canonical_json")::jsonb - ARRAY['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity']) = '{}'::jsonb AND
           ("canonical_json")::jsonb ?& ARRAY['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity'] AND
           ((("canonical_json")::jsonb -> 'source') - ARRAY['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'source') ?& ARRAY['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId'] AND
           ((("canonical_json")::jsonb -> 'integrity') - ARRAY['canonicalization','hashAlgorithm','hashDomain','entrySha256']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'integrity') ?& ARRAY['canonicalization','hashAlgorithm','hashDomain','entrySha256'] AND
           (jsonb_typeof(("canonical_json")::jsonb -> 'warehouseMatch') = 'null' OR
            ((((("canonical_json")::jsonb -> 'warehouseMatch') - ARRAY['mode','evidenceSha256']) = '{}'::jsonb) AND
             (("canonical_json")::jsonb -> 'warehouseMatch') ?& ARRAY['mode','evidenceSha256'])))),
  CONSTRAINT "accounting_warehouse_price_legacy_canonical_shape_chk"
    CHECK ("transition" <> 'legacy_observation' OR (
           (("canonical_json")::jsonb - ARRAY['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity']) = '{}'::jsonb AND
           ("canonical_json")::jsonb ?& ARRAY['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity'] AND
           ((("canonical_json")::jsonb -> 'source') - ARRAY['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'source') ?& ARRAY['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow'] AND
           ((("canonical_json")::jsonb #> '{source,latestLegacyRow}') - ARRAY['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence']) = '{}'::jsonb AND
           (("canonical_json")::jsonb #> '{source,latestLegacyRow}') ?& ARRAY['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence'] AND
           ((("canonical_json")::jsonb -> 'valuationPolicy') - ARRAY['mode','fxConversionApplied']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'valuationPolicy') ?& ARRAY['mode','fxConversionApplied'] AND
           ((("canonical_json")::jsonb -> 'provenance') - ARRAY['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'provenance') ?& ARRAY['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId'] AND
           ((("canonical_json")::jsonb -> 'integrity') - ARRAY['canonicalization','hashAlgorithm','hashDomain','entrySha256']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'integrity') ?& ARRAY['canonicalization','hashAlgorithm','hashDomain','entrySha256'])),
  CONSTRAINT "accounting_warehouse_price_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') IS NOT DISTINCT FROM CASE WHEN "transition" = 'legacy_observation' THEN 'site-logbook.warehouse-price-legacy-observation/v1' ELSE 'site-logbook.warehouse-price-observation/v1' END AND
           (("canonical_json")::jsonb ->> 'observationId') IS NOT DISTINCT FROM "id"::text AND
           (("canonical_json")::jsonb ->> 'warehouseItemId') IS NOT DISTINCT FROM "warehouse_item_id"::text AND
           (("canonical_json")::jsonb ->> 'sequence') IS NOT DISTINCT FROM "sequence"::text AND
           (("canonical_json")::jsonb ->> 'previousObservationSha256') IS NOT DISTINCT FROM "previous_observation_sha256" AND
           (("canonical_json")::jsonb ->> 'supersedesObservationId') IS NOT DISTINCT FROM "supersedes_observation_id"::text AND
           (("canonical_json")::jsonb ->> 'transition') IS NOT DISTINCT FROM "transition" AND
           ("transition" = 'legacy_observation' OR ((("canonical_json")::jsonb #>> '{source,aggregateId}') IS NOT DISTINCT FROM "billing_document_id"::text AND
           (("canonical_json")::jsonb #>> '{source,accountingVersionId}') IS NOT DISTINCT FROM "accounting_version_id"::text AND
           (("canonical_json")::jsonb #>> '{source,lifecycleEventId}') IS NOT DISTINCT FROM "lifecycle_event_id"::text AND
           (("canonical_json")::jsonb #>> '{source,sourceLineId}') IS NOT DISTINCT FROM "source_line_id"::text)) AND
           (("canonical_json")::jsonb ->> 'purchasePrice') IS NOT DISTINCT FROM "purchase_price" AND
           (("canonical_json")::jsonb ->> 'currency') IS NOT DISTINCT FROM "currency" AND
           (("canonical_json")::jsonb #>> '{warehouseMatch,mode}') IS NOT DISTINCT FROM "warehouse_match_mode" AND
           (("canonical_json")::jsonb #>> '{warehouseMatch,evidenceSha256}') IS NOT DISTINCT FROM "warehouse_match_evidence_sha256" AND
           ("transition" = 'legacy_observation' OR ((("canonical_json")::jsonb ->> 'effectiveAt')::timestamptz) IS NOT DISTINCT FROM "effective_at") AND
           (CASE WHEN "transition" = 'legacy_observation' THEN ((("canonical_json")::jsonb #>> '{provenance,capturedAt}')::timestamptz) ELSE ((("canonical_json")::jsonb ->> 'recordedAt')::timestamptz) END) IS NOT DISTINCT FROM "recorded_at" AND
           (("canonical_json")::jsonb #>> '{integrity,canonicalization}') IS NOT DISTINCT FROM 'site-logbook-cjson/v1' AND
           (("canonical_json")::jsonb #>> '{integrity,hashAlgorithm}') IS NOT DISTINCT FROM 'sha256' AND
           (("canonical_json")::jsonb #>> '{integrity,hashDomain}') IS NOT DISTINCT FROM CASE WHEN "transition" = 'legacy_observation' THEN 'site-logbook.warehouse-price-legacy-observation/v1' ELSE 'site-logbook.warehouse-price-observation/v1' END AND
           (("canonical_json")::jsonb #>> '{integrity,entrySha256}') IS NOT DISTINCT FROM "entry_sha256"),
  CONSTRAINT "accounting_warehouse_price_legacy_semantics_chk"
    CHECK ("transition" <> 'legacy_observation' OR (
           (("canonical_json")::jsonb #>> '{valuationPolicy,mode}') = 'source-currency' AND
           (("canonical_json")::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb AND
           (("canonical_json")::jsonb #>> '{provenance,captureMode}') = 'legacy-observation' AND
           (("canonical_json")::jsonb #>> '{provenance,historicalCompleteness}') = 'unknown' AND
           (("canonical_json")::jsonb #> '{provenance,actorKnown}') = 'false'::jsonb AND
           (("canonical_json")::jsonb #> '{provenance,effectiveAtKnown}') = 'false'::jsonb AND
           (("canonical_json")::jsonb #> '{provenance,eventHistoryFabricated}') = 'false'::jsonb AND
           (("canonical_json")::jsonb #> '{provenance,accountingVersionId}') = 'null'::jsonb AND
           (("canonical_json")::jsonb #> '{provenance,lifecycleEventId}') = 'null'::jsonb AND
           (("canonical_json")::jsonb #>> '{source,parityReportSha256}') ~ '^[0-9a-f]{64}$' AND
           (("canonical_json")::jsonb #>> '{source,parityReportFileSha256}') ~ '^[0-9a-f]{64}$' AND
           (("canonical_json")::jsonb #>> '{source,legacyRowsSha256}') ~ '^[0-9a-f]{64}$' AND
           (("canonical_json")::jsonb #>> '{source,legacyRowCount}') ~ '^[1-9][0-9]{0,5}$' AND
           ((("canonical_json")::jsonb #>> '{source,legacyRowCount}')::integer) <= 500000 AND
           (("canonical_json")::jsonb #>> '{source,latestLegacyRow,legacyRowId}') ~ '^[1-9][0-9]*$' AND
           (("canonical_json")::jsonb #>> '{source,latestLegacyRow,rowSha256}') ~ '^[0-9a-f]{64}$' AND
           (("canonical_json")::jsonb #>> '{source,latestLegacyRow,purchasePrice}') = "purchase_price" AND
           (("canonical_json")::jsonb #>> '{source,latestLegacyRow,currency}') = "currency" AND
           (("canonical_json")::jsonb #>> '{source,latestLegacyRow,referenceConfidence}') = 'unverified-legacy-reference' AND
           ((("canonical_json")::jsonb #>> '{source,latestLegacyRow,sourceRecordedAt}')::timestamptz) <= "recorded_at" AND
           ((("canonical_json")::jsonb #> '{source,latestLegacyRow,observedBillingDocumentId}') = 'null'::jsonb OR (("canonical_json")::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentId}') ~ '^[1-9][0-9]*$') AND
           ((("canonical_json")::jsonb #> '{source,latestLegacyRow,observedBillingDocumentLineId}') = 'null'::jsonb OR (("canonical_json")::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentLineId}') ~ '^[1-9][0-9]*$')))
);

ALTER TABLE "accounting_warehouse_price_observations"
  ADD CONSTRAINT "accounting_warehouse_price_item_fk"
  FOREIGN KEY ("warehouse_item_id") REFERENCES "warehouse_items"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_observations"
  ADD CONSTRAINT "accounting_warehouse_price_document_fk"
  FOREIGN KEY ("billing_document_id") REFERENCES "billing_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_observations"
  ADD CONSTRAINT "accounting_warehouse_price_version_fk"
  FOREIGN KEY ("accounting_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_observations"
  ADD CONSTRAINT "accounting_warehouse_price_event_fk"
  FOREIGN KEY ("lifecycle_event_id") REFERENCES "accounting_lifecycle_events"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_observations"
  ADD CONSTRAINT "accounting_warehouse_price_supersedes_fk"
  FOREIGN KEY ("supersedes_observation_id") REFERENCES "accounting_warehouse_price_observations"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_warehouse_price_item_sequence_uq"
  ON "accounting_warehouse_price_observations" ("warehouse_item_id", "sequence");
CREATE UNIQUE INDEX "accounting_warehouse_price_source_event_line_uq"
  ON "accounting_warehouse_price_observations" ("lifecycle_event_id", "source_line_id")
  WHERE "transition" <> 'legacy_observation';
CREATE INDEX "accounting_warehouse_price_version_idx"
  ON "accounting_warehouse_price_observations" ("accounting_version_id");
CREATE INDEX "accounting_warehouse_price_document_line_idx"
  ON "accounting_warehouse_price_observations" ("billing_document_id", "source_line_id");

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
  CONSTRAINT "accounting_warehouse_price_projection_sequence_chk"
    CHECK ("stream_head_sequence" >= 0),
  CONSTRAINT "accounting_warehouse_price_projection_effective_tuple_chk"
    CHECK (num_nonnulls("effective_observation_id", "effective_observation_sha256", "purchase_price", "currency") IN (0, 4)),
  CONSTRAINT "accounting_warehouse_price_projection_price_chk"
    CHECK ("purchase_price" IS NULL OR "purchase_price" ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$'),
  CONSTRAINT "accounting_warehouse_price_projection_currency_chk"
    CHECK ("currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "accounting_warehouse_price_projection_hashes_chk"
    CHECK ("stream_head_observation_sha256" ~ '^[0-9a-f]{64}$' AND
           ("effective_observation_sha256" IS NULL OR "effective_observation_sha256" ~ '^[0-9a-f]{64}$') AND
           "projection_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_warehouse_price_projection_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_warehouse_price_projection_canonical_shape_chk"
    CHECK ((("canonical_json")::jsonb - ARRAY['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity']) = '{}'::jsonb AND
           ("canonical_json")::jsonb ?& ARRAY['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity'] AND
           ((("canonical_json")::jsonb -> 'streamHead') - ARRAY['observationId','observationSha256','sequence']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'streamHead') ?& ARRAY['observationId','observationSha256','sequence'] AND
           (jsonb_typeof(("canonical_json")::jsonb -> 'effectivePrice') = 'null' OR
            (((("canonical_json")::jsonb -> 'effectivePrice') - ARRAY['observationId','observationSha256','purchasePrice','currency']) = '{}'::jsonb AND
             (("canonical_json")::jsonb -> 'effectivePrice') ?& ARRAY['observationId','observationSha256','purchasePrice','currency'])) AND
           ((("canonical_json")::jsonb -> 'valuationPolicy') - ARRAY['mode','fxConversionApplied']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'valuationPolicy') ?& ARRAY['mode','fxConversionApplied'] AND
           ((("canonical_json")::jsonb -> 'integrity') - ARRAY['canonicalization','hashAlgorithm','hashDomain','projectionSha256']) = '{}'::jsonb AND
           (("canonical_json")::jsonb -> 'integrity') ?& ARRAY['canonicalization','hashAlgorithm','hashDomain','projectionSha256']),
  CONSTRAINT "accounting_warehouse_price_projection_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.warehouse-price-projection-head/v1' AND
           (("canonical_json")::jsonb ->> 'warehouseItemId') = "warehouse_item_id"::text AND
           (("canonical_json")::jsonb #>> '{streamHead,observationId}') = "stream_head_observation_id"::text AND
           (("canonical_json")::jsonb #>> '{streamHead,observationSha256}') = "stream_head_observation_sha256" AND
           (("canonical_json")::jsonb #>> '{streamHead,sequence}') = "stream_head_sequence"::text AND
           (("canonical_json")::jsonb #>> '{effectivePrice,observationId}') IS NOT DISTINCT FROM "effective_observation_id"::text AND
           (("canonical_json")::jsonb #>> '{effectivePrice,observationSha256}') IS NOT DISTINCT FROM "effective_observation_sha256" AND
           (("canonical_json")::jsonb #>> '{effectivePrice,purchasePrice}') IS NOT DISTINCT FROM "purchase_price" AND
           (("canonical_json")::jsonb #>> '{effectivePrice,currency}') IS NOT DISTINCT FROM "currency" AND
           (("canonical_json")::jsonb #>> '{valuationPolicy,mode}') = 'source-currency' AND
           (("canonical_json")::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb AND
           ((("canonical_json")::jsonb ->> 'projectedAt')::timestamptz) = "projected_at" AND
           (("canonical_json")::jsonb #>> '{integrity,canonicalization}') = 'site-logbook-cjson/v1' AND
           (("canonical_json")::jsonb #>> '{integrity,hashAlgorithm}') = 'sha256' AND
           (("canonical_json")::jsonb #>> '{integrity,hashDomain}') = 'site-logbook.warehouse-price-projection-head/v1' AND
           (("canonical_json")::jsonb #>> '{integrity,projectionSha256}') = "projection_sha256")
);

ALTER TABLE "accounting_warehouse_price_projection_heads"
  ADD CONSTRAINT "accounting_warehouse_price_projection_item_fk"
  FOREIGN KEY ("warehouse_item_id") REFERENCES "warehouse_items"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_projection_heads"
  ADD CONSTRAINT "accounting_warehouse_price_projection_stream_fk"
  FOREIGN KEY ("stream_head_observation_id") REFERENCES "accounting_warehouse_price_observations"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_warehouse_price_projection_heads"
  ADD CONSTRAINT "accounting_warehouse_price_projection_effective_fk"
  FOREIGN KEY ("effective_observation_id") REFERENCES "accounting_warehouse_price_observations"("id") ON DELETE RESTRICT;

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
  CONSTRAINT "accounting_payment_events_sequence_chk" CHECK ("sequence" >= 0),
  CONSTRAINT "accounting_payment_events_previous_chk"
    CHECK (("sequence" = 0 AND "previous_event_sha256" IS NULL) OR
           ("sequence" > 0 AND "previous_event_sha256" IS NOT NULL)),
  CONSTRAINT "accounting_payment_events_type_chk"
    CHECK ("event_type" IN ('received', 'corrected', 'refunded', 'reversed')),
  CONSTRAINT "accounting_payment_events_currency_chk"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "accounting_payment_events_occurred_on_chk"
    CHECK ("occurred_on" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  CONSTRAINT "accounting_payment_events_previous_hash_chk"
    CHECK ("previous_event_sha256" IS NULL OR "previous_event_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "accounting_payment_events_correction_self_chk"
    CHECK ("corrects_payment_event_id" IS NULL OR "corrects_payment_event_id" <> "id"),
  CONSTRAINT "accounting_payment_events_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_payment_events_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-payment-event/v1' AND
           (("canonical_json")::jsonb ->> 'paymentEventId') = "id"::text AND
           (("canonical_json")::jsonb ->> 'invoiceId') = "invoice_id"::text AND
           (("canonical_json")::jsonb ->> 'invoiceVersionId') = "invoice_version_id"::text AND
           (("canonical_json")::jsonb ->> 'sequence') = "sequence"::text AND
           (("canonical_json")::jsonb ->> 'previousEventSha256') IS NOT DISTINCT FROM "previous_event_sha256" AND
           (("canonical_json")::jsonb ->> 'eventType') = "event_type" AND
           (("canonical_json")::jsonb ->> 'amountDelta') = "amount_delta" AND
           (("canonical_json")::jsonb ->> 'currency') = "currency" AND
           (("canonical_json")::jsonb ->> 'occurredOn') = "occurred_on" AND
           (("canonical_json")::jsonb ->> 'correctsPaymentEventId') IS NOT DISTINCT FROM "corrects_payment_event_id"::text AND
           (("canonical_json")::jsonb #>> '{integrity,entrySha256}') = "entry_sha256"),
  CONSTRAINT "accounting_payment_events_entry_hash_chk"
    CHECK ("entry_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "accounting_payment_events"
  ADD CONSTRAINT "accounting_payment_events_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_payment_events"
  ADD CONSTRAINT "accounting_payment_events_version_fk"
  FOREIGN KEY ("invoice_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_payment_events"
  ADD CONSTRAINT "accounting_payment_events_corrects_fk"
  FOREIGN KEY ("corrects_payment_event_id") REFERENCES "accounting_payment_events"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_payment_events_invoice_sequence_uq"
  ON "accounting_payment_events" ("invoice_id", "sequence");
CREATE INDEX "accounting_payment_events_version_idx"
  ON "accounting_payment_events" ("invoice_version_id");
CREATE INDEX "accounting_payment_events_recorded_idx"
  ON "accounting_payment_events" ("recorded_at");

CREATE TABLE "accounting_version_relations" (
  "id" uuid PRIMARY KEY NOT NULL,
  "relation_type" text NOT NULL,
  "source_version_id" uuid NOT NULL,
  "target_version_id" uuid NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  "canonical_json" text NOT NULL,
  "entry_sha256" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "accounting_version_relations_type_chk"
    CHECK ("relation_type" IN ('supersedes', 'corrects', 'credits', 'voids')),
  CONSTRAINT "accounting_version_relations_distinct_chk"
    CHECK ("source_version_id" <> "target_version_id"),
  CONSTRAINT "accounting_version_relations_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_version_relations_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-version-relation/v1' AND
           (("canonical_json")::jsonb ->> 'relationId') = "id"::text AND
           (("canonical_json")::jsonb ->> 'relationType') = "relation_type" AND
           (("canonical_json")::jsonb #>> '{source,versionId}') = "source_version_id"::text AND
           (("canonical_json")::jsonb #>> '{target,versionId}') = "target_version_id"::text AND
           (("canonical_json")::jsonb #>> '{integrity,entrySha256}') = "entry_sha256"),
  CONSTRAINT "accounting_version_relations_entry_hash_chk"
    CHECK ("entry_sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "accounting_version_relations"
  ADD CONSTRAINT "accounting_version_relations_source_fk"
  FOREIGN KEY ("source_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_version_relations"
  ADD CONSTRAINT "accounting_version_relations_target_fk"
  FOREIGN KEY ("target_version_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_version_relations_exact_uq"
  ON "accounting_version_relations" ("relation_type", "source_version_id", "target_version_id");
CREATE INDEX "accounting_version_relations_source_idx"
  ON "accounting_version_relations" ("source_version_id");
CREATE INDEX "accounting_version_relations_target_idx"
  ON "accounting_version_relations" ("target_version_id");

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
  CONSTRAINT "accounting_export_outbox_operation_chk"
    CHECK ("operation" IN ('initial-version', 'legacy-observation', 'lifecycle-event', 'payment-event', 'correction-bundle', 'warehouse-price-observation', 'warehouse-price-legacy-observation', 'reason-artifact')),
  CONSTRAINT "accounting_export_outbox_state_chk"
    CHECK ("state" IN ('pending', 'exporting', 'exported', 'dead_letter')),
  CONSTRAINT "accounting_export_outbox_attempt_chk" CHECK ("attempt_count" >= 0),
  CONSTRAINT "accounting_export_outbox_lease_chk"
    CHECK (("state" = 'exporting' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL) OR
           ("state" <> 'exporting' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)),
  CONSTRAINT "accounting_export_outbox_terminal_chk"
    CHECK (("state" = 'exported' AND "exported_at" IS NOT NULL AND
            length(btrim("manifest_object_key")) > 0 AND length(btrim("manifest_version_id")) > 0 AND
            "manifest_sha256" ~ '^[0-9a-f]{64}$' AND "bundle_sha256" ~ '^[0-9a-f]{64}$' AND
            "checksum_sha256" ~ '^[0-9a-f]{64}$' AND "dead_lettered_at" IS NULL) OR
           ("state" = 'dead_letter' AND "dead_lettered_at" IS NOT NULL AND "exported_at" IS NULL AND
            num_nonnulls("manifest_object_key", "manifest_version_id", "manifest_sha256", "bundle_sha256", "checksum_sha256") = 0) OR
           ("state" IN ('pending', 'exporting') AND "exported_at" IS NULL AND "dead_lettered_at" IS NULL AND
            num_nonnulls("manifest_object_key", "manifest_version_id", "manifest_sha256", "bundle_sha256", "checksum_sha256") = 0)),
  CONSTRAINT "accounting_export_outbox_receipt_binding_chk"
    CHECK ("manifest_object_key" IS NULL OR
           ("manifest_object_key" = (CASE WHEN "operation" = 'reason-artifact' THEN 'accounting-evidence-restricted/v1/' ELSE 'accounting-evidence/v1/' END) || "intent_id"::text || '/' || "intent_sha256" || '/manifest.json' AND
            length("manifest_version_id") BETWEEN 1 AND 512 AND "manifest_version_id" !~ '[[:space:][:cntrl:]]')),
  CONSTRAINT "accounting_export_outbox_failure_category_chk"
    CHECK ("last_failure_category" IS NULL OR "last_failure_category" ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT "accounting_export_outbox_canonical_json_chk"
    CHECK (jsonb_typeof(("canonical_json")::jsonb) = 'object'),
  CONSTRAINT "accounting_export_outbox_canonical_binding_chk"
    CHECK ((("canonical_json")::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-export-intent/v1' AND
           (("canonical_json")::jsonb ->> 'intentId') = "intent_id"::text AND
           (("canonical_json")::jsonb ->> 'operation') = "operation" AND
           (("canonical_json")::jsonb ->> 'initialState') = 'pending' AND
           (("canonical_json")::jsonb #>> '{destination,namespace}') = CASE WHEN "operation" = 'reason-artifact' THEN 'accounting-evidence-restricted/v1' ELSE 'accounting-evidence/v1' END AND
           (("canonical_json")::jsonb #>> '{integrity,intentSha256}') = "intent_sha256"),
  CONSTRAINT "accounting_export_outbox_intent_hash_chk"
    CHECK ("intent_sha256" ~ '^[0-9a-f]{64}$')
);

CREATE INDEX "accounting_export_outbox_claim_idx"
  ON "accounting_export_outbox" ("state", "available_at", "lease_expires_at");

CREATE TABLE "accounting_aggregate_heads" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
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
  CONSTRAINT "accounting_aggregate_heads_root_chk"
    CHECK (num_nonnulls("invoice_id", "billing_document_id") = 1),
  CONSTRAINT "accounting_aggregate_heads_revision_chk" CHECK ("revision" >= 0),
  CONSTRAINT "accounting_aggregate_heads_version_tuple_chk"
    CHECK (num_nonnulls("version_head_version", "version_head_id", "version_head_sha256") IN (0, 3)),
  CONSTRAINT "accounting_aggregate_heads_lifecycle_tuple_chk"
    CHECK (num_nonnulls("lifecycle_head_sequence", "lifecycle_head_id", "lifecycle_head_sha256") IN (0, 3)),
  CONSTRAINT "accounting_aggregate_heads_payment_tuple_chk"
    CHECK (num_nonnulls("payment_head_sequence", "payment_head_id", "payment_head_sha256") IN (0, 3)),
  CONSTRAINT "accounting_aggregate_heads_dependency_chk"
    CHECK ("version_head_id" IS NOT NULL OR ("lifecycle_head_id" IS NULL AND "payment_head_id" IS NULL)),
  CONSTRAINT "accounting_aggregate_heads_cost_payment_chk"
    CHECK ("billing_document_id" IS NULL OR "payment_head_id" IS NULL),
  CONSTRAINT "accounting_aggregate_heads_hashes_chk"
    CHECK (("version_head_sha256" IS NULL OR "version_head_sha256" ~ '^[0-9a-f]{64}$') AND
           ("lifecycle_head_sha256" IS NULL OR "lifecycle_head_sha256" ~ '^[0-9a-f]{64}$') AND
           ("payment_head_sha256" IS NULL OR "payment_head_sha256" ~ '^[0-9a-f]{64}$'))
);

ALTER TABLE "accounting_aggregate_heads"
  ADD CONSTRAINT "accounting_aggregate_heads_invoice_fk"
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_aggregate_heads"
  ADD CONSTRAINT "accounting_aggregate_heads_cost_fk"
  FOREIGN KEY ("billing_document_id") REFERENCES "billing_documents"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_aggregate_heads"
  ADD CONSTRAINT "accounting_aggregate_heads_version_fk"
  FOREIGN KEY ("version_head_id") REFERENCES "accounting_document_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_aggregate_heads"
  ADD CONSTRAINT "accounting_aggregate_heads_lifecycle_fk"
  FOREIGN KEY ("lifecycle_head_id") REFERENCES "accounting_lifecycle_events"("id") ON DELETE RESTRICT;
ALTER TABLE "accounting_aggregate_heads"
  ADD CONSTRAINT "accounting_aggregate_heads_payment_fk"
  FOREIGN KEY ("payment_head_id") REFERENCES "accounting_payment_events"("id") ON DELETE RESTRICT;

CREATE UNIQUE INDEX "accounting_aggregate_heads_invoice_uq"
  ON "accounting_aggregate_heads" ("invoice_id") WHERE "invoice_id" IS NOT NULL;
CREATE UNIQUE INDEX "accounting_aggregate_heads_cost_uq"
  ON "accounting_aggregate_heads" ("billing_document_id") WHERE "billing_document_id" IS NOT NULL;

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

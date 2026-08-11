import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingDocumentsTable } from "./billing-documents";
import { invoicesTable } from "./invoices";
import { warehouseItemsTable } from "./warehouse-items";

const sha256Check = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;
const canonicalObjectCheck = (column: unknown) =>
  sql`jsonb_typeof((${column})::jsonb) = 'object'`;

export const accountingDocumentVersionsTable = pgTable(
  "accounting_document_versions",
  {
    id: uuid("id").primaryKey(),
    invoiceId: integer("invoice_id").references(() => invoicesTable.id, {
      onDelete: "restrict",
    }),
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "restrict" },
    ),
    version: bigint("version", { mode: "bigint" }).notNull(),
    purpose: text("purpose").notNull(),
    supersedesVersionId: uuid("supersedes_version_id"),
    historicalCompleteness: text("historical_completeness").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    artifactSetSha256: text("artifact_set_sha256").notNull(),
    versionSha256: text("version_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_document_versions_invoice_version_uq")
      .on(table.invoiceId, table.version)
      .where(sql`${table.invoiceId} is not null`),
    uniqueIndex("accounting_document_versions_cost_version_uq")
      .on(table.billingDocumentId, table.version)
      .where(sql`${table.billingDocumentId} is not null`),
    index("accounting_document_versions_recorded_idx").on(table.recordedAt),
    foreignKey({
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
      name: "accounting_document_versions_supersedes_fk",
    }).onDelete("restrict"),
    check(
      "accounting_document_versions_root_chk",
      sql`num_nonnulls(${table.invoiceId}, ${table.billingDocumentId}) = 1`,
    ),
    check(
      "accounting_document_versions_number_chk",
      sql`${table.version} >= 1`,
    ),
    check(
      "accounting_document_versions_purpose_chk",
      sql`${table.purpose} in ('issued', 'approved', 'correction', 'credit', 'cancellation_notice', 'discarded_observation', 'legacy_observation')`,
    ),
    check(
      "accounting_document_versions_completeness_chk",
      sql`${table.historicalCompleteness} in ('complete', 'unknown')`,
    ),
    check(
      "accounting_document_versions_supersedes_self_chk",
      sql`${table.supersedesVersionId} is null or ${table.supersedesVersionId} <> ${table.id}`,
    ),
    check(
      "accounting_document_versions_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_document_versions_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-document-version/v1'
        and (${table.canonicalJson}::jsonb ->> 'versionId') = ${table.id}::text
        and (${table.canonicalJson}::jsonb #>> '{aggregate,kind}') = case when ${table.invoiceId} is not null then 'outgoing-invoice' else 'incoming-cost-document' end
        and (${table.canonicalJson}::jsonb #>> '{aggregate,id}') = coalesce(${table.invoiceId}, ${table.billingDocumentId})::text
        and (${table.canonicalJson}::jsonb ->> 'version') = ${table.version}::text
        and (${table.canonicalJson}::jsonb ->> 'purpose') = ${table.purpose}
        and (${table.canonicalJson}::jsonb ->> 'historicalCompleteness') = ${table.historicalCompleteness}
        and (${table.canonicalJson}::jsonb ->> 'supersedesVersionId') is not distinct from ${table.supersedesVersionId}::text
        and (${table.canonicalJson}::jsonb #>> '{integrity,snapshotSha256}') = ${table.snapshotSha256}
        and (${table.canonicalJson}::jsonb #>> '{integrity,artifactSetSha256}') = ${table.artifactSetSha256}
        and (${table.canonicalJson}::jsonb #>> '{integrity,versionSha256}') = ${table.versionSha256}`,
    ),
    check(
      "accounting_document_versions_snapshot_hash_chk",
      sha256Check(table.snapshotSha256),
    ),
    check(
      "accounting_document_versions_artifact_hash_chk",
      sha256Check(table.artifactSetSha256),
    ),
    check(
      "accounting_document_versions_version_hash_chk",
      sha256Check(table.versionSha256),
    ),
  ],
);

export const accountingLifecycleEventsTable = pgTable(
  "accounting_lifecycle_events",
  {
    id: uuid("id").primaryKey(),
    invoiceId: integer("invoice_id").references(() => invoicesTable.id, {
      onDelete: "restrict",
    }),
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "restrict" },
    ),
    documentVersionId: uuid("document_version_id")
      .notNull()
      .references(() => accountingDocumentVersionsTable.id, {
        onDelete: "restrict",
      }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    previousEventSha256: text("previous_event_sha256"),
    eventType: text("event_type").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    entrySha256: text("entry_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_lifecycle_events_invoice_sequence_uq")
      .on(table.invoiceId, table.sequence)
      .where(sql`${table.invoiceId} is not null`),
    uniqueIndex("accounting_lifecycle_events_cost_sequence_uq")
      .on(table.billingDocumentId, table.sequence)
      .where(sql`${table.billingDocumentId} is not null`),
    index("accounting_lifecycle_events_version_idx").on(
      table.documentVersionId,
    ),
    index("accounting_lifecycle_events_recorded_idx").on(table.recordedAt),
    check(
      "accounting_lifecycle_events_root_chk",
      sql`num_nonnulls(${table.invoiceId}, ${table.billingDocumentId}) = 1`,
    ),
    check(
      "accounting_lifecycle_events_sequence_chk",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "accounting_lifecycle_events_previous_chk",
      sql`(${table.sequence} = 0 and ${table.previousEventSha256} is null) or (${table.sequence} > 0 and ${table.previousEventSha256} is not null)`,
    ),
    check(
      "accounting_lifecycle_events_type_chk",
      sql`${table.eventType} in ('issued', 'sent', 'cancellation_requested', 'void_confirmed', 'credit_linked', 'correction_linked', 'approved', 'review_reopened', 'ignored')`,
    ),
    check(
      "accounting_lifecycle_events_previous_hash_chk",
      sql`${table.previousEventSha256} is null or ${sha256Check(table.previousEventSha256)}`,
    ),
    check(
      "accounting_lifecycle_events_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_lifecycle_events_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-lifecycle-event/v1'
        and (${table.canonicalJson}::jsonb ->> 'eventId') = ${table.id}::text
        and (${table.canonicalJson}::jsonb #>> '{aggregate,kind}') = case when ${table.invoiceId} is not null then 'outgoing-invoice' else 'incoming-cost-document' end
        and (${table.canonicalJson}::jsonb #>> '{aggregate,id}') = coalesce(${table.invoiceId}, ${table.billingDocumentId})::text
        and (${table.canonicalJson}::jsonb #>> '{aggregate,versionId}') = ${table.documentVersionId}::text
        and (${table.canonicalJson}::jsonb ->> 'sequence') = ${table.sequence}::text
        and (${table.canonicalJson}::jsonb ->> 'previousEventSha256') is not distinct from ${table.previousEventSha256}
        and (${table.canonicalJson}::jsonb ->> 'eventType') = ${table.eventType}
        and (${table.canonicalJson}::jsonb #>> '{integrity,entrySha256}') = ${table.entrySha256}`,
    ),
    check(
      "accounting_lifecycle_events_entry_hash_chk",
      sha256Check(table.entrySha256),
    ),
  ],
);

export const accountingReasonArtifactsTable = pgTable(
  "accounting_reason_artifacts",
  {
    id: uuid("id").primaryKey(),
    billingDocumentId: integer("billing_document_id")
      .notNull()
      .references(() => billingDocumentsTable.id, { onDelete: "restrict" }),
    accountingVersionId: uuid("accounting_version_id")
      .notNull()
      .references(() => accountingDocumentVersionsTable.id, {
        onDelete: "restrict",
      }),
    lifecycleEventId: uuid("lifecycle_event_id")
      .notNull()
      .references(() => accountingLifecycleEventsTable.id, {
        onDelete: "restrict",
      }),
    lifecycleEventSha256: text("lifecycle_event_sha256").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonDetailSha256: text("reason_detail_sha256").notNull(),
    digestDomain: text("digest_domain").notNull(),
    reasonText: text("reason_text").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    artifactSha256: text("artifact_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_reason_artifacts_lifecycle_uq").on(
      table.lifecycleEventId,
    ),
    index("accounting_reason_artifacts_document_idx").on(
      table.billingDocumentId,
      table.recordedAt,
    ),
    check(
      "accounting_reason_artifacts_code_chk",
      sql`${table.reasonCode} in ('review_reopened', 'duplicate_document', 'invalid_document')`,
    ),
    check(
      "accounting_reason_artifacts_domain_chk",
      sql`${table.digestDomain} in ('site-logbook.cost-document-review-reopen-reason/v1', 'site-logbook.cost-document-reviewed-rejection-reason/v1')`,
    ),
    check(
      "accounting_reason_artifacts_text_chk",
      sql`char_length(${table.reasonText}) between 3 and 1000 and ${table.reasonText} = btrim(${table.reasonText}) and ${table.reasonText} !~ '[[:cntrl:]]'`,
    ),
    check(
      "accounting_reason_artifacts_hashes_chk",
      sql`${sha256Check(table.lifecycleEventSha256)} and ${sha256Check(table.reasonDetailSha256)} and ${sha256Check(table.artifactSha256)}`,
    ),
    check(
      "accounting_reason_artifacts_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_reason_artifacts_canonical_shape_chk",
      sql`(${table.canonicalJson}::jsonb - array['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity']) = '{}'::jsonb
        and ${table.canonicalJson}::jsonb ?& array['schemaVersion','artifactId','aggregate','lifecycleEvent','reason','retention','accessPolicy','recordedAt','integrity']
        and ((${table.canonicalJson}::jsonb -> 'aggregate') - array['kind','id','versionId']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'aggregate') ?& array['kind','id','versionId']
        and ((${table.canonicalJson}::jsonb -> 'lifecycleEvent') - array['eventId','eventSha256']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'lifecycleEvent') ?& array['eventId','eventSha256']
        and ((${table.canonicalJson}::jsonb -> 'reason') - array['code','text','textSha256','digestDomain']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'reason') ?& array['code','text','textSha256','digestDomain']
        and ((${table.canonicalJson}::jsonb -> 'retention') - array['class','legalHoldAware','selectivePlaintextRewriteSupported']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'retention') ?& array['class','legalHoldAware','selectivePlaintextRewriteSupported']
        and ((${table.canonicalJson}::jsonb -> 'accessPolicy') - array['mode','listing','plaintextExport']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'accessPolicy') ?& array['mode','listing','plaintextExport']
        and ((${table.canonicalJson}::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','artifactSha256']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','artifactSha256']`,
    ),
    check(
      "accounting_reason_artifacts_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-reason-artifact/v1'
        and (${table.canonicalJson}::jsonb ->> 'artifactId') = ${table.id}::text
        and (${table.canonicalJson}::jsonb #>> '{aggregate,kind}') = 'incoming-cost-document'
        and (${table.canonicalJson}::jsonb #>> '{aggregate,id}') = ${table.billingDocumentId}::text
        and (${table.canonicalJson}::jsonb #>> '{aggregate,versionId}') = ${table.accountingVersionId}::text
        and (${table.canonicalJson}::jsonb #>> '{lifecycleEvent,eventId}') = ${table.lifecycleEventId}::text
        and (${table.canonicalJson}::jsonb #>> '{lifecycleEvent,eventSha256}') = ${table.lifecycleEventSha256}
        and (${table.canonicalJson}::jsonb #>> '{reason,code}') = ${table.reasonCode}
        and (${table.canonicalJson}::jsonb #>> '{reason,text}') = ${table.reasonText}
        and (${table.canonicalJson}::jsonb #>> '{reason,textSha256}') = ${table.reasonDetailSha256}
        and (${table.canonicalJson}::jsonb #>> '{reason,digestDomain}') = ${table.digestDomain}
        and (${table.canonicalJson}::jsonb #>> '{retention,class}') = 'restricted-accounting-evidence'
        and (${table.canonicalJson}::jsonb #>> '{retention,legalHoldAware}') = 'true'
        and (${table.canonicalJson}::jsonb #>> '{retention,selectivePlaintextRewriteSupported}') = 'false'
        and (${table.canonicalJson}::jsonb #>> '{accessPolicy,mode}') = 'restricted'
        and (${table.canonicalJson}::jsonb #>> '{accessPolicy,listing}') = 'metadata-only'
        and (${table.canonicalJson}::jsonb #>> '{accessPolicy,plaintextExport}') = 'authorized-audit-only'
        and ((${table.canonicalJson}::jsonb ->> 'recordedAt')::timestamptz) = ${table.recordedAt}
        and (${table.canonicalJson}::jsonb #>> '{integrity,canonicalization}') = 'site-logbook-cjson/v1'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashAlgorithm}') = 'sha256'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashDomain}') = 'site-logbook.accounting-reason-artifact/v1'
        and (${table.canonicalJson}::jsonb #>> '{integrity,artifactSha256}') = ${table.artifactSha256}`,
    ),
  ],
);

export const accountingWarehousePriceObservationsTable = pgTable(
  "accounting_warehouse_price_observations",
  {
    id: uuid("id").primaryKey(),
    warehouseItemId: integer("warehouse_item_id")
      .notNull()
      .references(() => warehouseItemsTable.id, { onDelete: "restrict" }),
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "restrict" },
    ),
    accountingVersionId: uuid("accounting_version_id").references(
      () => accountingDocumentVersionsTable.id,
      {
        onDelete: "restrict",
      },
    ),
    lifecycleEventId: uuid("lifecycle_event_id").references(
      () => accountingLifecycleEventsTable.id,
      {
        onDelete: "restrict",
      },
    ),
    sourceLineId: integer("source_line_id"),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    previousObservationSha256: text("previous_observation_sha256"),
    supersedesObservationId: uuid("supersedes_observation_id"),
    transition: text("transition").notNull(),
    purchasePrice: text("purchase_price"),
    currency: text("currency").notNull(),
    warehouseMatchMode: text("warehouse_match_mode"),
    warehouseMatchEvidenceSha256: text("warehouse_match_evidence_sha256"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    entrySha256: text("entry_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_warehouse_price_item_sequence_uq").on(
      table.warehouseItemId,
      table.sequence,
    ),
    uniqueIndex("accounting_warehouse_price_source_event_line_uq")
      .on(table.lifecycleEventId, table.sourceLineId)
      .where(sql`${table.transition} <> 'legacy_observation'`),
    index("accounting_warehouse_price_version_idx").on(
      table.accountingVersionId,
    ),
    index("accounting_warehouse_price_document_line_idx").on(
      table.billingDocumentId,
      table.sourceLineId,
    ),
    foreignKey({
      columns: [table.supersedesObservationId],
      foreignColumns: [table.id],
      name: "accounting_warehouse_price_supersedes_fk",
    }).onDelete("restrict"),
    check(
      "accounting_warehouse_price_sequence_chk",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "accounting_warehouse_price_previous_chk",
      sql`(${table.sequence} = 0 and ${table.previousObservationSha256} is null and ${table.supersedesObservationId} is null) or (${table.sequence} > 0 and ${table.previousObservationSha256} is not null and ${table.supersedesObservationId} is not null)`,
    ),
    check(
      "accounting_warehouse_price_transition_chk",
      sql`${table.transition} in ('legacy_observation', 'observed', 'corrected', 'withdrawn')`,
    ),
    check(
      "accounting_warehouse_price_amount_chk",
      sql`(${table.transition} = 'withdrawn' and ${table.purchasePrice} is null) or (${table.transition} <> 'withdrawn' and ${table.purchasePrice} ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$')`,
    ),
    check(
      "accounting_warehouse_price_currency_chk",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "accounting_warehouse_price_match_tuple_chk",
      sql`(${table.transition} in ('withdrawn', 'legacy_observation') and num_nonnulls(${table.warehouseMatchMode}, ${table.warehouseMatchEvidenceSha256}) = 0) or (${table.transition} in ('observed', 'corrected') and num_nonnulls(${table.warehouseMatchMode}, ${table.warehouseMatchEvidenceSha256}) = 2)`,
    ),
    check(
      "accounting_warehouse_price_match_mode_chk",
      sql`${table.warehouseMatchMode} is null or ${table.warehouseMatchMode} in ('code', 'name', 'created', 'manual')`,
    ),
    check(
      "accounting_warehouse_price_hashes_chk",
      sql`(${table.previousObservationSha256} is null or ${sha256Check(table.previousObservationSha256)}) and (${table.warehouseMatchEvidenceSha256} is null or ${sha256Check(table.warehouseMatchEvidenceSha256)}) and ${sha256Check(table.entrySha256)}`,
    ),
    check(
      "accounting_warehouse_price_time_chk",
      sql`(${table.transition} = 'legacy_observation' and ${table.effectiveAt} is null) or (${table.transition} <> 'legacy_observation' and ${table.effectiveAt} is not null and ${table.effectiveAt} <= ${table.recordedAt})`,
    ),
    check(
      "accounting_warehouse_price_source_tuple_chk",
      sql`(${table.transition} = 'legacy_observation' and num_nonnulls(${table.billingDocumentId}, ${table.accountingVersionId}, ${table.lifecycleEventId}, ${table.sourceLineId}) = 0) or (${table.transition} <> 'legacy_observation' and num_nonnulls(${table.billingDocumentId}, ${table.accountingVersionId}, ${table.lifecycleEventId}, ${table.sourceLineId}) = 4)`,
    ),
    check(
      "accounting_warehouse_price_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_warehouse_price_canonical_shape_chk",
      sql`(
        (${table.transition} <> 'legacy_observation'
          and (${table.canonicalJson}::jsonb - array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity']) = '{}'::jsonb
          and ${table.canonicalJson}::jsonb ?& array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','warehouseMatch','actor','reasonCode','reasonDetailSha256','effectiveAt','recordedAt','integrity']
          and ((${table.canonicalJson}::jsonb -> 'source') - array['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId']) = '{}'::jsonb
          and (${table.canonicalJson}::jsonb -> 'source') ?& array['aggregateId','accountingVersionId','accountingVersionSha256','lifecycleEventId','lifecycleEventSha256','sourceLineId']
          and (jsonb_typeof(${table.canonicalJson}::jsonb -> 'warehouseMatch') = 'null' or (((${table.canonicalJson}::jsonb -> 'warehouseMatch') - array['mode','evidenceSha256']) = '{}'::jsonb and (${table.canonicalJson}::jsonb -> 'warehouseMatch') ?& array['mode','evidenceSha256'])))
        or
        (${table.transition} = 'legacy_observation'
          and (${table.canonicalJson}::jsonb - array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity']) = '{}'::jsonb
          and ${table.canonicalJson}::jsonb ?& array['schemaVersion','observationId','warehouseItemId','sequence','previousObservationSha256','supersedesObservationId','transition','source','purchasePrice','currency','valuationPolicy','provenance','integrity']
          and ((${table.canonicalJson}::jsonb -> 'source') - array['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow']) = '{}'::jsonb
          and (${table.canonicalJson}::jsonb -> 'source') ?& array['parityReportSha256','parityReportFileSha256','legacyRowsSha256','legacyRowCount','latestLegacyRow']
          and ((${table.canonicalJson}::jsonb #> '{source,latestLegacyRow}') - array['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence']) = '{}'::jsonb
          and (${table.canonicalJson}::jsonb #> '{source,latestLegacyRow}') ?& array['legacyRowId','rowSha256','observedBillingDocumentId','observedBillingDocumentLineId','purchasePrice','currency','sourceRecordedAt','referenceConfidence']
          and ((${table.canonicalJson}::jsonb -> 'valuationPolicy') - array['mode','fxConversionApplied']) = '{}'::jsonb
          and (${table.canonicalJson}::jsonb -> 'valuationPolicy') ?& array['mode','fxConversionApplied']
          and ((${table.canonicalJson}::jsonb -> 'provenance') - array['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId']) = '{}'::jsonb
          and (${table.canonicalJson}::jsonb -> 'provenance') ?& array['captureMode','capturedAt','historicalCompleteness','actorKnown','effectiveAtKnown','eventHistoryFabricated','accountingVersionId','lifecycleEventId'])
        )
        and ((${table.canonicalJson}::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','entrySha256']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','entrySha256']`,
    ),
    check(
      "accounting_warehouse_price_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') is not distinct from case when ${table.transition} = 'legacy_observation' then 'site-logbook.warehouse-price-legacy-observation/v1' else 'site-logbook.warehouse-price-observation/v1' end
        and (${table.canonicalJson}::jsonb ->> 'observationId') is not distinct from ${table.id}::text
        and (${table.canonicalJson}::jsonb ->> 'warehouseItemId') is not distinct from ${table.warehouseItemId}::text
        and (${table.canonicalJson}::jsonb ->> 'sequence') is not distinct from ${table.sequence}::text
        and (${table.canonicalJson}::jsonb ->> 'previousObservationSha256') is not distinct from ${table.previousObservationSha256}
        and (${table.canonicalJson}::jsonb ->> 'supersedesObservationId') is not distinct from ${table.supersedesObservationId}::text
        and (${table.canonicalJson}::jsonb ->> 'transition') is not distinct from ${table.transition}
        and (${table.transition} = 'legacy_observation' or ((${table.canonicalJson}::jsonb #>> '{source,aggregateId}') is not distinct from ${table.billingDocumentId}::text
          and (${table.canonicalJson}::jsonb #>> '{source,accountingVersionId}') is not distinct from ${table.accountingVersionId}::text
          and (${table.canonicalJson}::jsonb #>> '{source,lifecycleEventId}') is not distinct from ${table.lifecycleEventId}::text
          and (${table.canonicalJson}::jsonb #>> '{source,sourceLineId}') is not distinct from ${table.sourceLineId}::text))
        and (${table.canonicalJson}::jsonb ->> 'purchasePrice') is not distinct from ${table.purchasePrice}
        and (${table.canonicalJson}::jsonb ->> 'currency') is not distinct from ${table.currency}
        and (${table.canonicalJson}::jsonb #>> '{warehouseMatch,mode}') is not distinct from ${table.warehouseMatchMode}
        and (${table.canonicalJson}::jsonb #>> '{warehouseMatch,evidenceSha256}') is not distinct from ${table.warehouseMatchEvidenceSha256}
        and (case when ${table.transition} = 'legacy_observation' then ((${table.canonicalJson}::jsonb #>> '{provenance,capturedAt}')::timestamptz) else ((${table.canonicalJson}::jsonb ->> 'recordedAt')::timestamptz) end) is not distinct from ${table.recordedAt}
        and (${table.transition} = 'legacy_observation' or ((${table.canonicalJson}::jsonb ->> 'effectiveAt')::timestamptz) is not distinct from ${table.effectiveAt})
        and (${table.canonicalJson}::jsonb #>> '{integrity,canonicalization}') is not distinct from 'site-logbook-cjson/v1'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashAlgorithm}') is not distinct from 'sha256'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashDomain}') is not distinct from case when ${table.transition} = 'legacy_observation' then 'site-logbook.warehouse-price-legacy-observation/v1' else 'site-logbook.warehouse-price-observation/v1' end
        and (${table.canonicalJson}::jsonb #>> '{integrity,entrySha256}') is not distinct from ${table.entrySha256}`,
    ),
    check(
      "accounting_warehouse_price_legacy_semantics_chk",
      sql`${table.transition} <> 'legacy_observation' or (
        (${table.canonicalJson}::jsonb #>> '{valuationPolicy,mode}') = 'source-currency'
        and (${table.canonicalJson}::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb
        and (${table.canonicalJson}::jsonb #>> '{provenance,captureMode}') = 'legacy-observation'
        and (${table.canonicalJson}::jsonb #>> '{provenance,historicalCompleteness}') = 'unknown'
        and (${table.canonicalJson}::jsonb #> '{provenance,actorKnown}') = 'false'::jsonb
        and (${table.canonicalJson}::jsonb #> '{provenance,effectiveAtKnown}') = 'false'::jsonb
        and (${table.canonicalJson}::jsonb #> '{provenance,eventHistoryFabricated}') = 'false'::jsonb
        and (${table.canonicalJson}::jsonb #> '{provenance,accountingVersionId}') = 'null'::jsonb
        and (${table.canonicalJson}::jsonb #> '{provenance,lifecycleEventId}') = 'null'::jsonb
        and (${table.canonicalJson}::jsonb #>> '{source,parityReportSha256}') ~ '^[0-9a-f]{64}$'
        and (${table.canonicalJson}::jsonb #>> '{source,parityReportFileSha256}') ~ '^[0-9a-f]{64}$'
        and (${table.canonicalJson}::jsonb #>> '{source,legacyRowsSha256}') ~ '^[0-9a-f]{64}$'
        and (${table.canonicalJson}::jsonb #>> '{source,legacyRowCount}') ~ '^[1-9][0-9]{0,5}$'
        and ((${table.canonicalJson}::jsonb #>> '{source,legacyRowCount}')::integer) <= 500000
        and (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,legacyRowId}') ~ '^[1-9][0-9]*$'
        and (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,rowSha256}') ~ '^[0-9a-f]{64}$'
        and (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,purchasePrice}') = ${table.purchasePrice}
        and (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,currency}') = ${table.currency}
        and (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,referenceConfidence}') = 'unverified-legacy-reference'
        and ((${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,sourceRecordedAt}')::timestamptz) <= ${table.recordedAt}
        and ((${table.canonicalJson}::jsonb #> '{source,latestLegacyRow,observedBillingDocumentId}') = 'null'::jsonb or (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentId}') ~ '^[1-9][0-9]*$')
        and ((${table.canonicalJson}::jsonb #> '{source,latestLegacyRow,observedBillingDocumentLineId}') = 'null'::jsonb or (${table.canonicalJson}::jsonb #>> '{source,latestLegacyRow,observedBillingDocumentLineId}') ~ '^[1-9][0-9]*$')
      )`,
    ),
  ],
);

/**
 * Mutable, fully-derived shadow projection of the immutable warehouse-price
 * observation stream. It deliberately does not overwrite the legacy
 * warehouse_items.purchase_price column. The explicit currency and the
 * source-currency/no-FX policy must travel with every non-null price.
 */
export const accountingWarehousePriceProjectionHeadsTable = pgTable(
  "accounting_warehouse_price_projection_heads",
  {
    warehouseItemId: integer("warehouse_item_id")
      .primaryKey()
      .references(() => warehouseItemsTable.id, { onDelete: "restrict" }),
    streamHeadObservationId: uuid("stream_head_observation_id")
      .notNull()
      .references(() => accountingWarehousePriceObservationsTable.id, {
        onDelete: "restrict",
      }),
    streamHeadObservationSha256: text(
      "stream_head_observation_sha256",
    ).notNull(),
    streamHeadSequence: bigint("stream_head_sequence", {
      mode: "bigint",
    }).notNull(),
    effectiveObservationId: uuid("effective_observation_id").references(
      () => accountingWarehousePriceObservationsTable.id,
      { onDelete: "restrict" },
    ),
    effectiveObservationSha256: text("effective_observation_sha256"),
    purchasePrice: text("purchase_price"),
    currency: text("currency"),
    projectedAt: timestamp("projected_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    projectionSha256: text("projection_sha256").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "accounting_warehouse_price_projection_sequence_chk",
      sql`${table.streamHeadSequence} >= 0`,
    ),
    check(
      "accounting_warehouse_price_projection_effective_tuple_chk",
      sql`num_nonnulls(${table.effectiveObservationId}, ${table.effectiveObservationSha256}, ${table.purchasePrice}, ${table.currency}) in (0, 4)`,
    ),
    check(
      "accounting_warehouse_price_projection_price_chk",
      sql`${table.purchasePrice} is null or ${table.purchasePrice} ~ '^(0|[1-9][0-9]*)([.][0-9]{0,3}[1-9])?$'`,
    ),
    check(
      "accounting_warehouse_price_projection_currency_chk",
      sql`${table.currency} is null or ${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "accounting_warehouse_price_projection_hashes_chk",
      sql`${sha256Check(table.streamHeadObservationSha256)} and (${table.effectiveObservationSha256} is null or ${sha256Check(table.effectiveObservationSha256)}) and ${sha256Check(table.projectionSha256)}`,
    ),
    check(
      "accounting_warehouse_price_projection_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_warehouse_price_projection_canonical_shape_chk",
      sql`(${table.canonicalJson}::jsonb - array['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity']) = '{}'::jsonb
        and ${table.canonicalJson}::jsonb ?& array['schemaVersion','warehouseItemId','streamHead','effectivePrice','valuationPolicy','projectedAt','integrity']
        and ((${table.canonicalJson}::jsonb -> 'streamHead') - array['observationId','observationSha256','sequence']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'streamHead') ?& array['observationId','observationSha256','sequence']
        and (jsonb_typeof(${table.canonicalJson}::jsonb -> 'effectivePrice') = 'null' or (((${table.canonicalJson}::jsonb -> 'effectivePrice') - array['observationId','observationSha256','purchasePrice','currency']) = '{}'::jsonb and (${table.canonicalJson}::jsonb -> 'effectivePrice') ?& array['observationId','observationSha256','purchasePrice','currency']))
        and ((${table.canonicalJson}::jsonb -> 'valuationPolicy') - array['mode','fxConversionApplied']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'valuationPolicy') ?& array['mode','fxConversionApplied']
        and ((${table.canonicalJson}::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','projectionSha256']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','projectionSha256']`,
    ),
    check(
      "accounting_warehouse_price_projection_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.warehouse-price-projection-head/v1'
        and (${table.canonicalJson}::jsonb ->> 'warehouseItemId') = ${table.warehouseItemId}::text
        and (${table.canonicalJson}::jsonb #>> '{streamHead,observationId}') = ${table.streamHeadObservationId}::text
        and (${table.canonicalJson}::jsonb #>> '{streamHead,observationSha256}') = ${table.streamHeadObservationSha256}
        and (${table.canonicalJson}::jsonb #>> '{streamHead,sequence}') = ${table.streamHeadSequence}::text
        and (${table.canonicalJson}::jsonb #>> '{effectivePrice,observationId}') is not distinct from ${table.effectiveObservationId}::text
        and (${table.canonicalJson}::jsonb #>> '{effectivePrice,observationSha256}') is not distinct from ${table.effectiveObservationSha256}
        and (${table.canonicalJson}::jsonb #>> '{effectivePrice,purchasePrice}') is not distinct from ${table.purchasePrice}
        and (${table.canonicalJson}::jsonb #>> '{effectivePrice,currency}') is not distinct from ${table.currency}
        and (${table.canonicalJson}::jsonb #>> '{valuationPolicy,mode}') = 'source-currency'
        and (${table.canonicalJson}::jsonb #> '{valuationPolicy,fxConversionApplied}') = 'false'::jsonb
        and ((${table.canonicalJson}::jsonb ->> 'projectedAt')::timestamptz) = ${table.projectedAt}
        and (${table.canonicalJson}::jsonb #>> '{integrity,canonicalization}') = 'site-logbook-cjson/v1'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashAlgorithm}') = 'sha256'
        and (${table.canonicalJson}::jsonb #>> '{integrity,hashDomain}') = 'site-logbook.warehouse-price-projection-head/v1'
        and (${table.canonicalJson}::jsonb #>> '{integrity,projectionSha256}') = ${table.projectionSha256}`,
    ),
  ],
);

export const accountingPaymentEventsTable = pgTable(
  "accounting_payment_events",
  {
    id: uuid("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "restrict" }),
    invoiceVersionId: uuid("invoice_version_id")
      .notNull()
      .references(() => accountingDocumentVersionsTable.id, {
        onDelete: "restrict",
      }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    previousEventSha256: text("previous_event_sha256"),
    eventType: text("event_type").notNull(),
    amountDelta: text("amount_delta").notNull(),
    currency: text("currency").notNull(),
    occurredOn: text("occurred_on").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    correctsPaymentEventId: uuid("corrects_payment_event_id"),
    canonicalJson: text("canonical_json").notNull(),
    entrySha256: text("entry_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_payment_events_invoice_sequence_uq").on(
      table.invoiceId,
      table.sequence,
    ),
    index("accounting_payment_events_version_idx").on(table.invoiceVersionId),
    index("accounting_payment_events_recorded_idx").on(table.recordedAt),
    foreignKey({
      columns: [table.correctsPaymentEventId],
      foreignColumns: [table.id],
      name: "accounting_payment_events_corrects_fk",
    }).onDelete("restrict"),
    check(
      "accounting_payment_events_sequence_chk",
      sql`${table.sequence} >= 0`,
    ),
    check(
      "accounting_payment_events_previous_chk",
      sql`(${table.sequence} = 0 and ${table.previousEventSha256} is null) or (${table.sequence} > 0 and ${table.previousEventSha256} is not null)`,
    ),
    check(
      "accounting_payment_events_type_chk",
      sql`${table.eventType} in ('received', 'corrected', 'refunded', 'reversed')`,
    ),
    check(
      "accounting_payment_events_currency_chk",
      sql`${table.currency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      "accounting_payment_events_occurred_on_chk",
      sql`${table.occurredOn} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`,
    ),
    check(
      "accounting_payment_events_previous_hash_chk",
      sql`${table.previousEventSha256} is null or ${sha256Check(table.previousEventSha256)}`,
    ),
    check(
      "accounting_payment_events_correction_self_chk",
      sql`${table.correctsPaymentEventId} is null or ${table.correctsPaymentEventId} <> ${table.id}`,
    ),
    check(
      "accounting_payment_events_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_payment_events_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-payment-event/v1'
        and (${table.canonicalJson}::jsonb ->> 'paymentEventId') = ${table.id}::text
        and (${table.canonicalJson}::jsonb ->> 'invoiceId') = ${table.invoiceId}::text
        and (${table.canonicalJson}::jsonb ->> 'invoiceVersionId') = ${table.invoiceVersionId}::text
        and (${table.canonicalJson}::jsonb ->> 'sequence') = ${table.sequence}::text
        and (${table.canonicalJson}::jsonb ->> 'previousEventSha256') is not distinct from ${table.previousEventSha256}
        and (${table.canonicalJson}::jsonb ->> 'eventType') = ${table.eventType}
        and (${table.canonicalJson}::jsonb ->> 'amountDelta') = ${table.amountDelta}
        and (${table.canonicalJson}::jsonb ->> 'currency') = ${table.currency}
        and (${table.canonicalJson}::jsonb ->> 'occurredOn') = ${table.occurredOn}
        and (${table.canonicalJson}::jsonb ->> 'correctsPaymentEventId') is not distinct from ${table.correctsPaymentEventId}::text
        and (${table.canonicalJson}::jsonb #>> '{integrity,entrySha256}') = ${table.entrySha256}`,
    ),
    check(
      "accounting_payment_events_entry_hash_chk",
      sha256Check(table.entrySha256),
    ),
  ],
);

export const accountingVersionRelationsTable = pgTable(
  "accounting_version_relations",
  {
    id: uuid("id").primaryKey(),
    relationType: text("relation_type").notNull(),
    sourceVersionId: uuid("source_version_id")
      .notNull()
      .references(() => accountingDocumentVersionsTable.id, {
        onDelete: "restrict",
      }),
    targetVersionId: uuid("target_version_id")
      .notNull()
      .references(() => accountingDocumentVersionsTable.id, {
        onDelete: "restrict",
      }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    entrySha256: text("entry_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_version_relations_exact_uq").on(
      table.relationType,
      table.sourceVersionId,
      table.targetVersionId,
    ),
    index("accounting_version_relations_source_idx").on(table.sourceVersionId),
    index("accounting_version_relations_target_idx").on(table.targetVersionId),
    check(
      "accounting_version_relations_type_chk",
      sql`${table.relationType} in ('supersedes', 'corrects', 'credits', 'voids')`,
    ),
    check(
      "accounting_version_relations_distinct_chk",
      sql`${table.sourceVersionId} <> ${table.targetVersionId}`,
    ),
    check(
      "accounting_version_relations_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_version_relations_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-version-relation/v1'
        and (${table.canonicalJson}::jsonb ->> 'relationId') = ${table.id}::text
        and (${table.canonicalJson}::jsonb ->> 'relationType') = ${table.relationType}
        and (${table.canonicalJson}::jsonb #>> '{source,versionId}') = ${table.sourceVersionId}::text
        and (${table.canonicalJson}::jsonb #>> '{target,versionId}') = ${table.targetVersionId}::text
        and (${table.canonicalJson}::jsonb #>> '{integrity,entrySha256}') = ${table.entrySha256}`,
    ),
    check(
      "accounting_version_relations_entry_hash_chk",
      sha256Check(table.entrySha256),
    ),
  ],
);

export const accountingExportOutboxTable = pgTable(
  "accounting_export_outbox",
  {
    intentId: uuid("intent_id").primaryKey(),
    operation: text("operation").notNull(),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    manifestObjectKey: text("manifest_object_key"),
    manifestVersionId: text("manifest_version_id"),
    manifestSha256: text("manifest_sha256"),
    bundleSha256: text("bundle_sha256"),
    checksumSha256: text("checksum_sha256"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    lastFailureCategory: text("last_failure_category"),
    canonicalJson: text("canonical_json").notNull(),
    intentSha256: text("intent_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("accounting_export_outbox_claim_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    check(
      "accounting_export_outbox_operation_chk",
      sql`${table.operation} in ('initial-version', 'legacy-observation', 'lifecycle-event', 'payment-event', 'correction-bundle', 'warehouse-price-observation', 'warehouse-price-legacy-observation', 'reason-artifact')`,
    ),
    check(
      "accounting_export_outbox_state_chk",
      sql`${table.state} in ('pending', 'exporting', 'exported', 'dead_letter')`,
    ),
    check(
      "accounting_export_outbox_attempt_chk",
      sql`${table.attemptCount} >= 0`,
    ),
    check(
      "accounting_export_outbox_lease_chk",
      sql`(${table.state} = 'exporting' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'exporting' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "accounting_export_outbox_terminal_chk",
      sql`(${table.state} = 'exported' and ${table.exportedAt} is not null and length(btrim(${table.manifestObjectKey})) > 0 and length(btrim(${table.manifestVersionId})) > 0 and ${table.manifestSha256} ~ '^[0-9a-f]{64}$' and ${table.bundleSha256} ~ '^[0-9a-f]{64}$' and ${table.checksumSha256} ~ '^[0-9a-f]{64}$' and ${table.deadLetteredAt} is null) or (${table.state} = 'dead_letter' and ${table.deadLetteredAt} is not null and ${table.exportedAt} is null and num_nonnulls(${table.manifestObjectKey}, ${table.manifestVersionId}, ${table.manifestSha256}, ${table.bundleSha256}, ${table.checksumSha256}) = 0) or (${table.state} in ('pending', 'exporting') and ${table.exportedAt} is null and ${table.deadLetteredAt} is null and num_nonnulls(${table.manifestObjectKey}, ${table.manifestVersionId}, ${table.manifestSha256}, ${table.bundleSha256}, ${table.checksumSha256}) = 0)`,
    ),
    check(
      "accounting_export_outbox_receipt_binding_chk",
      sql`${table.manifestObjectKey} is null or (${table.manifestObjectKey} = (case when ${table.operation} = 'reason-artifact' then 'accounting-evidence-restricted/v1/' else 'accounting-evidence/v1/' end) || ${table.intentId}::text || '/' || ${table.intentSha256} || '/manifest.json' and length(${table.manifestVersionId}) between 1 and 512 and ${table.manifestVersionId} !~ '[[:space:][:cntrl:]]')`,
    ),
    check(
      "accounting_export_outbox_failure_category_chk",
      sql`${table.lastFailureCategory} is null or ${table.lastFailureCategory} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      "accounting_export_outbox_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "accounting_export_outbox_canonical_binding_chk",
      sql`(${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.accounting-export-intent/v1'
        and (${table.canonicalJson}::jsonb ->> 'intentId') = ${table.intentId}::text
        and (${table.canonicalJson}::jsonb ->> 'operation') = ${table.operation}
        and (${table.canonicalJson}::jsonb ->> 'initialState') = 'pending'
        and (${table.canonicalJson}::jsonb #>> '{destination,namespace}') = case when ${table.operation} = 'reason-artifact' then 'accounting-evidence-restricted/v1' else 'accounting-evidence/v1' end
        and (${table.canonicalJson}::jsonb #>> '{integrity,intentSha256}') = ${table.intentSha256}`,
    ),
    check(
      "accounting_export_outbox_intent_hash_chk",
      sha256Check(table.intentSha256),
    ),
  ],
);

export const accountingAggregateHeadsTable = pgTable(
  "accounting_aggregate_heads",
  {
    id: bigint("id", { mode: "bigint" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    invoiceId: integer("invoice_id").references(() => invoicesTable.id, {
      onDelete: "restrict",
    }),
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "restrict" },
    ),
    revision: bigint("revision", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    versionHeadVersion: bigint("version_head_version", { mode: "bigint" }),
    versionHeadId: uuid("version_head_id").references(
      () => accountingDocumentVersionsTable.id,
      { onDelete: "restrict" },
    ),
    versionHeadSha256: text("version_head_sha256"),
    lifecycleHeadSequence: bigint("lifecycle_head_sequence", {
      mode: "bigint",
    }),
    lifecycleHeadId: uuid("lifecycle_head_id").references(
      () => accountingLifecycleEventsTable.id,
      { onDelete: "restrict" },
    ),
    lifecycleHeadSha256: text("lifecycle_head_sha256"),
    paymentHeadSequence: bigint("payment_head_sequence", { mode: "bigint" }),
    paymentHeadId: uuid("payment_head_id").references(
      () => accountingPaymentEventsTable.id,
      { onDelete: "restrict" },
    ),
    paymentHeadSha256: text("payment_head_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("accounting_aggregate_heads_invoice_uq")
      .on(table.invoiceId)
      .where(sql`${table.invoiceId} is not null`),
    uniqueIndex("accounting_aggregate_heads_cost_uq")
      .on(table.billingDocumentId)
      .where(sql`${table.billingDocumentId} is not null`),
    check(
      "accounting_aggregate_heads_root_chk",
      sql`num_nonnulls(${table.invoiceId}, ${table.billingDocumentId}) = 1`,
    ),
    check(
      "accounting_aggregate_heads_revision_chk",
      sql`${table.revision} >= 0`,
    ),
    check(
      "accounting_aggregate_heads_version_tuple_chk",
      sql`num_nonnulls(${table.versionHeadVersion}, ${table.versionHeadId}, ${table.versionHeadSha256}) in (0, 3)`,
    ),
    check(
      "accounting_aggregate_heads_lifecycle_tuple_chk",
      sql`num_nonnulls(${table.lifecycleHeadSequence}, ${table.lifecycleHeadId}, ${table.lifecycleHeadSha256}) in (0, 3)`,
    ),
    check(
      "accounting_aggregate_heads_payment_tuple_chk",
      sql`num_nonnulls(${table.paymentHeadSequence}, ${table.paymentHeadId}, ${table.paymentHeadSha256}) in (0, 3)`,
    ),
    check(
      "accounting_aggregate_heads_dependency_chk",
      sql`${table.versionHeadId} is not null or (${table.lifecycleHeadId} is null and ${table.paymentHeadId} is null)`,
    ),
    check(
      "accounting_aggregate_heads_cost_payment_chk",
      sql`${table.billingDocumentId} is null or ${table.paymentHeadId} is null`,
    ),
    check(
      "accounting_aggregate_heads_hashes_chk",
      sql`(${table.versionHeadSha256} is null or ${sha256Check(table.versionHeadSha256)}) and (${table.lifecycleHeadSha256} is null or ${sha256Check(table.lifecycleHeadSha256)}) and (${table.paymentHeadSha256} is null or ${sha256Check(table.paymentHeadSha256)})`,
    ),
  ],
);

export type AccountingDocumentVersionRow =
  typeof accountingDocumentVersionsTable.$inferSelect;
export type AccountingLifecycleEventRow =
  typeof accountingLifecycleEventsTable.$inferSelect;
export type AccountingReasonArtifactRow =
  typeof accountingReasonArtifactsTable.$inferSelect;
export type AccountingPaymentEventRow =
  typeof accountingPaymentEventsTable.$inferSelect;
export type AccountingWarehousePriceObservationRow =
  typeof accountingWarehousePriceObservationsTable.$inferSelect;
export type AccountingWarehousePriceProjectionHeadRow =
  typeof accountingWarehousePriceProjectionHeadsTable.$inferSelect;
export type AccountingVersionRelationRow =
  typeof accountingVersionRelationsTable.$inferSelect;
export type AccountingExportOutboxRow =
  typeof accountingExportOutboxTable.$inferSelect;
export type AccountingAggregateHeadRow =
  typeof accountingAggregateHeadsTable.$inferSelect;

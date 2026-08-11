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

const sha256Check = (column: unknown) => sql`${column} ~ '^[0-9a-f]{64}$'`;
const canonicalObjectCheck = (column: unknown) =>
  sql`(jsonb_typeof((${column})::jsonb) = 'object') is true`;

/**
 * One immutable row owns both the canonical event envelope and its canonical
 * global-chain record. Keeping those values together removes the partial
 * event/ledger state which the earlier repository contract allowed.
 */
export const auditEventsTable = pgTable(
  "audit_events",
  {
    eventId: uuid("event_id").primaryKey(),
    streamId: text("stream_id").notNull(),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    canonicalEventJson: text("canonical_event_json").notNull(),
    eventSha256: text("event_sha256").notNull(),
    canonicalLedgerJson: text("canonical_ledger_json").notNull(),
    previousLedgerSha256: text("previous_ledger_sha256"),
    ledgerSha256: text("ledger_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_events_stream_sequence_uq").on(
      table.streamId,
      table.sequence,
    ),
    uniqueIndex("audit_events_event_hash_uq").on(table.eventSha256),
    uniqueIndex("audit_events_ledger_hash_uq").on(table.ledgerSha256),
    index("audit_events_occurred_idx").on(table.occurredAt),
    check(
      "audit_events_stream_chk",
      sql`${table.streamId} = 'site-logbook:audit:global:v1'`,
    ),
    check("audit_events_sequence_chk", sql`${table.sequence} >= 1`),
    check(
      "audit_events_previous_chk",
      sql`(${table.sequence} = 1 and ${table.previousLedgerSha256} is null) or (${table.sequence} > 1 and ${table.previousLedgerSha256} is not null)`,
    ),
    check(
      "audit_events_event_json_chk",
      canonicalObjectCheck(table.canonicalEventJson),
    ),
    check(
      "audit_events_ledger_json_chk",
      canonicalObjectCheck(table.canonicalLedgerJson),
    ),
    check("audit_events_event_hash_chk", sha256Check(table.eventSha256)),
    check(
      "audit_events_previous_hash_chk",
      sql`${table.previousLedgerSha256} is null or ${sha256Check(table.previousLedgerSha256)}`,
    ),
    check("audit_events_ledger_hash_chk", sha256Check(table.ledgerSha256)),
    check(
      "audit_events_event_shape_chk",
      sql`((${table.canonicalEventJson}::jsonb - array['schemaVersion','eventId','occurredAt','actor','source','action','entity','reason','state','correlation','artifactRefs','integrity']) = '{}'::jsonb
        and ${table.canonicalEventJson}::jsonb ?& array['schemaVersion','eventId','occurredAt','actor','source','action','entity','reason','state','correlation','artifactRefs','integrity']) is true`,
    ),
    check(
      "audit_events_ledger_shape_chk",
      sql`((${table.canonicalLedgerJson}::jsonb - array['schemaVersion','streamId','sequence','eventId','eventSha256','recordedAt','previousLedgerSha256','integrity']) = '{}'::jsonb
        and ${table.canonicalLedgerJson}::jsonb ?& array['schemaVersion','streamId','sequence','eventId','eventSha256','recordedAt','previousLedgerSha256','integrity']
        and ((${table.canonicalLedgerJson}::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','ledgerSha256']) = '{}'::jsonb
        and (${table.canonicalLedgerJson}::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','ledgerSha256']) is true`,
    ),
    check(
      "audit_events_event_binding_chk",
      sql`((${table.canonicalEventJson}::jsonb ->> 'schemaVersion') = 'site-logbook.audit-event/v1'
        and (${table.canonicalEventJson}::jsonb ->> 'eventId') = ${table.eventId}::text
        and (${table.canonicalEventJson}::jsonb ->> 'occurredAt')::timestamptz = ${table.occurredAt}
        and (${table.canonicalEventJson}::jsonb #>> '{integrity,eventSha256}') = ${table.eventSha256}) is true`,
    ),
    check(
      "audit_events_ledger_binding_chk",
      sql`((${table.canonicalLedgerJson}::jsonb ->> 'schemaVersion') = 'site-logbook.audit-chain-record/v1'
        and (${table.canonicalLedgerJson}::jsonb ->> 'streamId') = ${table.streamId}
        and (${table.canonicalLedgerJson}::jsonb ->> 'sequence') = ${table.sequence}::text
        and (${table.canonicalLedgerJson}::jsonb ->> 'eventId') = ${table.eventId}::text
        and (${table.canonicalLedgerJson}::jsonb ->> 'eventSha256') = ${table.eventSha256}
        and (${table.canonicalLedgerJson}::jsonb ->> 'recordedAt')::timestamptz = ${table.occurredAt}
        and (${table.canonicalLedgerJson}::jsonb ->> 'previousLedgerSha256') is not distinct from ${table.previousLedgerSha256}
        and (${table.canonicalLedgerJson}::jsonb #>> '{integrity,ledgerSha256}') = ${table.ledgerSha256}) is true`,
    ),
  ],
);

/** Singleton mutable projection over the immutable global stream. */
export const auditChainHeadsTable = pgTable(
  "audit_chain_heads",
  {
    streamId: text("stream_id").primaryKey(),
    sequence: bigint("sequence", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    ledgerSha256: text("ledger_sha256"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "audit_chain_heads_stream_chk",
      sql`${table.streamId} = 'site-logbook:audit:global:v1'`,
    ),
    check(
      "audit_chain_heads_state_chk",
      sql`(${table.sequence} = 0 and ${table.ledgerSha256} is null) or (${table.sequence} >= 1 and ${table.ledgerSha256} is not null)`,
    ),
    check(
      "audit_chain_heads_hash_chk",
      sql`${table.ledgerSha256} is null or ${sha256Check(table.ledgerSha256)}`,
    ),
  ],
);

/** Canonical export intent plus the separately mutable delivery lease/receipt. */
export const auditExportOutboxTable = pgTable(
  "audit_export_outbox",
  {
    intentId: uuid("intent_id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => auditEventsTable.eventId, {
        onDelete: "restrict",
        onUpdate: "restrict",
      }),
    streamId: text("stream_id").notNull(),
    throughSequence: bigint("through_sequence", { mode: "bigint" }).notNull(),
    throughLedgerSha256: text("through_ledger_sha256").notNull(),
    eventSha256: text("event_sha256").notNull(),
    intentCreatedAt: timestamp("intent_created_at", {
      withTimezone: true,
    }).notNull(),
    canonicalJson: text("canonical_json").notNull(),
    intentSha256: text("intent_sha256").notNull(),
    state: text("state").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    objectKey: text("object_key"),
    objectVersionId: text("object_version_id"),
    objectSha256: text("object_sha256"),
    exportedAt: timestamp("exported_at", { withTimezone: true }),
    deadLetteredAt: timestamp("dead_lettered_at", { withTimezone: true }),
    lastFailureCategory: text("last_failure_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("audit_export_outbox_event_uq").on(table.eventId),
    index("audit_export_outbox_claim_idx").on(
      table.state,
      table.availableAt,
      table.leaseExpiresAt,
    ),
    foreignKey({
      columns: [table.streamId, table.throughSequence],
      foreignColumns: [auditEventsTable.streamId, auditEventsTable.sequence],
      name: "audit_export_outbox_event_sequence_fk",
    })
      .onUpdate("restrict")
      .onDelete("restrict"),
    check(
      "audit_export_outbox_identity_chk",
      sql`${table.intentId} = ${table.eventId} and ${table.streamId} = 'site-logbook:audit:global:v1'`,
    ),
    check(
      "audit_export_outbox_sequence_chk",
      sql`${table.throughSequence} >= 1`,
    ),
    check(
      "audit_export_outbox_hashes_chk",
      sql`${sha256Check(table.throughLedgerSha256)} and ${sha256Check(table.eventSha256)} and ${sha256Check(table.intentSha256)}`,
    ),
    check(
      "audit_export_outbox_state_chk",
      sql`${table.state} in ('pending', 'exporting', 'exported', 'dead_letter')`,
    ),
    check("audit_export_outbox_attempt_chk", sql`${table.attemptCount} >= 0`),
    check(
      "audit_export_outbox_lease_chk",
      sql`(${table.state} = 'exporting' and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.state} <> 'exporting' and ${table.leaseToken} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      "audit_export_outbox_terminal_chk",
      sql`((${table.state} = 'exported' and ${table.exportedAt} is not null and length(btrim(${table.objectKey})) > 0 and length(btrim(${table.objectVersionId})) between 1 and 512 and ${sha256Check(table.objectSha256)} and ${table.deadLetteredAt} is null) or (${table.state} = 'dead_letter' and ${table.deadLetteredAt} is not null and ${table.exportedAt} is null and num_nonnulls(${table.objectKey}, ${table.objectVersionId}, ${table.objectSha256}) = 0) or (${table.state} in ('pending', 'exporting') and ${table.exportedAt} is null and ${table.deadLetteredAt} is null and num_nonnulls(${table.objectKey}, ${table.objectVersionId}, ${table.objectSha256}) = 0)) is true`,
    ),
    check(
      "audit_export_outbox_receipt_binding_chk",
      sql`(${table.objectKey} is null or (${table.objectKey} = 'audit-evidence/v1/' || ${table.intentId}::text || '/' || ${table.intentSha256} || '/audit.jsonl' and ${table.objectVersionId} !~ '[[:space:][:cntrl:]]')) is true`,
    ),
    check(
      "audit_export_outbox_failure_category_chk",
      sql`${table.lastFailureCategory} is null or ${table.lastFailureCategory} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      "audit_export_outbox_canonical_json_chk",
      canonicalObjectCheck(table.canonicalJson),
    ),
    check(
      "audit_export_outbox_canonical_shape_chk",
      sql`((${table.canonicalJson}::jsonb - array['schemaVersion','intentId','kind','createdAt','streamId','throughSequence','throughLedgerSha256','eventId','eventSha256','destination','initialState','integrity']) = '{}'::jsonb
        and ${table.canonicalJson}::jsonb ?& array['schemaVersion','intentId','kind','createdAt','streamId','throughSequence','throughLedgerSha256','eventId','eventSha256','destination','initialState','integrity']
        and ((${table.canonicalJson}::jsonb -> 'destination') - array['kind','namespace','format']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'destination') ?& array['kind','namespace','format']
        and ((${table.canonicalJson}::jsonb -> 'integrity') - array['canonicalization','hashAlgorithm','hashDomain','intentSha256']) = '{}'::jsonb
        and (${table.canonicalJson}::jsonb -> 'integrity') ?& array['canonicalization','hashAlgorithm','hashDomain','intentSha256']) is true`,
    ),
    check(
      "audit_export_outbox_canonical_binding_chk",
      sql`((${table.canonicalJson}::jsonb ->> 'schemaVersion') = 'site-logbook.audit-export-intent/v1'
        and (${table.canonicalJson}::jsonb ->> 'intentId') = ${table.intentId}::text
        and (${table.canonicalJson}::jsonb ->> 'kind') = 'audit-chain-export'
        and (${table.canonicalJson}::jsonb ->> 'createdAt')::timestamptz = ${table.intentCreatedAt}
        and (${table.canonicalJson}::jsonb ->> 'streamId') = ${table.streamId}
        and (${table.canonicalJson}::jsonb ->> 'throughSequence') = ${table.throughSequence}::text
        and (${table.canonicalJson}::jsonb ->> 'throughLedgerSha256') = ${table.throughLedgerSha256}
        and (${table.canonicalJson}::jsonb ->> 'eventId') = ${table.eventId}::text
        and (${table.canonicalJson}::jsonb ->> 'eventSha256') = ${table.eventSha256}
        and (${table.canonicalJson}::jsonb #>> '{destination,kind}') = 'versioned-object-storage'
        and (${table.canonicalJson}::jsonb #>> '{destination,namespace}') = 'audit-evidence/v1'
        and (${table.canonicalJson}::jsonb #>> '{destination,format}') = 'site-logbook.audit-jsonl/v1'
        and (${table.canonicalJson}::jsonb ->> 'initialState') = 'pending'
        and (${table.canonicalJson}::jsonb #>> '{integrity,intentSha256}') = ${table.intentSha256}) is true`,
    ),
  ],
);

export type AuditEventRow = typeof auditEventsTable.$inferSelect;
export type AuditChainHeadRow = typeof auditChainHeadsTable.$inferSelect;
export type AuditExportOutboxRow = typeof auditExportOutboxTable.$inferSelect;

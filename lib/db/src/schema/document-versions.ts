import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";
import { quotesTable } from "./quotes";
import { usersTable } from "./users";

export interface JobDocumentSnapshot {
  schemaVersion: 1;
  job: {
    id: number;
    title: string;
    date: string;
    customerCompanyName: string | null;
    notes: string | null;
  };
  confirmationText: string;
}

export interface QuoteVersionSnapshotItem {
  lineId: number;
  position: number;
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  vatRate: number | null;
  totalWithoutVat: number;
  totalVat: number;
  totalWithVat: number;
}

export interface QuoteVersionSnapshot {
  schemaVersion: 1;
  quote: {
    id: number;
    quoteNumber: string | null;
    title: string;
    validUntil: string | null;
    notes: string | null;
    createdAt: string;
  };
  customer: {
    companyName: string | null;
    ic: string | null;
    dic: string | null;
    address: string | null;
    email: string | null;
  };
  supplier: {
    name: string;
    ic: string | null;
    dic: string | null;
    address: string | null;
    email: string | null;
    phone: string | null;
    footerNote: string | null;
    vatPayer: boolean;
  };
  items: QuoteVersionSnapshotItem[];
  totals: {
    subtotalWithoutVat: number;
    totalVat: number;
    totalWithVat: number;
    currency: "Kč";
  };
  confirmationText: string;
}

export const jobDocumentVersionsTable = pgTable(
  "job_document_versions",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: text("status").notNull().default("pending_signature"),
    supersedesVersionId: integer("supersedes_version_id"),
    dataSnapshot: jsonb("data_snapshot").$type<JobDocumentSnapshot>().notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    confirmationText: text("confirmation_text").notNull(),
    signatoryName: text("signatory_name"),
    identityAssurance: text("identity_assurance"),
    signatureObjectPath: text("signature_object_path"),
    signatureSha256: text("signature_sha256"),
    pdfObjectPath: text("pdf_object_path"),
    pdfSha256: text("pdf_sha256"),
    signedAt: timestamp("signed_at"),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("job_document_versions_job_version_uq").on(
      table.jobId,
      table.version,
    ),
    index("job_document_versions_job_created_idx").on(
      table.jobId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
      name: "job_document_versions_supersedes_fk",
    }).onDelete("restrict"),
    check(
      "job_document_versions_status_chk",
      sql`${table.status} in ('pending_signature', 'signed')`,
    ),
    check(
      "job_document_versions_snapshot_hash_chk",
      sql`${table.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "job_document_versions_signed_fields_chk",
      sql`(
        ${table.status} = 'pending_signature' and
        ${table.signatoryName} is null and ${table.identityAssurance} is null and
        ${table.signatureObjectPath} is null and ${table.signatureSha256} is null and
        ${table.pdfObjectPath} is null and ${table.pdfSha256} is null and ${table.signedAt} is null
      ) or (
        ${table.status} = 'signed' and
        length(btrim(${table.signatoryName})) >= 2 and ${table.identityAssurance} = 'self_declared_name' and
        ${table.signatureObjectPath} is not null and ${table.signatureSha256} ~ '^[0-9a-f]{64}$' and
        ${table.pdfObjectPath} is not null and ${table.pdfSha256} ~ '^[0-9a-f]{64}$' and
        ${table.signedAt} is not null
      )`,
    ),
  ],
);

export const jobSignatureEventsTable = pgTable(
  "job_signature_events",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "restrict" }),
    documentVersionId: integer("document_version_id")
      .notNull()
      .references(() => jobDocumentVersionsTable.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name"),
    identityAssurance: text("identity_assurance"),
    confirmationText: text("confirmation_text"),
    reason: text("reason"),
    userAgentSha256: text("user_agent_sha256"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("job_signature_events_job_created_idx").on(
      table.jobId,
      table.createdAt,
    ),
    index("job_signature_events_version_idx").on(table.documentVersionId),
    check(
      "job_signature_events_type_chk",
      sql`${table.eventType} in ('signed', 'superseded', 'cancelled')`,
    ),
    check(
      "job_signature_events_actor_type_chk",
      sql`${table.actorType} in ('public_signer', 'admin', 'system')`,
    ),
    check(
      "job_signature_events_user_agent_hash_chk",
      sql`${table.userAgentSha256} is null or ${table.userAgentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const quoteVersionsTable = pgTable(
  "quote_versions",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    supersedesVersionId: integer("supersedes_version_id"),
    dataSnapshot: jsonb("data_snapshot").$type<QuoteVersionSnapshot>().notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    pdfObjectPath: text("pdf_object_path").notNull(),
    pdfSha256: text("pdf_sha256").notNull(),
    rendererVersion: text("renderer_version").notNull(),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("quote_versions_quote_version_uq").on(
      table.quoteId,
      table.version,
    ),
    index("quote_versions_quote_created_idx").on(
      table.quoteId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
      name: "quote_versions_supersedes_fk",
    }).onDelete("restrict"),
    check(
      "quote_versions_snapshot_hash_chk",
      sql`${table.snapshotSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "quote_versions_pdf_hash_chk",
      sql`${table.pdfSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const quoteDecisionEventsTable = pgTable(
  "quote_decision_events",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "restrict" }),
    quoteVersionId: integer("quote_version_id")
      .notNull()
      .references(() => quoteVersionsTable.id, { onDelete: "restrict" }),
    action: text("action").notNull(),
    actorType: text("actor_type").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name"),
    identityAssurance: text("identity_assurance"),
    confirmationText: text("confirmation_text"),
    reason: text("reason"),
    userAgentSha256: text("user_agent_sha256"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("quote_decision_events_quote_created_idx").on(
      table.quoteId,
      table.createdAt,
    ),
    index("quote_decision_events_version_idx").on(table.quoteVersionId),
    check(
      "quote_decision_events_action_chk",
      sql`${table.action} in ('accepted', 'rejected', 'expired', 'superseded')`,
    ),
    check(
      "quote_decision_events_actor_type_chk",
      sql`${table.actorType} in ('public_recipient', 'admin', 'system')`,
    ),
    check(
      "quote_decision_events_user_agent_hash_chk",
      sql`${table.userAgentSha256} is null or ${table.userAgentSha256} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type JobDocumentVersion = typeof jobDocumentVersionsTable.$inferSelect;
export type JobSignatureEvent = typeof jobSignatureEventsTable.$inferSelect;
export type QuoteVersion = typeof quoteVersionsTable.$inferSelect;
export type QuoteDecisionEvent = typeof quoteDecisionEventsTable.$inferSelect;

import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { invoicesTable } from "./invoices";

/**
 * Received (incoming) cost documents — "přijaté nákladové doklady".
 *
 * These are účtenky (receipts), dodací listy (delivery notes), přijaté faktury
 * (received invoices) and dobropisy (credit notes) that a supplier issues TO us.
 * They are tracked so their line items (materials/work) can be reviewed,
 * matched to jobs and — when approved — re-billed onto outgoing customer
 * invoices (`invoice_lines.source_type = 'billing_document_line'`).
 *
 * Money is numeric(12,2) (CZK with haléře). Calendar dates (issue / taxable
 * supply / due) are ISO "YYYY-MM-DD" text, the same convention as jobs.date.
 *
 * The original file lives in object storage; only its `object_path` is stored
 * here (never the bytes). `sha256` is the content hash used for duplicate
 * detection. Header fields are prefilled by the machine-side ISDOC/XML parser
 * when possible, otherwise entered/corrected by an admin during review.
 *
 * status:  uploaded | needs_review | reviewed | approved | ignored | duplicate
 * docType: receipt | delivery_note | invoice | credit_note
 * source:  manual | job_attachment | isdoc | email
 */
export const billingDocumentsTable = pgTable(
  "billing_documents",
  {
    id: serial("id").primaryKey(),
    status: text("status").notNull().default("uploaded"),
    docType: text("doc_type").notNull().default("invoice"),
    source: text("source").notNull().default("manual"),

    // Original file in object storage (only the path is stored, never bytes).
    objectPath: text("object_path"),
    fileName: text("file_name"),
    contentType: text("content_type"),
    fileSize: integer("file_size"),
    sha256: text("sha256"),

    // Header fields (prefilled by ISDOC parser or entered/corrected by admin).
    supplierName: text("supplier_name"),
    supplierIc: text("supplier_ic"),
    supplierDic: text("supplier_dic"),
    supplierAddress: text("supplier_address"),
    documentNumber: text("document_number"),
    variableSymbol: text("variable_symbol"),
    issueDate: text("issue_date"),
    taxableSupplyDate: text("taxable_supply_date"),
    dueDate: text("due_date"),
    currency: text("currency").notNull().default("CZK"),
    subtotalWithoutVat: numeric("subtotal_without_vat", { precision: 12, scale: 2 }),
    totalVat: numeric("total_vat", { precision: 12, scale: 2 }),
    totalWithVat: numeric("total_with_vat", { precision: 12, scale: 2 }),

    // Optional links: which of our customers/jobs this document relates to.
    customerId: integer("customer_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    jobId: integer("job_id").references(() => jobsTable.id, {
      onDelete: "set null",
    }),

    // Free-text reviewer notes + machine warnings (e.g. "parsováno z ISDOC").
    notes: text("notes"),
    warnings: text("warnings"),

    // AI extraction (OpenAI) — optional. Populated by the extraction worker when
    // AI extraction is configured & enabled. The raw model response is stored
    // verbatim for audit; ai_confidence is the model's overall 0..1 confidence
    // (below 0.7 the document is flagged for closer human review). AI output is
    // never auto-approved — it is only ever a needs_review suggestion.
    aiRawJson: text("ai_raw_json"),
    aiConfidence: numeric("ai_confidence", { precision: 3, scale: 2 }),
    aiModel: text("ai_model"),
    aiExtractedAt: timestamp("ai_extracted_at"),

    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("billing_documents_status_idx").on(t.status),
    index("billing_documents_sha256_idx").on(t.sha256),
    index("billing_documents_supplier_ic_idx").on(t.supplierIc),
    index("billing_documents_document_number_idx").on(t.documentNumber),
    index("billing_documents_job_id_idx").on(t.jobId),
    index("billing_documents_customer_id_idx").on(t.customerId),
  ],
);

/**
 * Individual lines of a received cost document.
 *
 * A line can be matched to a job and re-billed, marked internal/stock/not
 * re-billed, or SPLIT across several jobs. Splitting creates sibling lines that
 * reference the original via `parent_line_id` (provenance); each split line
 * carries its own quantity/job assignment.
 *
 * Matching is only ever a SUGGESTION — `match_confirmed` stays false until an
 * admin confirms it. Nothing is auto-confirmed.
 *
 * `invoiced_invoice_id` is set when the line has been pulled into a draft/issued
 * outgoing invoice, so it is not offered for re-billing twice. It is cleared
 * when that invoice is deleted (draft) or cancelled (storno).
 *
 * lineType:       material | work | transport | other
 * allocationType: rebill | internal | stock | not_rebilled
 * vatMode:        standard | reverse_charge | zero | non_vat
 */
export const billingDocumentLinesTable = pgTable(
  "billing_document_lines",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => billingDocumentsTable.id, { onDelete: "cascade" }),
    parentLineId: integer("parent_line_id").references(
      (): AnyPgColumn => billingDocumentLinesTable.id,
      { onDelete: "set null" },
    ),
    lineType: text("line_type").notNull().default("material"),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("1"),
    unit: text("unit"),
    unitPriceWithoutVat: numeric("unit_price_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatMode: text("vat_mode").notNull().default("standard"),
    totalWithoutVat: numeric("total_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    totalVat: numeric("total_vat", { precision: 12, scale: 2 }).notNull().default("0"),
    totalWithVat: numeric("total_with_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),

    // Matching / allocation.
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
    allocationType: text("allocation_type").notNull().default("rebill"),
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }),
    matchConfirmed: integer("match_confirmed").notNull().default(0),
    approved: integer("approved").notNull().default(0),

    invoicedInvoiceId: integer("invoiced_invoice_id").references(
      () => invoicesTable.id,
      { onDelete: "set null" },
    ),

    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("billing_document_lines_document_id_idx").on(t.documentId),
    index("billing_document_lines_job_id_idx").on(t.jobId),
    index("billing_document_lines_invoiced_invoice_id_idx").on(t.invoicedInvoiceId),
  ],
);

/**
 * DB-backed extraction queue. One row per attempt-set for a document. A
 * conservative in-process worker polls `queued` rows, parses what it safely can
 * (ISDOC/XML) and routes the document to `needs_review` for a human. The AI
 * extraction step is intentionally left as a placeholder (filled by a later
 * task); until then the worker never guesses values it cannot read.
 *
 * status: queued | running | done | failed | skipped
 */
export const extractionJobsTable = pgTable(
  "extraction_jobs",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => billingDocumentsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lastError: text("last_error"),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("extraction_jobs_status_idx").on(t.status),
    index("extraction_jobs_document_id_idx").on(t.documentId),
  ],
);

export const insertBillingDocumentSchema = createInsertSchema(
  billingDocumentsTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBillingDocument = z.infer<typeof insertBillingDocumentSchema>;
export type BillingDocument = typeof billingDocumentsTable.$inferSelect;

export const insertBillingDocumentLineSchema = createInsertSchema(
  billingDocumentLinesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBillingDocumentLine = z.infer<
  typeof insertBillingDocumentLineSchema
>;
export type BillingDocumentLine = typeof billingDocumentLinesTable.$inferSelect;

export type ExtractionJob = typeof extractionJobsTable.$inferSelect;

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
import { attachmentsTable } from "./attachments";

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
    // Provenance detail for the source. For source="email" this is the original
    // sender's address; null for manually uploaded documents.
    sourceRef: text("source_ref"),

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

    // Extra supplier reference numbers carried on the document header. These are
    // the supplier's own numbers (NOT our internal ids). They drive matching to
    // delivery notes saved in jobs and to supplier orders. `documentNumber` above
    // stays the invoice number; these are the document's *other* references.
    deliveryNoteNumber: text("delivery_note_number"),
    summaryDeliveryNoteNumber: text("summary_delivery_note_number"),
    deliveryNumber: text("delivery_number"),
    orderNumber: text("order_number"),
    supplierOrderNumber: text("supplier_order_number"),

    // Bank / payment header fields (mostly from ISDOC). Stored for audit + QR.
    constantSymbol: text("constant_symbol"),
    specificSymbol: text("specific_symbol"),
    bankAccount: text("bank_account"),
    iban: text("iban"),
    bic: text("bic"),
    // The ISDOC document UUID (its globally-unique id), used to dedupe ISDOC↔PDF.
    isdocUuid: text("isdoc_uuid"),

    // Merge / dedup of the SAME logical invoice arriving as both PDF and ISDOC.
    // All files for one logical document live in `billing_document_files`; the
    // group id ties any merged-in secondary documents to the primary. When a PDF
    // and ISDOC both create rows before we detect they are the same invoice, the
    // secondary points at the primary via `primaryDocumentId` and is marked
    // status="duplicate". `sourcePriority` records which source wins for the
    // header/lines (isdoc > pdf > ai > manual).
    mergeGroupId: text("merge_group_id"),
    primaryDocumentId: integer("primary_document_id").references(
      (): AnyPgColumn => billingDocumentsTable.id,
      { onDelete: "set null" },
    ),
    sourcePriority: text("source_priority"),
    parsedBy: text("parsed_by"),
    extractionVersion: integer("extraction_version").notNull().default(1),

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
 * re-billed, or SPLIT across several jobs. Splitting replaces the original line
 * with independent sibling lines, each carrying its own quantity/job assignment.
 * `parent_line_id` exists for optional provenance, but split parts leave it null
 * because the original line is deleted in the same transaction (so a reference
 * to it would break this self-FK).
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
    // The unit exactly as written on the supplier document (e.g. "100m", "bal").
    // Kept for audit when `unit`/`quantity` are normalized (see priceBase* below).
    originalUnit: text("original_unit"),
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

    // Supplier item identification (for warehouse matching + price history).
    supplierSku: text("supplier_sku"),
    ean: text("ean"),
    manufacturer: text("manufacturer"),

    // Discounts / rebates. Suppliers quote a list ("ceníková") price, an optional
    // before-discount price, a discount %, and the resulting after-discount unit
    // price. We keep all of them so the discount is visible and auditable; the
    // effective `unitPriceWithoutVat` above is the after-discount price.
    discountPercent: numeric("discount_percent", { precision: 6, scale: 2 }),
    listPriceWithoutVat: numeric("list_price_without_vat", { precision: 12, scale: 4 }),
    priceBeforeDiscount: numeric("price_before_discount", { precision: 12, scale: 4 }),
    priceAfterDiscount: numeric("price_after_discount", { precision: 12, scale: 4 }),

    // Per-100 normalization. Some suppliers quote "cena za 100 m / 100 ks". We
    // normalize quantity/unitPrice to 1 unit for the warehouse but keep the
    // original base so the supplier figure can be reproduced for audit.
    priceBaseQuantity: numeric("price_base_quantity", { precision: 12, scale: 2 }),
    priceBaseUnit: text("price_base_unit"),

    // Fees: eko / recyklační příspěvek, doprava, platba, zaokrouhlení. A fee can
    // be a standalone line (feeType set, lineType="other") or attached to a
    // material line via `relatedLineId`. Environmental/recycling amounts are also
    // stored numerically so they are never silently treated as material.
    feeType: text("fee_type"),
    isEnvironmentalFee: integer("is_environmental_fee").notNull().default(0),
    environmentalFee: numeric("environmental_fee", { precision: 12, scale: 2 }),
    recyclingFee: numeric("recycling_fee", { precision: 12, scale: 2 }),
    relatedLineId: integer("related_line_id").references(
      (): AnyPgColumn => billingDocumentLinesTable.id,
      { onDelete: "set null" },
    ),

    // Per-line supplier references (a line can cite its own delivery note/order).
    deliveryNoteNumber: text("delivery_note_number"),
    orderNumber: text("order_number"),
    supplierOrderNumber: text("supplier_order_number"),
    // The supplier's own line number on the source document (for audit / dedup).
    sourceLineNumber: text("source_line_number"),
    // Per-line extraction confidence (0..1), e.g. lower for OCR'd PDF lines.
    confidence: numeric("confidence", { precision: 3, scale: 2 }),

    // Matching / allocation.
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
    allocationType: text("allocation_type").notNull().default("rebill"),
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }),
    matchConfirmed: integer("match_confirmed").notNull().default(0),
    approved: integer("approved").notNull().default(0),
    // Warehouse/price lifecycle state once the line is approved (see WAREHOUSE_LINE_STATES).
    warehouseState: text("warehouse_state"),

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

/**
 * Files belonging to one logical cost document. A single invoice can arrive as
 * several files — typically a structured ISDOC (the source of truth for lines /
 * amounts) AND a visual PDF (what a human reads). Instead of two cost documents,
 * we keep ONE `billing_documents` row and attach every file here.
 *
 * role:  primary | visual_pdf | structured_isdoc | attachment | original_email_attachment
 */
export const billingDocumentFilesTable = pgTable(
  "billing_document_files",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => billingDocumentsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("attachment"),
    originalFileName: text("original_file_name"),
    mimeType: text("mime_type"),
    // Object-storage path only — never the bytes.
    objectPath: text("object_path"),
    sha256Hash: text("sha256_hash"),
    sizeBytes: integer("size_bytes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("billing_document_files_document_id_idx").on(t.documentId),
    index("billing_document_files_sha256_idx").on(t.sha256Hash),
  ],
);

/**
 * Supplier reference numbers extracted from a cost document, and how each one
 * matched (or didn't) to an existing job / delivery note / document in the
 * system. The golden rule: the delivery note saved in a job tells us WHERE the
 * material probably belongs; the invoice tells us the PRICE. AI/parser only ever
 * proposes — `matchConfirmed` stays 0 until an admin confirms.
 *
 * referenceType: delivery_note | summary_delivery_note | delivery | order |
 *                supplier_order | project | invoice | credit_note | other
 * source:        isdoc | pdf_text | ai | manual | supplier_profile
 */
export const billingDocumentReferencesTable = pgTable(
  "billing_document_references",
  {
    id: serial("id").primaryKey(),
    documentId: integer("document_id")
      .notNull()
      .references(() => billingDocumentsTable.id, { onDelete: "cascade" }),
    referenceType: text("reference_type").notNull().default("other"),
    referenceNumber: text("reference_number").notNull(),
    source: text("source").notNull().default("manual"),
    confidence: numeric("confidence", { precision: 5, scale: 2 }),

    // What this reference matched to in our system (suggestions until confirmed).
    matchedJobId: integer("matched_job_id").references(() => jobsTable.id, {
      onDelete: "set null",
    }),
    matchedDocumentId: integer("matched_document_id").references(
      (): AnyPgColumn => billingDocumentsTable.id,
      { onDelete: "set null" },
    ),
    matchedAttachmentId: integer("matched_attachment_id").references(
      () => attachmentsTable.id,
      { onDelete: "set null" },
    ),
    matchConfidence: numeric("match_confidence", { precision: 5, scale: 2 }),
    matchConfirmed: integer("match_confirmed").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    notes: text("notes"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("billing_document_references_document_id_idx").on(t.documentId),
    index("billing_document_references_number_idx").on(t.referenceNumber),
    index("billing_document_references_matched_job_id_idx").on(t.matchedJobId),
  ],
);

/**
 * Per-supplier parsing profiles. Recognised by name pattern and/or IČO; their
 * `rulesJson` carries regexes + flags that guide reference / fee / line
 * extraction for that supplier's document layout (DEK, Schrack, Varnet, K&V…).
 *
 * `supplierId` is reserved for a future suppliers table — there is none yet, so
 * it is a plain nullable integer (no FK).
 *
 * parserType: generic | dek | schrack | varnet | kv_elektro
 */
export const supplierParserProfilesTable = pgTable(
  "supplier_parser_profiles",
  {
    id: serial("id").primaryKey(),
    supplierId: integer("supplier_id"),
    supplierName: text("supplier_name"),
    supplierNamePattern: text("supplier_name_pattern"),
    ico: text("ico"),
    parserType: text("parser_type").notNull().default("generic"),
    rulesJson: text("rules_json"),
    isActive: integer("is_active").notNull().default(1),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("supplier_parser_profiles_ico_idx").on(t.ico),
    index("supplier_parser_profiles_active_idx").on(t.isActive),
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

export const insertBillingDocumentFileSchema = createInsertSchema(
  billingDocumentFilesTable,
).omit({ id: true, createdAt: true });
export type InsertBillingDocumentFile = z.infer<
  typeof insertBillingDocumentFileSchema
>;
export type BillingDocumentFile = typeof billingDocumentFilesTable.$inferSelect;

export const insertBillingDocumentReferenceSchema = createInsertSchema(
  billingDocumentReferencesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBillingDocumentReference = z.infer<
  typeof insertBillingDocumentReferenceSchema
>;
export type BillingDocumentReference =
  typeof billingDocumentReferencesTable.$inferSelect;

export const insertSupplierParserProfileSchema = createInsertSchema(
  supplierParserProfilesTable,
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSupplierParserProfile = z.infer<
  typeof insertSupplierParserProfileSchema
>;
export type SupplierParserProfile =
  typeof supplierParserProfilesTable.$inferSelect;

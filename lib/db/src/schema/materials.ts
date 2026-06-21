import { pgTable, serial, text, numeric, boolean, integer, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { billingDocumentsTable, billingDocumentLinesTable } from "./billing-documents";
import { invoicesTable } from "./invoices";

export const materialsTable = pgTable("materials", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }),
  unit: text("unit"),
  pricePerUnit: numeric("price_per_unit", { precision: 10, scale: 2 }),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  // Provenance: when a material row was propagated from an approved cost
  // document line, these point back at it so the sync is idempotent (re-approve
  // / edit updates the same row instead of duplicating). Manually-added
  // materials leave both null. Mirrors invoice_lines.source_type/source_id.
  // sourceType is currently only "billing_document_line".
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  // Price provenance. Where the current pricePerUnit came from and the document
  // that supplied it. priceSource is one of MATERIAL_PRICE_SOURCES (see
  // job-material-pricing.ts): "manual" | "delivery_note" | "invoice" |
  // "stock_history" | "awaiting_invoice" | null (legacy/unknown). A delivery
  // note typically creates the row with no price ("awaiting_invoice"); a later
  // approved invoice fills it ("invoice"). All additive/nullable — never
  // backfilled with a destructive change.
  priceSource: text("price_source"),
  priceSourceDocumentId: integer("price_source_document_id").references(
    () => billingDocumentsTable.id,
    { onDelete: "set null" },
  ),
  priceSourceLineId: integer("price_source_line_id").references(
    () => billingDocumentLinesTable.id,
    { onDelete: "set null" },
  ),
  priceSourceSupplierName: text("price_source_supplier_name"),
  priceSourceDate: timestamp("price_source_date"),
  priceConfidence: numeric("price_confidence", { precision: 3, scale: 2 }),
  adminNote: text("admin_note"),
  // Customer-invoicing lifecycle for materials priced from a cost document and
  // offered for re-billing directly (Phase 4). Null = not yet invoiced.
  invoicedAt: timestamp("invoiced_at"),
  invoicedInvoiceId: integer("invoiced_invoice_id").references(
    () => invoicesTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // A cost-document line maps to at most one job material. Partial unique index
  // (manual materials have a null source and are unconstrained) — guards against
  // duplicate propagation if two approves race.
  uniqueIndex("materials_source_uq").on(t.sourceType, t.sourceId).where(sql`${t.sourceType} is not null`),
  index("materials_price_source_document_id_idx").on(t.priceSourceDocumentId),
  index("materials_price_source_line_id_idx").on(t.priceSourceLineId),
  index("materials_invoiced_invoice_id_idx").on(t.invoicedInvoiceId),
]);

export const insertMaterialSchema = createInsertSchema(materialsTable).omit({ id: true, createdAt: true });
export type InsertMaterial = z.infer<typeof insertMaterialSchema>;
export type Material = typeof materialsTable.$inferSelect;

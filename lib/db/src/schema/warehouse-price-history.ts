import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { warehouseItemsTable } from "./warehouse-items";
import {
  billingDocumentsTable,
  billingDocumentLinesTable,
} from "./billing-documents";
import { usersTable } from "./users";

/**
 * Legacy mutable purchase-price projection.
 *
 * One row per cost-document line records the latest supplier price pushed onto
 * a warehouse item. The current service may update or remove these rows while
 * reconciling a document, so this table must not be described or consumed as an
 * append-only accounting history. R13 correction flows fail closed when such a
 * row exists until a separate immutable, version-bound observation ledger is
 * available.
 *
 * Idempotence: a given cost-document line has at most one projection row via a
 * partial unique index. Manually recorded prices leave the line ID null and are
 * unconstrained.
 */
export const warehousePriceHistoryTable = pgTable(
  "warehouse_price_history",
  {
    id: serial("id").primaryKey(),
    warehouseItemId: integer("warehouse_item_id")
      .notNull()
      .references(() => warehouseItemsTable.id, { onDelete: "cascade" }),
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "set null" },
    ),
    billingDocumentLineId: integer("billing_document_line_id").references(
      () => billingDocumentLinesTable.id,
      { onDelete: "set null" },
    ),
    purchasePrice: numeric("purchase_price", {
      precision: 12,
      scale: 2,
    }).notNull(),
    currency: text("currency").notNull().default("CZK"),
    supplierName: text("supplier_name"),
    supplierIc: text("supplier_ic"),
    ean: text("ean"),
    supplierSku: text("supplier_sku"),
    documentNumber: text("document_number"),
    documentDate: timestamp("document_date"),
    note: text("note"),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("warehouse_price_history_item_id_idx").on(t.warehouseItemId),
    index("warehouse_price_history_billing_document_id_idx").on(
      t.billingDocumentId,
    ),
    // Idempotence key: one history row per cost-document line. Partial so manual
    // entries (null line) are unconstrained.
    uniqueIndex("warehouse_price_history_line_uq")
      .on(t.billingDocumentLineId)
      .where(sql`${t.billingDocumentLineId} is not null`),
  ],
);

export const insertWarehousePriceHistorySchema = createInsertSchema(
  warehousePriceHistoryTable,
).omit({ id: true, createdAt: true });
export type InsertWarehousePriceHistory = z.infer<
  typeof insertWarehousePriceHistorySchema
>;
export type WarehousePriceHistory =
  typeof warehousePriceHistoryTable.$inferSelect;

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
import { billingDocumentsTable } from "./billing-documents";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

/**
 * Skladové pohyby — the stock-movement ledger.
 *
 * Every receipt (příjem / naskladnění) and issue (výdej / odpis) is recorded
 * here as one immutable row. The ledger is APPEND-ONLY: corrections, storno and
 * un-approvals never delete a row — they append an opposite ("reversing")
 * movement. The current `warehouse_items.quantity` is always kept equal to the
 * signed sum of an item's movements (in − out), recomputed in the same
 * transaction that writes the movement while the item row is locked FOR UPDATE,
 * so two concurrent operations can never drift the quantity.
 *
 * direction:  in (receipt, +) | out (issue, −). `quantity` is always the
 *             positive magnitude; the sign comes from `direction`.
 * sourceType: billing_document_line | material | activity_material | manual
 *             For automatic movements `sourceId` is the originating row id
 *             (the cost-document line / job material / activity material). It is
 *             the key used to reconcile a source's net contribution to stock
 *             (so editing a quantity appends only the delta). Manual correction
 *             movements leave `sourceId` null.
 */
export const warehouseMovementsTable = pgTable(
  "warehouse_movements",
  {
    id: serial("id").primaryKey(),
    warehouseItemId: integer("warehouse_item_id")
      .notNull()
      .references(() => warehouseItemsTable.id, { onDelete: "cascade" }),
    direction: text("direction").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull(),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),

    // Provenance. `sourceId` is the generic key (line/material/activity-material
    // id) used to reconcile a source's net stock contribution; null for manual.
    sourceType: text("source_type").notNull().default("manual"),
    sourceId: integer("source_id"),

    // Filterable links. Set null on delete so reversed movements survive as
    // history (they net to zero) even after the document/job is removed.
    billingDocumentId: integer("billing_document_id").references(
      () => billingDocumentsTable.id,
      { onDelete: "set null" },
    ),
    jobId: integer("job_id").references(() => jobsTable.id, {
      onDelete: "set null",
    }),

    note: text("note"),
    // Optional client-generated idempotency key. If the same key is submitted
    // again for the same item, the handler returns the existing movement (409)
    // instead of inserting a duplicate. Null for automatic/system movements.
    idempotencyKey: text("idempotency_key"),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdByName: text("created_by_name"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("warehouse_movements_item_id_idx").on(t.warehouseItemId),
    index("warehouse_movements_source_idx").on(t.sourceType, t.sourceId),
    index("warehouse_movements_billing_document_id_idx").on(t.billingDocumentId),
    index("warehouse_movements_job_id_idx").on(t.jobId),
    index("warehouse_movements_created_at_idx").on(t.createdAt),
    // Partial unique index: non-null idempotency keys must be unique per item.
    uniqueIndex("warehouse_movements_idempotency_key_idx")
      .on(t.warehouseItemId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const insertWarehouseMovementSchema = createInsertSchema(
  warehouseMovementsTable,
).omit({ id: true, createdAt: true });
export type InsertWarehouseMovement = z.infer<
  typeof insertWarehouseMovementSchema
>;
export type WarehouseMovement = typeof warehouseMovementsTable.$inferSelect;

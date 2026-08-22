import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { activitiesTable } from "./activities";
import { invoiceLinesTable, invoicesTable } from "./invoices";
import { jobsTable } from "./jobs";
import { usersTable } from "./users";

/**
 * Operational-source settlement, deliberately separate from customer-facing
 * invoice lines. An allocation can point at a commercial line, but deleting or
 * merging that line only clears the optional pointer; the raw source survives.
 *
 * Draft lifecycle:
 *   reserved -> billed | included_in_lump_sum | not_charged | deferred
 *   reserved -> released (draft deleted)
 *   final     -> reversed (invoice cancelled)
 *
 * `invoiceIdSnapshot` keeps the audit identity after a deleted draft sets the
 * live FK to NULL. Historical backfills that cannot be proven are marked with
 * `legacyIncomplete` instead of inventing source facts.
 */
export const invoiceSourceAllocationsTable = pgTable(
  "invoice_source_allocations",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id").references(() => invoicesTable.id, {
      onDelete: "set null",
    }),
    invoiceIdSnapshot: integer("invoice_id_snapshot").notNull(),
    invoiceLineId: integer("invoice_line_id").references(
      () => invoiceLinesTable.id,
      { onDelete: "set null" },
    ),
    sourceType: text("source_type").notNull(),
    sourceId: integer("source_id").notNull(),
    jobId: integer("job_id").references(() => jobsTable.id, {
      onDelete: "set null",
    }),
    activityId: integer("activity_id").references(() => activitiesTable.id, {
      onDelete: "set null",
    }),
    sourceDescription: text("source_description").notNull(),
    sourceUnit: text("source_unit"),
    originalQuantity: numeric("original_quantity", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("1"),
    allocatedQuantity: numeric("allocated_quantity", {
      precision: 14,
      scale: 4,
    })
      .notNull()
      .default("1"),
    sourceAmountWithoutVat: numeric("source_amount_without_vat", {
      precision: 14,
      scale: 2,
    })
      .notNull()
      .default("0"),
    status: text("status").notNull().default("reserved"),
    settlementMethod: text("settlement_method").notNull().default("direct"),
    legacyIncomplete: boolean("legacy_incomplete").notNull().default(false),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    updatedByUserId: integer("updated_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    settledAt: timestamp("settled_at"),
    releasedAt: timestamp("released_at"),
    reversedAt: timestamp("reversed_at"),
  },
  (t) => [
    check(
      "invoice_source_allocations_status_check",
      sql`${t.status} IN ('reserved', 'billed', 'included_in_lump_sum', 'not_charged', 'deferred', 'released', 'reversed')`,
    ),
    check(
      "invoice_source_allocations_method_check",
      sql`${t.settlementMethod} IN ('direct', 'included_in_lump_sum', 'not_charged', 'deferred')`,
    ),
    check(
      "invoice_source_allocations_quantity_check",
      sql`${t.originalQuantity} >= 0 AND ${t.allocatedQuantity} >= 0 AND ${t.allocatedQuantity} <= ${t.originalQuantity}`,
    ),
    // Only one live invoice can reserve/finalise a concrete raw source. Deferred,
    // released and reversed rows deliberately do not block a later invoice.
    uniqueIndex("invoice_source_allocations_active_source_uq")
      .on(t.sourceType, t.sourceId)
      .where(
        sql`${t.status} IN ('reserved', 'billed', 'included_in_lump_sum', 'not_charged')`,
      ),
    index("invoice_source_allocations_invoice_idx").on(t.invoiceId),
    index("invoice_source_allocations_invoice_snapshot_idx").on(
      t.invoiceIdSnapshot,
    ),
    index("invoice_source_allocations_job_idx").on(t.jobId),
    index("invoice_source_allocations_activity_idx").on(t.activityId),
    index("invoice_source_allocations_line_idx").on(t.invoiceLineId),
  ],
);

export type InvoiceSourceAllocation =
  typeof invoiceSourceAllocationsTable.$inferSelect;

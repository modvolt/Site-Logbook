import { check, index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workSessionsTable } from "./work-sessions";
import { invoicesTable } from "./invoices";
import { usersTable } from "./users";

export const workSessionBillingLinksTable = pgTable("work_session_billing_links", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => workSessionsTable.id, { onDelete: "restrict" }),
  invoiceId: integer("invoice_id").references(() => invoicesTable.id, { onDelete: "set null" }),
  invoiceIdSnapshot: integer("invoice_id_snapshot").notNull(),
  status: text("status").notNull().default("reserved"),
  durationSecondsSnapshot: integer("duration_seconds_snapshot").notNull(),
  saleRateSnapshot: numeric("sale_rate_snapshot", { precision: 10, scale: 2 }).notNull(),
  amountWithoutVatSnapshot: numeric("amount_without_vat_snapshot", { precision: 12, scale: 2 }).notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  billedAt: timestamp("billed_at"),
  releasedAt: timestamp("released_at"),
  releasedByUserId: integer("released_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  releaseReason: text("release_reason"),
}, (table) => [
  check("work_session_billing_links_status_check", sql`${table.status} in ('reserved', 'billed', 'released')`),
  check("work_session_billing_links_values_check", sql`${table.durationSecondsSnapshot} <> 0 and ${table.saleRateSnapshot} >= 0`),
  uniqueIndex("work_session_billing_links_active_session_uq")
    .on(table.sessionId)
    .where(sql`${table.status} in ('reserved', 'billed')`),
  index("work_session_billing_links_invoice_idx").on(table.invoiceId),
  index("work_session_billing_links_session_idx").on(table.sessionId),
]);

export type WorkSessionBillingLink = typeof workSessionBillingLinksTable.$inferSelect;

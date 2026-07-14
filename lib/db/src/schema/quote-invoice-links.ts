import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { quotesTable } from "./quotes";
import { jobGroupsTable } from "./job-groups";
import { invoicesTable } from "./invoices";
import { usersTable } from "./users";

/**
 * Auditable quote billing lifecycle.
 *
 * The invoice FK is nullable so deleting a draft does not erase the historical
 * reservation record. invoiceIdSnapshot remains as the immutable diagnostic
 * reference. Only one reserved/billed invoice may exist for a quote at a time.
 */
export const quoteInvoiceLinksTable = pgTable(
  "quote_invoice_links",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "restrict" }),
    jobGroupId: integer("job_group_id").references(() => jobGroupsTable.id, {
      onDelete: "set null",
    }),
    invoiceId: integer("invoice_id").references(() => invoicesTable.id, {
      onDelete: "set null",
    }),
    invoiceIdSnapshot: integer("invoice_id_snapshot").notNull(),
    status: text("status").notNull().default("reserved"),
    createdByUserId: integer("created_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    billedAt: timestamp("billed_at"),
    releasedAt: timestamp("released_at"),
    releasedByUserId: integer("released_by_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    releaseReason: text("release_reason"),
  },
  (table) => [
    check(
      "quote_invoice_links_status_check",
      sql`${table.status} in ('reserved', 'billed', 'released')`,
    ),
    uniqueIndex("quote_invoice_links_active_quote_uq")
      .on(table.quoteId)
      .where(sql`${table.status} in ('reserved', 'billed')`),
    index("quote_invoice_links_invoice_idx").on(table.invoiceId),
    index("quote_invoice_links_quote_idx").on(table.quoteId),
    index("quote_invoice_links_job_group_idx").on(table.jobGroupId),
  ],
);

export type QuoteInvoiceLink = typeof quoteInvoiceLinksTable.$inferSelect;

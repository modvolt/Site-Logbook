import {
  pgTable,
  serial,
  integer,
  text,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { customersTable } from "./customers";
import { jobsTable } from "./jobs";

/**
 * Customer quotes (cenové nabídky) — offered before a job starts.
 *
 * Statuses: draft → sent → accepted | rejected | expired
 *
 * When a quote is accepted it can be converted to a job (convertedToJobId)
 * and optionally also to a draft invoice (convertedToInvoiceId).
 * The quote number is assigned from billing_settings.quote_number_next_seq
 * (transactionally, same pattern as invoice numbers).
 */
export const quotesTable = pgTable(
  "quotes",
  {
    id: serial("id").primaryKey(),
    quoteNumber: text("quote_number"),
    customerId: integer("customer_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    validUntil: text("valid_until"),
    notes: text("notes"),
    pdfObjectPath: text("pdf_object_path"),
    shareToken: text("share_token"),
    convertedToJobId: integer("converted_to_job_id").references(
      () => jobsTable.id,
      { onDelete: "set null" },
    ),
    convertedToInvoiceId: integer("converted_to_invoice_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("quotes_customer_idx").on(t.customerId)],
);

export type Quote = typeof quotesTable.$inferSelect;

export const quoteItemsTable = pgTable(
  "quote_items",
  {
    id: serial("id").primaryKey(),
    quoteId: integer("quote_id")
      .notNull()
      .references(() => quotesTable.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 4 })
      .notNull()
      .default("1"),
    unit: text("unit"),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("21"),
  },
  (t) => [index("quote_items_quote_idx").on(t.quoteId)],
);

export type QuoteItem = typeof quoteItemsTable.$inferSelect;

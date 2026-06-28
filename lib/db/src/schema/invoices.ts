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
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { usersTable } from "./users";
import { jobsTable } from "./jobs";
import { activitiesTable } from "./activities";
import { recurringInvoiceTemplatesTable } from "./recurring-invoice-templates";

/**
 * Issued (outgoing) customer invoices — "vydané faktury".
 *
 * Money is stored as numeric(12,2) (CZK with haléře). Dates that are calendar
 * days (issue / taxable-supply / due) are stored as ISO "YYYY-MM-DD" text, the
 * same convention as `jobs.date`; event timestamps (issuedAt, …) use timestamp.
 *
 * Supplier identity is read from `billing_settings`; the customer identity is
 * SNAPSHOTTED onto the invoice at issue time (customerName/Ic/Dic/Address) so an
 * issued invoice — a legal document — never silently changes when the customer
 * record is later edited or deleted.
 *
 * Statuses: draft | issued | sent | paid | cancelled.
 * Default VAT mode: standard | reverse_charge | zero | non_vat.
 */
export const invoicesTable = pgTable(
  "invoices",
  {
    id: serial("id").primaryKey(),
    invoiceNumber: text("invoice_number"),
    status: text("status").notNull().default("draft"),
    customerId: integer("customer_id").references(() => customersTable.id, {
      onDelete: "set null",
    }),
    // Snapshot of the customer at issue time (legal document immutability).
    customerName: text("customer_name"),
    customerIc: text("customer_ic"),
    customerDic: text("customer_dic"),
    customerAddress: text("customer_address"),
    customerEmail: text("customer_email"),
    issueDate: text("issue_date"),
    taxableSupplyDate: text("taxable_supply_date"),
    dueDate: text("due_date"),
    currency: text("currency").notNull().default("CZK"),
    paymentMethod: text("payment_method"),
    variableSymbol: text("variable_symbol"),
    constantSymbol: text("constant_symbol"),
    specificSymbol: text("specific_symbol"),
    vatModeDefault: text("vat_mode_default").notNull().default("standard"),
    subtotalWithoutVat: numeric("subtotal_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    totalVat: numeric("total_vat", { precision: 12, scale: 2 }).notNull().default("0"),
    totalWithVat: numeric("total_with_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    notes: text("notes"),
    // Payment record: when the customer actually paid (ISO "YYYY-MM-DD" calendar
    // day) and how much arrived. paidAmount supports partial payments and is
    // independent of status; both are filled on manual "mark paid" and (later)
    // by automatic bank-payment matching.
    paidDate: text("paid_date"),
    paidAmount: numeric("paid_amount", { precision: 12, scale: 2 }),
    pdfObjectPath: text("pdf_object_path"),
    isdocObjectPath: text("isdoc_object_path"),
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    issuedByUserId: integer("issued_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    issuedAt: timestamp("issued_at"),
    cancelledAt: timestamp("cancelled_at"),
    recurringTemplateId: integer("recurring_template_id").references(
      () => recurringInvoiceTemplatesTable.id,
      { onDelete: "set null" },
    ),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    // Multiple drafts have NULL invoice_number; Postgres treats NULLs as
    // distinct, so this unique index still guarantees no two *issued* invoices
    // share a number.
    uniqueIndex("invoices_invoice_number_unique").on(t.invoiceNumber),
    index("invoices_customer_id_idx").on(t.customerId),
    index("invoices_status_idx").on(t.status),
  ],
);

/**
 * Individual lines of an invoice. Totals are denormalized (computed from
 * quantity/unitPrice/discount/vat by the invoice service and persisted) so the
 * PDF and listings never have to re-derive money.
 *
 * sourceType: job | activity | material | billing_document_line | transport |
 *             parking | fine | manual
 * vatMode:    standard | reverse_charge | zero | non_vat
 * vatRate:    21 | 12 | 0 | null  (null for reverse_charge / non_vat)
 */
export const invoiceLinesTable = pgTable(
  "invoice_lines",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().default("manual"),
    sourceId: integer("source_id"),
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
    activityId: integer("activity_id").references(() => activitiesTable.id, {
      onDelete: "set null",
    }),
    description: text("description").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 2 }).notNull().default("1"),
    unit: text("unit"),
    unitPriceWithoutVat: numeric("unit_price_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    vatMode: text("vat_mode").notNull().default("standard"),
    totalWithoutVat: numeric("total_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    totalVat: numeric("total_vat", { precision: 12, scale: 2 }).notNull().default("0"),
    totalWithVat: numeric("total_with_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("invoice_lines_invoice_id_idx").on(t.invoiceId)],
);

/**
 * Links an invoice to the source jobs/activities it bills, with the billed
 * amount (without VAT) per source. Used to know which jobs an invoice covers
 * (to flip them to "vyfakturováno" on issue and back to "hotová" on storno) and
 * to prevent re-billing.
 */
export const invoiceSourceLinksTable = pgTable(
  "invoice_source_links",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
    activityId: integer("activity_id").references(() => activitiesTable.id, {
      onDelete: "set null",
    }),
    amountWithoutVat: numeric("amount_without_vat", { precision: 12, scale: 2 })
      .notNull()
      .default("0"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invoice_source_links_invoice_id_idx").on(t.invoiceId),
    index("invoice_source_links_job_id_idx").on(t.jobId),
    index("invoice_source_links_activity_id_idx").on(t.activityId),
  ],
);

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;

export const insertInvoiceLineSchema = createInsertSchema(invoiceLinesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertInvoiceLine = z.infer<typeof insertInvoiceLineSchema>;
export type InvoiceLine = typeof invoiceLinesTable.$inferSelect;

export type InvoiceSourceLink = typeof invoiceSourceLinksTable.$inferSelect;

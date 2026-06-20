import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { invoicesTable } from "./invoices";
import { usersTable } from "./users";

/**
 * Log of overdue-reminder ("upomínka") e-mails sent for an invoice. Each row is
 * one reminder that was actually dispatched. Used for two things:
 *
 *  1. Repeat protection for automatic reminders — an automatic reminder for a
 *     given day threshold (`threshold`) is sent at most once per invoice, so we
 *     never spam the customer if the scheduler runs repeatedly.
 *  2. An audit trail of when/where reminders went (also mirrored to audit_log).
 *
 * `auto` distinguishes scheduler-sent reminders (threshold set) from manual
 * one-click reminders (threshold null). `daysOverdue` is the actual overdue day
 * count at send time.
 */
export const invoiceRemindersTable = pgTable(
  "invoice_reminders",
  {
    id: serial("id").primaryKey(),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    // The configured day threshold that triggered an automatic reminder; null
    // for manual sends.
    threshold: integer("threshold"),
    // Actual whole days past due at the moment the reminder was sent.
    daysOverdue: integer("days_overdue").notNull().default(0),
    toEmail: text("to_email").notNull(),
    auto: boolean("auto").notNull().default(false),
    sentByUserId: integer("sent_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("invoice_reminders_invoice_id_idx").on(t.invoiceId),
    index("invoice_reminders_invoice_threshold_idx").on(t.invoiceId, t.threshold),
  ],
);

export type InvoiceReminder = typeof invoiceRemindersTable.$inferSelect;

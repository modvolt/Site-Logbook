import { pgTable, integer, text, boolean, timestamp, numeric } from "drizzle-orm/pg-core";

/**
 * Singleton (id = 1) configuration for the invoicing module: supplier identity
 * printed on invoices, bank details, default due days / payment method, the
 * invoice number series, and the default VAT mode.
 *
 * The number series is `numberPrefix` + year + zero-padded `numberNextSeq`
 * (default format FV{YYYY}{SEQ4} → "FV20260001"). Number assignment happens
 * transactionally inside the issue flow: the row is locked, the year is rolled
 * over (resetting the sequence) when it changes, the number is built, and
 * `numberNextSeq` is incremented — so two concurrent issues can never collide.
 */
export const billingSettingsTable = pgTable("billing_settings", {
  id: integer("id").primaryKey().default(1),
  // Supplier (dodavatel) — printed on every invoice.
  supplierName: text("supplier_name").notNull().default("Modvolt s.r.o."),
  supplierIc: text("supplier_ic"),
  supplierDic: text("supplier_dic"),
  supplierAddress: text("supplier_address"),
  supplierEmail: text("supplier_email"),
  supplierPhone: text("supplier_phone"),
  // Banking.
  bankAccount: text("bank_account"),
  iban: text("iban"),
  bic: text("bic"),
  // Invoice defaults.
  defaultDueDays: integer("default_due_days").notNull().default(14),
  defaultPaymentMethod: text("default_payment_method").notNull().default("bank"),
  vatPayer: boolean("vat_payer").notNull().default(true),
  vatModeDefault: text("vat_mode_default").notNull().default("standard"),
  invoiceFooterNote: text("invoice_footer_note"),
  // Default percent markup (marže) added to material unit prices when proposing
  // invoice lines. Applies ONLY to material lines (never práce/doprava/pokuty).
  // 0 = bill materials at purchase price 1:1. Overridable per invoice at create.
  materialMarkupPercent: numeric("material_markup_percent", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  // Operator-configurable margin warning threshold (in percent). The job-detail
  // warehouse margin alert fires when the cumulative margin drops below this
  // value. Default 0 = warn only on a negative margin; a positive floor (e.g. 5)
  // warns earlier, a negative value (e.g. -10) only on a deep loss.
  marginAlertThresholdPercent: numeric("margin_alert_threshold_percent", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  // Number series.
  numberPrefix: text("number_prefix").notNull().default("FV"),
  numberFormat: text("number_format").notNull().default("{PREFIX}{YYYY}{SEQ4}"),
  numberYear: integer("number_year"),
  numberNextSeq: integer("number_next_seq").notNull().default(1),
  // Overdue reminders (upomínky). When enabled, the server periodically sends a
  // polite reminder e-mail for each issued/sent invoice once it crosses one of
  // the configured day thresholds past its due date (comma-separated days, e.g.
  // "3,14,30"). Each threshold fires at most once per invoice (repeat
  // protection lives in invoice_reminders).
  reminderEnabled: boolean("reminder_enabled").notNull().default(false),
  reminderDays: text("reminder_days").notNull().default("3,14,30"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BillingSettings = typeof billingSettingsTable.$inferSelect;

import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const RECURRING_INTERVALS = ["monthly", "quarterly", "yearly"] as const;
export type RecurringInterval = (typeof RECURRING_INTERVALS)[number];

export interface RecurringTemplateItem {
  description: string;
  quantity: number;
  unit: string | null;
  unitPriceWithoutVat: number;
  vatRate: number | null;
  vatMode: string;
  discountPercent: number | null;
  sortOrder: number;
}

export const recurringInvoiceTemplatesTable = pgTable(
  "recurring_invoice_templates",
  {
    id: serial("id").primaryKey(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    items: jsonb("items").notNull().$type<RecurringTemplateItem[]>(),
    interval: text("interval").notNull().default("monthly"),
    dayOfMonth: integer("day_of_month").notNull().default(1),
    nextGenerationDate: text("next_generation_date").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    lastGeneratedAt: timestamp("last_generated_at"),
    notes: text("notes"),
    vatModeDefault: text("vat_mode_default").notNull().default("standard"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("rit_customer_id_idx").on(t.customerId),
    index("rit_next_generation_date_idx").on(t.nextGenerationDate),
    index("rit_is_active_idx").on(t.isActive),
  ],
);

export type RecurringInvoiceTemplate =
  typeof recurringInvoiceTemplatesTable.$inferSelect;
export type InsertRecurringInvoiceTemplate =
  typeof recurringInvoiceTemplatesTable.$inferInsert;

export const recurringInvoiceGenerationsTable = pgTable(
  "recurring_invoice_generations",
  {
    id: serial("id").primaryKey(),
    templateId: integer("template_id")
      .notNull()
      .references(() => recurringInvoiceTemplatesTable.id, {
        onDelete: "cascade",
      }),
    invoiceId: integer("invoice_id"),
    period: text("period").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("rig_template_id_idx").on(t.templateId),
    uniqueIndex("rig_template_period_success_udx")
      .on(t.templateId, t.period)
      .where(sql`${t.invoiceId} is not null`),
  ],
);

export type RecurringInvoiceGeneration =
  typeof recurringInvoiceGenerationsTable.$inferSelect;

export const recurringTemplateItemSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().positive(),
  unit: z.string().nullable(),
  unitPriceWithoutVat: z.number(),
  vatRate: z.number().nullable(),
  vatMode: z.string(),
  discountPercent: z.number().nullable(),
  sortOrder: z.number().int(),
});

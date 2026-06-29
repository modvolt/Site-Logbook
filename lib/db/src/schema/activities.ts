import { pgTable, serial, text, timestamp, numeric, integer, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { usersTable } from "./users";

export const activitiesTable = pgTable("activities", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  timerStartedAt: timestamp("timer_started_at"),
  hoursSpent: numeric("hours_spent", { precision: 7, scale: 2 }),
  completedAt: timestamp("completed_at"),
  isArchived: boolean("is_archived").notNull().default(false),
  fixedPrice: numeric("fixed_price", { precision: 12, scale: 2 }),
  hourlyRate: numeric("hourly_rate", { precision: 10, scale: 2 }),
  // Additive scaffold for future activity (long-term action) invoicing. Nullable
  // and unused by existing flows; the Fakturace core bills jobs, not activities.
  // null = not tracked; future values e.g. "billable" | "billed".
  billingStatus: text("billing_status"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  // Defense-in-depth, mirroring jobs.status: billing_status is free-text but
  // only NULL (not tracked) or the known intents are valid. "billed" is retained
  // for rows with a live invoice link; editable intents are billable/not_billable.
  check(
    "activities_billing_status_check",
    sql`${table.billingStatus} IS NULL OR ${table.billingStatus} IN ('billable', 'not_billable', 'billed')`,
  ),
]);

export const insertActivitySchema = createInsertSchema(activitiesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activitiesTable.$inferSelect;

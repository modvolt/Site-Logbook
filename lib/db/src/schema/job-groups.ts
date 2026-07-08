import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const jobGroupsTable = pgTable("job_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  address: text("address"),
  notes: text("notes"),
  status: text("status").notNull().default("open"),
  dateFrom: text("date_from"),
  dateTo: text("date_to"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("job_groups_customer_id_idx").on(table.customerId),
  index("job_groups_status_idx").on(table.status),
]);

export const insertJobGroupSchema = createInsertSchema(jobGroupsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJobGroup = z.infer<typeof insertJobGroupSchema>;
export type JobGroup = typeof jobGroupsTable.$inferSelect;

import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const customerContactsTable = pgTable("customer_contacts", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role"),
  phone: text("phone"),
  email: text("email"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCustomerContactSchema = createInsertSchema(customerContactsTable).omit({ id: true, createdAt: true });
export type InsertCustomerContact = z.infer<typeof insertCustomerContactSchema>;
export type CustomerContact = typeof customerContactsTable.$inferSelect;

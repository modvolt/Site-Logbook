import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";

export const customerSitesTable = pgTable("customer_sites", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address"),
  contactPerson: text("contact_person"),
  phone: text("phone"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCustomerSiteSchema = createInsertSchema(customerSitesTable).omit({ id: true, createdAt: true });
export type InsertCustomerSite = z.infer<typeof insertCustomerSiteSchema>;
export type CustomerSite = typeof customerSitesTable.$inferSelect;

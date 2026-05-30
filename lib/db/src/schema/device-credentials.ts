import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { customerSitesTable } from "./customer-sites";

export const deviceCredentialsTable = pgTable("device_credentials", {
  id: serial("id").primaryKey(),
  customerId: integer("customer_id")
    .notNull()
    .references(() => customersTable.id, { onDelete: "cascade" }),
  siteId: integer("site_id").references(() => customerSitesTable.id, {
    onDelete: "set null",
  }),
  type: text("type"),
  serialNumber: text("serial_number"),
  username: text("username"),
  password: text("password"),
  email: text("email"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDeviceCredentialSchema = createInsertSchema(
  deviceCredentialsTable,
).omit({ id: true, createdAt: true });
export type InsertDeviceCredential = z.infer<typeof insertDeviceCredentialSchema>;
export type DeviceCredential = typeof deviceCredentialsTable.$inferSelect;

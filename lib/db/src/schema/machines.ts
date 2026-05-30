import { pgTable, serial, text, date, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const machinesTable = pgTable("machines", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type"),
  manufacturer: text("manufacturer"),
  serialNumber: text("serial_number"),
  purchaseDate: date("purchase_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMachineSchema = createInsertSchema(machinesTable).omit({ id: true, createdAt: true });
export type InsertMachine = z.infer<typeof insertMachineSchema>;
export type Machine = typeof machinesTable.$inferSelect;

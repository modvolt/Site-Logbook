import { pgTable, serial, text, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const warehouseItemsTable = pgTable("warehouse_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code"),
  category: text("category"),
  quantity: numeric("quantity", { precision: 10, scale: 2 }).notNull().default("0"),
  unit: text("unit"),
  purchasePrice: numeric("purchase_price", { precision: 10, scale: 2 }),
  salePrice: numeric("sale_price", { precision: 10, scale: 2 }),
  minQuantity: numeric("min_quantity", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWarehouseItemSchema = createInsertSchema(warehouseItemsTable).omit({ id: true, createdAt: true });
export type InsertWarehouseItem = z.infer<typeof insertWarehouseItemSchema>;
export type WarehouseItem = typeof warehouseItemsTable.$inferSelect;

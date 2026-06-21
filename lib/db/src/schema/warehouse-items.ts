import { pgTable, serial, text, numeric, timestamp, index } from "drizzle-orm/pg-core";
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
  // Supplier catalogue identification — populated when an approved cost document
  // pushes its prices onto the item, so future invoices/delivery notes can be
  // matched back by EAN / supplier SKU before falling back to the name. All
  // additive/nullable; `code` (legacy combined SKU/EAN) is kept untouched.
  ean: text("ean"),
  supplierSku: text("supplier_sku"),
  supplierName: text("supplier_name"),
  supplierIc: text("supplier_ic"),
  manufacturer: text("manufacturer"),
  // Lower-cased, punctuation-free name for name-based matching (mirrors
  // normalizeItemName in reference-extractor.ts).
  normalizedName: text("normalized_name"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("warehouse_items_ean_idx").on(t.ean),
  index("warehouse_items_supplier_sku_idx").on(t.supplierSku),
  index("warehouse_items_normalized_name_idx").on(t.normalizedName),
]);

export const insertWarehouseItemSchema = createInsertSchema(warehouseItemsTable).omit({ id: true, createdAt: true });
export type InsertWarehouseItem = z.infer<typeof insertWarehouseItemSchema>;
export type WarehouseItem = typeof warehouseItemsTable.$inferSelect;

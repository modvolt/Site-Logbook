import { pgTable, serial, text, numeric, boolean, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { activitiesTable } from "./activities";
import { warehouseItemsTable } from "./warehouse-items";

export const activityMaterialsTable = pgTable("activity_materials", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id").notNull().references(() => activitiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }),
  unit: text("unit"),
  pricePerUnit: numeric("price_per_unit", { precision: 10, scale: 2 }),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  // Stable FK to the matched warehouse card. Nullable; name stays as description.
  warehouseItemId: integer("warehouse_item_id").references(
    () => warehouseItemsTable.id,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("activity_materials_source_uq")
    .on(t.sourceType, t.sourceId)
    .where(sql`${t.sourceType} is not null`),
]);

export const insertActivityMaterialSchema = createInsertSchema(activityMaterialsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivityMaterial = z.infer<typeof insertActivityMaterialSchema>;
export type ActivityMaterial = typeof activityMaterialsTable.$inferSelect;

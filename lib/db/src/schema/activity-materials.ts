import { pgTable, serial, text, numeric, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { activitiesTable } from "./activities";

export const activityMaterialsTable = pgTable("activity_materials", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id").notNull().references(() => activitiesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }),
  unit: text("unit"),
  pricePerUnit: numeric("price_per_unit", { precision: 10, scale: 2 }),
  receiptUrl: text("receipt_url"),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertActivityMaterialSchema = createInsertSchema(activityMaterialsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivityMaterial = z.infer<typeof insertActivityMaterialSchema>;
export type ActivityMaterial = typeof activityMaterialsTable.$inferSelect;

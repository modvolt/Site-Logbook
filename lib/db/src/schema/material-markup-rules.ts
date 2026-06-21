import { pgTable, serial, text, numeric, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Per-category material markup defaults. A job material's "type" is resolved
 * from the catalogue (warehouse item) it matches by name; the matching
 * warehouse item's `category` is looked up here for its default markup percent.
 *
 * This is the "category default" layer of the markup resolution chain:
 *   per-line override → category default → invoice default → settings default.
 * When no rule matches a material's category, resolution falls through to the
 * single global markup, so the feature degrades cleanly to the prior behaviour.
 */
export const materialMarkupRulesTable = pgTable("material_markup_rules", {
  id: serial("id").primaryKey(),
  // Warehouse-item category this rule applies to. Stored verbatim; matched
  // case-insensitively against the catalogue category.
  category: text("category").notNull(),
  markupPercent: numeric("markup_percent", { precision: 6, scale: 2 })
    .notNull()
    .default("0"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("material_markup_rules_category_uq").on(sql`lower(${t.category})`),
]);

export const insertMaterialMarkupRuleSchema = createInsertSchema(materialMarkupRulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertMaterialMarkupRule = z.infer<typeof insertMaterialMarkupRuleSchema>;
export type MaterialMarkupRule = typeof materialMarkupRulesTable.$inferSelect;

import { pgTable, serial, text, numeric, boolean, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";

export const materialsTable = pgTable("materials", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id").notNull().references(() => jobsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  quantity: numeric("quantity", { precision: 10, scale: 2 }),
  unit: text("unit"),
  pricePerUnit: numeric("price_per_unit", { precision: 10, scale: 2 }),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  // Provenance: when a material row was propagated from an approved cost
  // document line, these point back at it so the sync is idempotent (re-approve
  // / edit updates the same row instead of duplicating). Manually-added
  // materials leave both null. Mirrors invoice_lines.source_type/source_id.
  // sourceType is currently only "billing_document_line".
  sourceType: text("source_type"),
  sourceId: integer("source_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  // A cost-document line maps to at most one job material. Partial unique index
  // (manual materials have a null source and are unconstrained) — guards against
  // duplicate propagation if two approves race.
  uniqueIndex("materials_source_uq").on(t.sourceType, t.sourceId).where(sql`${t.sourceType} is not null`),
]);

export const insertMaterialSchema = createInsertSchema(materialsTable).omit({ id: true, createdAt: true });
export type InsertMaterial = z.infer<typeof insertMaterialSchema>;
export type Material = typeof materialsTable.$inferSelect;

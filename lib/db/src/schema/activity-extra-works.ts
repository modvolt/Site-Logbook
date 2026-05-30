import { pgTable, serial, text, numeric, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { activitiesTable } from "./activities";

export const activityExtraWorksTable = pgTable("activity_extra_works", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id").notNull().references(() => activitiesTable.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  note: text("note"),
  hours: numeric("hours", { precision: 10, scale: 2 }),
  amount: numeric("amount", { precision: 10, scale: 2 }),
  done: boolean("done").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertActivityExtraWorkSchema = createInsertSchema(activityExtraWorksTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivityExtraWork = z.infer<typeof insertActivityExtraWorkSchema>;
export type ActivityExtraWork = typeof activityExtraWorksTable.$inferSelect;

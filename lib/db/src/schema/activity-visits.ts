import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { activitiesTable } from "./activities";
import { peopleTable } from "./people";

export const activityVisitsTable = pgTable("activity_visits", {
  id: serial("id").primaryKey(),
  activityId: integer("activity_id")
    .notNull()
    .references(() => activitiesTable.id, { onDelete: "cascade" }),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  timeFrom: text("time_from"),
  timeTo: text("time_to"),
  status: text("status").notNull().default("planned"),
  note: text("note"),
  nextStep: text("next_step"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  createdBy: text("created_by"),
});

export const insertActivityVisitSchema = createInsertSchema(activityVisitsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertActivityVisit = z.infer<typeof insertActivityVisitSchema>;
export type ActivityVisit = typeof activityVisitsTable.$inferSelect;

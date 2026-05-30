import { pgTable, serial, integer, numeric, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";
import { jobsTable } from "./jobs";
import { activitiesTable } from "./activities";

export const timeEntriesTable = pgTable(
  "time_entries",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => peopleTable.id, { onDelete: "cascade" }),
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "cascade" }),
    activityId: integer("activity_id").references(() => activitiesTable.id, { onDelete: "cascade" }),
    hours: numeric("hours", { precision: 7, scale: 2 }).notNull().default("0"),
    timerStartedAt: timestamp("timer_started_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    unique("time_entries_person_job_unique").on(t.personId, t.jobId),
    unique("time_entries_person_activity_unique").on(t.personId, t.activityId),
  ],
);

export const insertTimeEntrySchema = createInsertSchema(timeEntriesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTimeEntry = z.infer<typeof insertTimeEntrySchema>;
export type TimeEntry = typeof timeEntriesTable.$inferSelect;

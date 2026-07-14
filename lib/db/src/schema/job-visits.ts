import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { peopleTable } from "./people";

export const jobVisitsTable = pgTable("job_visits", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  note: text("note"),
  status: text("status").notNull().default("planned"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("job_visits_date_idx").on(table.date),
  index("job_visits_job_date_idx").on(table.jobId, table.date),
]);

export const insertJobVisitSchema = createInsertSchema(jobVisitsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertJobVisit = z.infer<typeof insertJobVisitSchema>;
export type JobVisit = typeof jobVisitsTable.$inferSelect;

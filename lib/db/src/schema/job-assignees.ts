import { pgTable, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { peopleTable } from "./people";

// Additional workers assigned to a job, beyond the primary jobs.assignedPersonId
// (which stays authoritative for calendar scheduling and leave conflict checks).
// This is a plain many-to-many join: a job can have any number of additional
// assignees, and a person can be an additional assignee on many jobs.
export const jobAssigneesTable = pgTable("job_assignees", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id, { onDelete: "cascade" }),
  personId: integer("person_id")
    .notNull()
    .references(() => peopleTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  unique("job_assignees_job_id_person_id_unique").on(table.jobId, table.personId),
]);

export const insertJobAssigneeSchema = createInsertSchema(jobAssigneesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertJobAssignee = z.infer<typeof insertJobAssigneeSchema>;
export type JobAssignee = typeof jobAssigneesTable.$inferSelect;

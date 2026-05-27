import { pgTable, serial, text, timestamp, numeric, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  type: text("type").notNull().default("other"),
  clientSite: text("client_site"),
  date: text("date").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  status: text("status").notNull().default("planned"),
  assignedPersonId: integer("assigned_person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  hoursSpent: numeric("hours_spent", { precision: 5, scale: 2 }),
  price: numeric("price", { precision: 10, scale: 2 }),
  transportKm: numeric("transport_km", { precision: 7, scale: 2 }),
  transportCost: numeric("transport_cost", { precision: 10, scale: 2 }),
  fines: numeric("fines", { precision: 10, scale: 2 }),
  parking: numeric("parking", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;

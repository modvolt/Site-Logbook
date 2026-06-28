import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";

export const LEAVE_TYPES = ["vacation", "sick", "other"] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

export const employeeLeavesTable = pgTable("employee_leaves", {
  id: serial("id").primaryKey(),
  personId: integer("person_id")
    .notNull()
    .references(() => peopleTable.id, { onDelete: "cascade" }),
  type: text("type").$type<LeaveType>().notNull().default("vacation"),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEmployeeLeaveSchema = createInsertSchema(employeeLeavesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertEmployeeLeave = z.infer<typeof insertEmployeeLeaveSchema>;
export type EmployeeLeave = typeof employeeLeavesTable.$inferSelect;

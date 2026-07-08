import { pgTable, serial, text, timestamp, numeric, integer, boolean, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";
import { customersTable } from "./customers";
import { jobGroupsTable } from "./job-groups";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  shortName: text("short_name"),
  type: text("type").notNull().default("other"),
  clientSite: text("client_site"),
  date: text("date").notNull(),
  startTime: text("start_time"),
  endTime: text("end_time"),
  status: text("status").notNull().default("planned"),
  assignedPersonId: integer("assigned_person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "set null" }),
  groupId: integer("group_id").references(() => jobGroupsTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  hoursSpent: numeric("hours_spent", { precision: 5, scale: 2 }),
  hoursFromPlan: boolean("hours_from_plan").notNull().default(false),
  hoursBeforePlan: numeric("hours_before_plan", { precision: 5, scale: 2 }),
  hoursVasek: numeric("hours_vasek", { precision: 5, scale: 2 }),
  hoursJonas: numeric("hours_jonas", { precision: 5, scale: 2 }),
  price: numeric("price", { precision: 10, scale: 2 }),
  transportKm: numeric("transport_km", { precision: 7, scale: 2 }),
  transportCost: numeric("transport_cost", { precision: 10, scale: 2 }),
  fines: numeric("fines", { precision: 10, scale: 2 }),
  parking: numeric("parking", { precision: 10, scale: 2 }),
  address: text("address"),
  recurrenceIntervalDays: integer("recurrence_interval_days"),
  timerStartedAt: timestamp("timer_started_at"),
  sortOrder: integer("sort_order").notNull().default(0),
  // Billing mode: 'time_material' (default) bills materials + job price normally;
  // 'fixed_price' bills a single agreed-upon line at contractPrice instead.
  pricingMode: text("pricing_mode").notNull().default("time_material"),
  // The agreed-upon fixed price for the job (only used when pricingMode = 'fixed_price').
  contractPrice: numeric("contract_price", { precision: 10, scale: 2 }),
  jobNumber: integer("job_number").unique(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // Customer digital-signature handover protocol
  signatureToken: text("signature_token"),
  signatureTokenExpiresAt: timestamp("signature_token_expires_at"),
  signatureRequestedAt: timestamp("signature_requested_at"),
  signedAt: timestamp("signed_at"),
  signatureObjectPath: text("signature_object_path"),
}, (table) => [
  // Defense-in-depth: jobs.status is free-text, but only this known set is valid.
  // The client-facing lifecycle is planned/in_progress/done/cancelled; the
  // server-only "vyfakturovano" (invoiced) is set directly by the invoice issue
  // flow (and reverted to "done" on storno). A DB CHECK guarantees no raw SQL,
  // future endpoint, or migration mistake can write a phantom status.
  check(
    "jobs_status_check",
    sql`${table.status} IN ('planned', 'in_progress', 'done', 'cancelled', 'vyfakturovano')`,
  ),
  index("jobs_group_id_idx").on(table.groupId),
]);

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;

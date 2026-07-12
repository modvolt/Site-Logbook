import {
  pgTable,
  serial,
  integer,
  numeric,
  text,
  timestamp,
  jsonb,
  check,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { peopleTable } from "./people";
import { jobsTable } from "./jobs";
import { activitiesTable } from "./activities";
import { usersTable } from "./users";
import { personHourlyRatesTable } from "./person-hourly-rates";

export const workSessionsTable = pgTable(
  "work_sessions",
  {
    id: serial("id").primaryKey(),
    personId: integer("person_id")
      .notNull()
      .references(() => peopleTable.id, { onDelete: "restrict" }),
    parentType: text("parent_type").notNull(),
    parentIdSnapshot: integer("parent_id_snapshot").notNull(),
    jobId: integer("job_id").references(() => jobsTable.id, { onDelete: "set null" }),
    activityId: integer("activity_id").references(() => activitiesTable.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),
    status: text("status").notNull().default("active"),
    source: text("source").notNull().default("timer"),
    reviewStatus: text("review_status").notNull().default("not_required"),
    reviewReason: text("review_reason"),
    reviewFlaggedAt: timestamp("review_flagged_at"),
    note: text("note"),
    idempotencyKey: text("idempotency_key"),
    stopIdempotencyKey: text("stop_idempotency_key"),
    hourlyRateId: integer("hourly_rate_id").references(() => personHourlyRatesTable.id, { onDelete: "set null" }),
    costRateSnapshot: numeric("cost_rate_snapshot", { precision: 10, scale: 2 }),
    saleRateSnapshot: numeric("sale_rate_snapshot", { precision: 10, scale: 2 }),
    billingStatus: text("billing_status").notNull().default("unbilled"),
    nonBillableReason: text("non_billable_reason"),
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    endedByUserId: integer("ended_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    voidedAt: timestamp("voided_at"),
    voidedByUserId: integer("voided_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "work_sessions_parent_check",
      sql`(${table.parentType} = 'job' and ${table.activityId} is null and (${table.jobId} is null or ${table.jobId} = ${table.parentIdSnapshot}))
          or (${table.parentType} = 'activity' and ${table.jobId} is null and (${table.activityId} is null or ${table.activityId} = ${table.parentIdSnapshot}))`,
    ),
    check(
      "work_sessions_status_check",
      sql`${table.status} in ('active', 'completed', 'voided')`,
    ),
    check(
      "work_sessions_source_check",
      sql`${table.source} in ('timer', 'manual', 'correction', 'legacy_manual', 'legacy_timer')`,
    ),
    check(
      "work_sessions_review_status_check",
      sql`${table.reviewStatus} in ('not_required', 'needs_review', 'approved')`,
    ),
    check(
      "work_sessions_state_check",
      sql`(${table.status} = 'active' and ${table.endedAt} is null and ${table.durationSeconds} is null and ${table.voidedAt} is null)
          or (${table.status} = 'completed' and ${table.endedAt} is not null and ${table.durationSeconds} is not null and ${table.voidedAt} is null)
          or (${table.status} = 'voided' and ${table.voidedAt} is not null)`,
    ),
    check(
      "work_sessions_duration_check",
      sql`${table.source} = 'correction' or ${table.durationSeconds} is null or ${table.durationSeconds} >= 0`,
    ),
    check(
      "work_sessions_billing_status_check",
      sql`${table.billingStatus} in ('unbilled', 'ready', 'billed', 'non_billable')`,
    ),
    uniqueIndex("work_sessions_one_active_person_uq")
      .on(table.personId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("work_sessions_idempotency_key_uq")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    uniqueIndex("work_sessions_stop_idempotency_key_uq")
      .on(table.stopIdempotencyKey)
      .where(sql`${table.stopIdempotencyKey} is not null`),
    index("work_sessions_job_id_idx").on(table.jobId),
    index("work_sessions_activity_id_idx").on(table.activityId),
    index("work_sessions_person_started_idx").on(table.personId, table.startedAt),
  ],
);

export const workSessionBreaksTable = pgTable(
  "work_session_breaks",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => workSessionsTable.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at").notNull(),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),
    createdByUserId: integer("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    endedByUserId: integer("ended_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    check(
      "work_session_breaks_state_check",
      sql`(${table.endedAt} is null and ${table.durationSeconds} is null)
          or (${table.endedAt} is not null and ${table.durationSeconds} is not null and ${table.durationSeconds} >= 0)`,
    ),
    uniqueIndex("work_session_breaks_one_active_uq")
      .on(table.sessionId)
      .where(sql`${table.endedAt} is null`),
    index("work_session_breaks_session_id_idx").on(table.sessionId),
  ],
);

export const workSessionEventsTable = pgTable(
  "work_session_events",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => workSessionsTable.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (table) => [
    check(
      "work_session_events_type_check",
      sql`${table.eventType} in ('started', 'stopped', 'manual_created', 'manual_adjusted', 'break_started', 'break_stopped', 'voided', 'review_flagged', 'legacy_imported')`,
    ),
    index("work_session_events_session_id_idx").on(table.sessionId),
    index("work_session_events_occurred_at_idx").on(table.occurredAt),
  ],
);

export type WorkSession = typeof workSessionsTable.$inferSelect;
export type WorkSessionBreak = typeof workSessionBreaksTable.$inferSelect;
export type WorkSessionEvent = typeof workSessionEventsTable.$inferSelect;

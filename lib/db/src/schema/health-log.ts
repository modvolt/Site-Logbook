import { pgTable, serial, boolean, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Stores the result of each internal watchdog check (every 5 minutes).
 * Retention: rows older than 48 h are purged by the daily cron.
 */
export const healthLogTable = pgTable("health_log", {
  id: serial("id").primaryKey(),
  checkedAt: timestamp("checked_at").notNull().defaultNow(),
  dbOk: boolean("db_ok").notNull(),
  dbLatencyMs: integer("db_latency_ms"),
  s3Ok: boolean("s3_ok").notNull(),
  smtpOk: boolean("smtp_ok").notNull(),
  overallStatus: text("overall_status").notNull().default("ok"), // ok | degraded
});

export type HealthLog = typeof healthLogTable.$inferSelect;

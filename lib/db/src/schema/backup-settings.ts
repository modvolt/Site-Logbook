import { pgTable, integer, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton (id=1) configuration for the weekly backup restore-test scheduler.
 * If no row exists, the scheduler falls back to environment-variable defaults
 * (BACKUP_RESTORE_TEST_DAY_OF_WEEK, BACKUP_RESTORE_NOTIFY_EMAIL).
 */
export const backupSettingsTable = pgTable("backup_settings", {
  id: integer("id").primaryKey().default(1),
  // Day of the week to run the automatic restore test (0=Sunday … 6=Saturday).
  // null means the scheduled restore test is disabled.
  restoreTestDayOfWeek: integer("restore_test_day_of_week"),
  // E-mail address to notify when an automatic restore test fails.
  // Falls back to all admin/master users when null.
  restoreNotifyEmail: text("restore_notify_email"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BackupSettings = typeof backupSettingsTable.$inferSelect;

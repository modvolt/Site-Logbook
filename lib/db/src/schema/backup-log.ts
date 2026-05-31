import { pgTable, serial, text, bigint, timestamp } from "drizzle-orm/pg-core";

/**
 * Record of every database backup attempt (manual or scheduled). The backup
 * file itself lives in object storage (never in the database) — this table only
 * tracks metadata so the admin UI can list backups, show the last successful
 * one, and offer a download. A "running" row is flipped to "success" or
 * "failed" when the dump completes.
 */
export const backupLogTable = pgTable("backup_log", {
  id: serial("id").primaryKey(),
  filename: text("filename").notNull(),
  // Backend-agnostic object path ("/objects/backups/<file>"); null until upload.
  objectPath: text("object_path"),
  sizeBytes: bigint("size_bytes", { mode: "number" }),
  status: text("status").notNull().default("running"), // running | success | failed
  trigger: text("trigger").notNull().default("manual"), // manual | auto
  error: text("error"),
  createdBy: text("created_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type BackupLog = typeof backupLogTable.$inferSelect;

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const objectUploadsTable = pgTable(
  "object_uploads",
  {
    objectPath: text("object_path").primaryKey(),
    uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    originalName: text("original_name").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    state: text("state").notNull().default("pending"),
    scannerStatus: text("scanner_status").notNull().default("pending"),
    claimType: text("claim_type"),
    claimId: text("claim_id"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    storedAt: timestamp("stored_at"),
    claimedAt: timestamp("claimed_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("object_uploads_state_created_idx").on(table.state, table.createdAt),
    index("object_uploads_sha256_idx").on(table.sha256),
    check(
      "object_uploads_state_chk",
      sql`${table.state} in ('pending', 'stored', 'claimed', 'quarantined', 'failed', 'delete_pending', 'deleted')`,
    ),
    check(
      "object_uploads_scanner_status_chk",
      sql`${table.scannerStatus} in ('pending', 'content_validated', 'clean', 'malicious', 'unavailable')`,
    ),
    check("object_uploads_size_chk", sql`${table.sizeBytes} > 0`),
  ],
);

export type ObjectUpload = typeof objectUploadsTable.$inferSelect;

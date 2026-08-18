import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const apiIdempotencyRecordsTable = pgTable(
  "api_idempotency_records",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    offlineScope: text("offline_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull(),
    state: text("state").notNull().default("pending"),
    responseStatus: integer("response_status"),
    responseContentType: text("response_content_type"),
    responseBody: jsonb("response_body"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("api_idempotency_scope_key_uq").on(
      table.userId,
      table.offlineScope,
      table.method,
      table.path,
      table.idempotencyKey,
    ),
    index("api_idempotency_created_idx").on(table.createdAt),
    check(
      "api_idempotency_state_chk",
      sql`${table.state} in ('pending', 'completed', 'ambiguous')`,
    ),
  ],
);

export type ApiIdempotencyRecord = typeof apiIdempotencyRecordsTable.$inferSelect;

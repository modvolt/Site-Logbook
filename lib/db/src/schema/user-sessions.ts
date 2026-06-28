import { pgTable, varchar, json, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const userSessionsTable = pgTable(
  "user_sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: json("sess").notNull(),
    expire: timestamp("expire", { precision: 6 }).notNull(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
    ipAddress: varchar("ip_address", { length: 45 }),
    userAgent: varchar("user_agent", { length: 500 }),
    lastActiveAt: timestamp("last_active_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => [
    index("user_sessions_user_id_idx").on(t.userId),
    index("user_sessions_expire_idx").on(t.expire),
  ],
);

export type UserSession = typeof userSessionsTable.$inferSelect;

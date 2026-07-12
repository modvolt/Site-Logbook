import { pgTable, integer, text, timestamp, primaryKey, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

export const userPermissionOverridesTable = pgTable(
  "user_permission_overrides",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    effect: text("effect").notNull(),
    updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.permission] }),
    index("user_permission_overrides_user_id_idx").on(table.userId),
    check("user_permission_overrides_effect_check", sql`${table.effect} in ('allow', 'deny')`),
  ],
);

export type UserPermissionOverride = typeof userPermissionOverridesTable.$inferSelect;

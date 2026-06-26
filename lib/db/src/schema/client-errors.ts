import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const clientErrorsTable = pgTable("client_errors", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userRole: text("user_role"),
  message: text("message").notNull(),
  stack: text("stack"),
  componentStack: text("component_stack"),
  path: text("path"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type ClientError = typeof clientErrorsTable.$inferSelect;

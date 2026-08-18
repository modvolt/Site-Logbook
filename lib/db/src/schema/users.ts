import { pgTable, serial, text, timestamp, boolean, integer, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { peopleTable } from "./people";

export const USER_ROLES = ["guest", "master", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ACCOUNT_TYPES = ["internal", "external"] as const;
export type UserAccountType = (typeof USER_ACCOUNT_TYPES)[number];

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  personId: integer("person_id").references(() => peopleTable.id, { onDelete: "set null" }),
  email: text("email"),
  role: text("role").notNull().default("guest"),
  accountType: text("account_type").notNull().default("internal"),
  isActive: boolean("is_active").notNull().default(true),
  sessionGeneration: integer("session_generation").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("users_person_id_uq").on(table.personId).where(sql`${table.personId} is not null`),
  check(
    "users_account_type_chk",
    sql`${table.accountType} in ('internal', 'external')`,
  ),
  check(
    "users_external_identity_shape_chk",
    sql`${table.accountType} = 'internal' or (${table.role} = 'guest' and ${table.personId} is null)`,
  ),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

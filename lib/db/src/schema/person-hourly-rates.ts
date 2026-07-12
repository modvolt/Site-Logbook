import { check, date, index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { peopleTable } from "./people";
import { usersTable } from "./users";

export const personHourlyRatesTable = pgTable("person_hourly_rates", {
  id: serial("id").primaryKey(),
  personId: integer("person_id").notNull().references(() => peopleTable.id, { onDelete: "restrict" }),
  validFrom: date("valid_from").notNull(),
  validTo: date("valid_to"),
  costRate: numeric("cost_rate", { precision: 10, scale: 2 }).notNull(),
  saleRate: numeric("sale_rate", { precision: 10, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  voidedAt: timestamp("voided_at"),
  voidedByUserId: integer("voided_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  voidReason: text("void_reason"),
}, (table) => [
  check("person_hourly_rates_values_check", sql`${table.costRate} >= 0 and ${table.saleRate} >= 0`),
  check("person_hourly_rates_range_check", sql`${table.validTo} is null or ${table.validTo} >= ${table.validFrom}`),
  uniqueIndex("person_hourly_rates_person_from_active_uq")
    .on(table.personId, table.validFrom)
    .where(sql`${table.voidedAt} is null`),
  index("person_hourly_rates_person_period_idx").on(table.personId, table.validFrom, table.validTo),
]);

export type PersonHourlyRate = typeof personHourlyRatesTable.$inferSelect;

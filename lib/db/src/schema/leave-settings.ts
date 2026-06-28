import { pgTable, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Singleton (id = 1) configurable annual leave caps per leave type.
 * These are data-entry guards — the API rejects any create/update that would
 * push a person's total days of a given type over the cap for the calendar
 * year.  Defaults reflect generous-but-sane values suitable for most Czech
 * construction companies (25 vacation / 60 sick / 30 other per person/year).
 * Admins can raise or lower the caps from Settings without redeploying.
 */
export const leaveSettingsTable = pgTable("leave_settings", {
  id: integer("id").primaryKey().default(1),
  vacationYearlyCap: integer("vacation_yearly_cap").notNull().default(25),
  sickYearlyCap: integer("sick_yearly_cap").notNull().default(60),
  otherYearlyCap: integer("other_yearly_cap").notNull().default(30),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type LeaveSettings = typeof leaveSettingsTable.$inferSelect;

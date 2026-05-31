import { pgTable, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * Application-wide outgoing e-mail (SMTP / Gmail) configuration. Stored as a
 * single row (id = 1) so it can be edited from the Settings UI in production
 * without changing environment variables or redeploying. When no row exists or
 * `enabled` is false, the e-mail sender falls back to the SMTP_* env vars.
 *
 * Note: the password / app-password is stored as plaintext, consistent with the
 * existing device-credential vault. It is never returned by the API (write-only).
 */
export const emailSettingsTable = pgTable("email_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  host: text("host"),
  port: integer("port").notNull().default(587),
  secure: boolean("secure").notNull().default(false),
  username: text("username"),
  password: text("password"),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type EmailSettings = typeof emailSettingsTable.$inferSelect;

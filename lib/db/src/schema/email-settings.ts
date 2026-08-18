import { pgTable, integer, text, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Application-wide outgoing e-mail (SMTP / Gmail) configuration. Stored as a
 * single row (id = 1) so it can be edited from the Settings UI in production
 * without changing environment variables or redeploying. When no row exists or
 * `enabled` is false, the e-mail sender falls back to the SMTP_* env vars.
 *
 * The password is write-only at the API and new values use the externally keyed
 * versioned envelope. `password` remains only for migration-time legacy reads.
 */
export const emailSettingsTable = pgTable("email_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  host: text("host"),
  port: integer("port").notNull().default(587),
  secure: boolean("secure").notNull().default(false),
  username: text("username"),
  password: text("password"),
  passwordCiphertext: text("password_ciphertext"),
  passwordKeyId: text("password_key_id"),
  passwordEncryptedAt: timestamp("password_encrypted_at"),
  fromAddress: text("from_address"),
  fromName: text("from_name"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  check(
    "email_settings_password_envelope_chk",
    sql`(${t.passwordCiphertext} is null and ${t.passwordKeyId} is null and ${t.passwordEncryptedAt} is null) or (${t.passwordCiphertext} is not null and ${t.passwordKeyId} is not null and ${t.passwordEncryptedAt} is not null and ${t.password} is null)`,
  ),
]);

export type EmailSettings = typeof emailSettingsTable.$inferSelect;

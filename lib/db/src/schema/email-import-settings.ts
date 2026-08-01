import { pgTable, integer, text, boolean, timestamp, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Configuration for the incoming-mail importer (IMAP). Stored as a single row
 * (id = 1) so it can be edited from the Settings UI in production without
 * changing environment variables or redeploying. When no row exists or
 * `enabled` is false, the poller falls back to the IMAP_* env vars.
 *
 * Suppliers e-mail invoices/receipts to a dedicated mailbox; the poller fetches
 * new messages, turns each supported attachment (ISDOC/XML/PDF/image) into a
 * received cost document and marks the message seen so it is not re-imported.
 *
 * The password is write-only at the API and new values use the externally keyed
 * versioned envelope. `password` remains only for migration-time legacy reads.
 */
export const emailImportSettingsTable = pgTable("email_import_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  host: text("host"),
  port: integer("port").notNull().default(993),
  // secure=true uses implicit TLS (typically port 993); false negotiates
  // STARTTLS on a plaintext port (143).
  secure: boolean("secure").notNull().default(true),
  username: text("username"),
  password: text("password"),
  passwordCiphertext: text("password_ciphertext"),
  passwordKeyId: text("password_key_id"),
  passwordEncryptedAt: timestamp("password_encrypted_at"),
  // Mailbox/folder to read from (default INBOX).
  folder: text("folder").notNull().default("INBOX"),
  // Mark imported messages as \Seen so they are skipped on the next poll. This
  // is the primary re-poll dedupe mechanism; content sha256 is a backstop.
  markSeen: boolean("mark_seen").notNull().default(true),
  // How often the background worker polls, in minutes.
  pollMinutes: integer("poll_minutes").notNull().default(15),

  // Last-poll diagnostics, surfaced in the UI so failures are never silent.
  lastPolledAt: timestamp("last_polled_at"),
  lastStatus: text("last_status"),
  lastError: text("last_error"),

  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  check(
    "email_import_settings_password_envelope_chk",
    sql`(${t.passwordCiphertext} is null and ${t.passwordKeyId} is null and ${t.passwordEncryptedAt} is null) or (${t.passwordCiphertext} is not null and ${t.passwordKeyId} is not null and ${t.passwordEncryptedAt} is not null and ${t.password} is null)`,
  ),
]);

export type EmailImportSettings = typeof emailImportSettingsTable.$inferSelect;

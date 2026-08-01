import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  real,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * OpenAI document-extraction configuration. Stored as a single row (id = 1) so
 * the operator can set the API key + model from the Settings UI in production
 * without changing environment variables or redeploying (the self-hosted
 * deployment runs on Coolify/Hetzner where editing env vars is awkward).
 *
 * Resolution falls back to the OPENAI_* env vars when no row exists or a field
 * is empty, so existing env-based deployments keep working unchanged.
 *
 * The API key is write-only and new values use the externally keyed versioned
 * envelope. `api_key` remains only for migration-time legacy reads.
 */
export const openaiSettingsTable = pgTable("openai_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  apiKey: text("api_key"),
  apiKeyCiphertext: text("api_key_ciphertext"),
  apiKeyKeyId: text("api_key_key_id"),
  apiKeyEncryptedAt: timestamp("api_key_encrypted_at"),
  model: text("model"),
  // Advanced, optional overrides. NULL on any field falls back to the OPENAI_*
  // env var (or the built-in default) so existing env-based deploys are unchanged.
  systemPrompt: text("system_prompt"),
  maxFileMb: integer("max_file_mb"),
  requestTimeoutMs: integer("request_timeout_ms"),
  confidenceThreshold: real("confidence_threshold").default(0.8),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  check(
    "openai_settings_api_key_envelope_chk",
    sql`(${t.apiKeyCiphertext} is null and ${t.apiKeyKeyId} is null and ${t.apiKeyEncryptedAt} is null) or (${t.apiKeyCiphertext} is not null and ${t.apiKeyKeyId} is not null and ${t.apiKeyEncryptedAt} is not null and ${t.apiKey} is null)`,
  ),
]);

export type OpenaiSettings = typeof openaiSettingsTable.$inferSelect;

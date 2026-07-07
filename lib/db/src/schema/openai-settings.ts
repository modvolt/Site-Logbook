import {
  pgTable,
  integer,
  text,
  boolean,
  timestamp,
  real,
} from "drizzle-orm/pg-core";

/**
 * OpenAI document-extraction configuration. Stored as a single row (id = 1) so
 * the operator can set the API key + model from the Settings UI in production
 * without changing environment variables or redeploying (the self-hosted
 * deployment runs on Coolify/Hetzner where editing env vars is awkward).
 *
 * Resolution falls back to the OPENAI_* env vars when no row exists or a field
 * is empty, so existing env-based deployments keep working unchanged.
 *
 * Note: the API key is stored as plaintext, consistent with the existing
 * device-credential vault and email_settings. It is never returned by the API
 * (write-only); the status endpoint only reports whether a key is set.
 */
export const openaiSettingsTable = pgTable("openai_settings", {
  id: integer("id").primaryKey().default(1),
  enabled: boolean("enabled").notNull().default(false),
  apiKey: text("api_key"),
  model: text("model"),
  // Advanced, optional overrides. NULL on any field falls back to the OPENAI_*
  // env var (or the built-in default) so existing env-based deploys are unchanged.
  systemPrompt: text("system_prompt"),
  maxFileMb: integer("max_file_mb"),
  requestTimeoutMs: integer("request_timeout_ms"),
  confidenceThreshold: real("confidence_threshold").default(0.8),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type OpenaiSettings = typeof openaiSettingsTable.$inferSelect;

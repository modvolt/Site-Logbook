import { pgTable, integer, boolean, real, timestamp } from "drizzle-orm/pg-core";

/**
 * Configuration for automatic document → job/material linking and price
 * propagation. Stored as a single row (id = 1) so an admin can toggle it from
 * the Settings UI in production without changing environment variables or
 * redeploying (the self-hosted deployment runs on Coolify/Hetzner where editing
 * env vars is awkward).
 *
 * Resolution falls back to the DOCUMENT_* env vars (and built-in defaults) when
 * no row exists; once a row is saved, the UI values for the two switches take
 * over. The two score thresholds are nullable: NULL on a field falls back to the
 * matching env var / default, mirroring the openai_settings advanced fields.
 */
export const documentLinkingSettingsTable = pgTable("document_linking_settings", {
  id: integer("id").primaryKey().default(1),
  // Write a *suggested* job link once a match reaches autoLinkMinScore. ON by
  // default — it only suggests, never confirms.
  autoLinkEnabled: boolean("auto_link_enabled").notNull().default(true),
  // Confirm automatically only after the deliberately high score threshold.
  autoConfirmEnabled: boolean("auto_confirm_enabled").notNull().default(true),
  // 0..1 thresholds. NULL falls back to the DOCUMENT_*_MIN_SCORE env var or the
  // built-in default.
  autoLinkMinScore: real("auto_link_min_score"),
  autoConfirmMinScore: real("auto_confirm_min_score").default(0.8),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type DocumentLinkingSettings = typeof documentLinkingSettingsTable.$inferSelect;

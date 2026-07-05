/**
 * Configuration for automatic document → job linking and price propagation.
 *
 * Mirrors the env-with-defaults pattern used elsewhere. Two independent gates:
 *
 *  - AUTO-LINK: write a *suggested* job link (`matchedJobId`, and propagate an
 *    invoice price onto an existing job material) once the match score reaches
 *    `autoLinkMinScore`. On by default — it only suggests, never confirms.
 *  - AUTO-CONFIRM: additionally set `matchConfirmed = 1` automatically once the
 *    score reaches `autoConfirmMinScore`. ON by default at 0.8, matching the
 *    boundary between an alarm and a sufficiently reliable match.
 *
 * A partial name similarity never auto-confirms; confirmation requires 0.8.
 */

import { db, documentLinkingSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface DocumentLinkingConfig {
  autoLinkEnabled: boolean;
  autoConfirmEnabled: boolean;
  /** 0..1 minimum line/reference score to write a (suggested) link. */
  autoLinkMinScore: number;
  /** 0..1 minimum score to auto-confirm a link (only when autoConfirmEnabled). */
  autoConfirmMinScore: number;
}

const DEFAULTS: DocumentLinkingConfig = {
  autoLinkEnabled: true,
  autoConfirmEnabled: true,
  autoLinkMinScore: 0.6,
  autoConfirmMinScore: 0.8,
};

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function envScore(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/**
 * Resolve the active config from the environment, falling back to the built-in
 * conservative defaults. Pure aside from reading `process.env`.
 */
export function resolveDocumentLinkingConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DocumentLinkingConfig {
  return {
    autoLinkEnabled: envBool(env.DOCUMENT_AUTO_LINK_ENABLED, DEFAULTS.autoLinkEnabled),
    autoConfirmEnabled: envBool(
      env.DOCUMENT_AUTO_CONFIRM_ENABLED,
      DEFAULTS.autoConfirmEnabled,
    ),
    autoLinkMinScore: envScore(
      env.DOCUMENT_AUTO_LINK_MIN_SCORE,
      DEFAULTS.autoLinkMinScore,
    ),
    autoConfirmMinScore: envScore(
      env.DOCUMENT_AUTO_CONFIRM_MIN_SCORE,
      DEFAULTS.autoConfirmMinScore,
    ),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export const DOCUMENT_LINKING_SETTINGS_ID = 1;

/**
 * Resolve the active config, preferring the DB singleton (admin-editable in the
 * Settings UI) and falling back to the env/defaults. Once a row is saved, the
 * two switches are taken from the UI; the score thresholds fall back per-field
 * to env/default when left blank (NULL).
 */
export async function resolveDocumentLinkingConfig(): Promise<DocumentLinkingConfig> {
  const envCfg = resolveDocumentLinkingConfigFromEnv();
  const [row] = await db
    .select()
    .from(documentLinkingSettingsTable)
    .where(eq(documentLinkingSettingsTable.id, DOCUMENT_LINKING_SETTINGS_ID));
  if (!row) return envCfg;
  return {
    autoLinkEnabled: row.autoLinkEnabled,
    autoConfirmEnabled: row.autoConfirmEnabled,
    autoLinkMinScore:
      row.autoLinkMinScore != null ? clamp01(row.autoLinkMinScore) : envCfg.autoLinkMinScore,
    autoConfirmMinScore:
      row.autoConfirmMinScore != null
        ? clamp01(row.autoConfirmMinScore)
        : envCfg.autoConfirmMinScore,
  };
}

export const DOCUMENT_LINKING_DEFAULTS = DEFAULTS;

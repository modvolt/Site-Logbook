/**
 * Configuration for automatic document → job linking and price propagation.
 *
 * Mirrors the env-with-defaults pattern used elsewhere. Two independent gates:
 *
 *  - AUTO-LINK: write a *suggested* job link (`matchedJobId`, and propagate an
 *    invoice price onto an existing job material) once the match score reaches
 *    `autoLinkMinScore`. On by default — it only suggests, never confirms.
 *  - AUTO-CONFIRM: additionally set `matchConfirmed = 1` automatically once the
 *    score reaches `autoConfirmMinScore`. OFF by default, so confirmation stays
 *    100% manual unless an operator opts in.
 *
 * The defaults are deliberately conservative: links are suggested, never
 * auto-confirmed, and a mere partial name similarity (which scores below
 * `autoLinkMinScore`) is never applied — it stays a suggestion for a human.
 */

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
  autoConfirmEnabled: false,
  autoLinkMinScore: 0.6,
  autoConfirmMinScore: 0.9,
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
 * conservative defaults. Pure aside from reading `process.env`; safe to call per
 * request.
 */
export function resolveDocumentLinkingConfig(
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

export const DOCUMENT_LINKING_DEFAULTS = DEFAULTS;

export const VAULT_STEP_UP_TTL_MS = 5 * 60 * 1000;

export function hasRecentVaultStepUp(
  verifiedAt: unknown,
  now = Date.now(),
): boolean {
  return (
    typeof verifiedAt === "number" &&
    Number.isFinite(verifiedAt) &&
    verifiedAt <= now &&
    now - verifiedAt < VAULT_STEP_UP_TTL_MS
  );
}

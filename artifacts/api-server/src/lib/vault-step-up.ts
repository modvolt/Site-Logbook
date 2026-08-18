import type { Request } from "express";
import { VAULT_STEP_UP_TTL_MS } from "./vault-step-up-policy";

export type VaultStepUpMethod = "password" | "webauthn";

export async function establishVaultStepUp(
  req: Request,
  method: VaultStepUpMethod,
): Promise<{ verifiedAt: number; expiresAt: number }> {
  if (!req.auth) throw new Error("Cannot establish vault step-up without authentication.");

  void method; // Route-specific redacted audit instrumentation owns the method code.
  const verifiedAt = Date.now();
  req.session.vaultVerifiedAt = verifiedAt;
  delete req.session.biometricVerifiedAt;
  return { verifiedAt, expiresAt: verifiedAt + VAULT_STEP_UP_TTL_MS };
}

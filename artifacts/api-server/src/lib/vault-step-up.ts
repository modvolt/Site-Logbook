import type { Request } from "express";
import { auditLogTable, db } from "@workspace/db";
import { VAULT_STEP_UP_TTL_MS } from "./vault-step-up-policy";

export type VaultStepUpMethod = "password" | "webauthn";

export async function establishVaultStepUp(
  req: Request,
  method: VaultStepUpMethod,
): Promise<{ verifiedAt: number; expiresAt: number }> {
  if (!req.auth) throw new Error("Cannot establish vault step-up without authentication.");

  const verifiedAt = Date.now();
  await db.insert(auditLogTable).values({
    actorUserId: req.auth.userId,
    actorName: req.auth.name ?? req.auth.username,
    action: "security",
    entityType: "vault-step-up",
    entityId: req.auth.userId,
    summary: `Vault step-up verified via ${method}`,
    method: req.method,
    path: req.path,
  });

  req.session.vaultVerifiedAt = verifiedAt;
  delete req.session.biometricVerifiedAt;
  return { verifiedAt, expiresAt: verifiedAt + VAULT_STEP_UP_TTL_MS };
}

import { createHash } from "node:crypto";
import type { Permission, UserRole } from "@workspace/db";

export interface OfflineIdentityInput {
  userId: number;
  sessionGeneration: number;
  role: UserRole;
  permissions: readonly Permission[];
}

/**
 * Opaque browser-storage partition key. It deliberately excludes the raw
 * session ID so the same user can recover their own queued work after logging
 * in again, while a revocation, role change or permission change rotates the
 * scope and locks the older queue.
 */
export function createOfflineIdentityScope(input: OfflineIdentityInput): string {
  const canonical = JSON.stringify({
    userId: input.userId,
    sessionGeneration: input.sessionGeneration,
    role: input.role,
    permissions: [...input.permissions].sort(),
  });
  return createHash("sha256")
    .update(`stavba-offline-identity-v1:${canonical}`)
    .digest("hex");
}

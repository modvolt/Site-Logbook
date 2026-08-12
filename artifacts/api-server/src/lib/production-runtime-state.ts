import type { ProductionRuntimeBinding } from "./production-startup-evidence";

let installedBinding: ProductionRuntimeBinding | null = null;
let refreshLiveReadiness: (() => Promise<boolean>) | null = null;

export type ProductionRuntimeReadinessState =
  | "uninstalled"
  | "ready"
  | "failed";

let readinessState: ProductionRuntimeReadinessState = "uninstalled";

export function installProductionRuntimeBinding(
  binding: ProductionRuntimeBinding,
  refresh: () => Promise<boolean>,
): void {
  if (readinessState !== "uninstalled" || installedBinding) {
    throw new Error(
      "PRODUCTION_RUNTIME_BINDING_ALREADY_INSTALLED: runtime evidence may only be installed once.",
    );
  }
  installedBinding = Object.freeze({
    ...binding,
    lineage: Object.freeze({ ...binding.lineage }),
  });
  refreshLiveReadiness = refresh;
  readinessState = "ready";
}

export function readProductionRuntimeReadinessState(): ProductionRuntimeReadinessState {
  return readinessState;
}

/**
 * Permanently fails readiness for this process. The latch cannot self-heal;
 * only a fresh process that passes the complete startup guard can be ready.
 */
export function failProductionRuntimeReadiness(): boolean {
  if (readinessState !== "ready") return false;
  readinessState = "failed";
  return true;
}

export function readProductionRuntimeBinding(): ProductionRuntimeBinding | null {
  return installedBinding;
}

export function readProductionRuntimeHealthProjection() {
  const binding = installedBinding;
  if (!binding) return null;
  return Object.freeze({
    schemaVersion: binding.schemaVersion,
    sourceSha: binding.sourceSha,
    apiImage: binding.apiImage,
    apiImageDigest: binding.apiImageDigest,
    targetEvidenceSha256: binding.targetEvidenceSha256,
    releaseEvidenceSha256: binding.releaseEvidenceSha256,
    resolvedComposeSha256: binding.resolvedComposeSha256,
    deployedConfigSha256: binding.deployedConfigSha256,
    desiredConfigSha256: binding.desiredConfigSha256,
    livePostgresTargetSha256: binding.livePostgresTargetSha256,
    databaseName: binding.databaseName,
    databaseUser: binding.databaseUser,
    schemaFingerprintSha256: binding.schemaFingerprintSha256,
    preMigrationBackupEvidenceSha256: binding.preMigrationBackupEvidenceSha256,
    backupIntegritySha256: binding.backupIntegritySha256,
    transitionChainSha256: binding.transitionChainSha256,
    activationApprovalSha256: binding.activationApprovalSha256,
  });
}

export function requireProductionRuntimeBinding(): ProductionRuntimeBinding {
  if (!installedBinding) {
    throw new Error(
      "PRODUCTION_RUNTIME_BINDING_MISSING: production startup evidence was not installed.",
    );
  }
  return installedBinding;
}

export async function refreshProductionRuntimeReadiness(): Promise<boolean> {
  if (readinessState !== "ready" || !refreshLiveReadiness) return false;
  try {
    const ready = await refreshLiveReadiness();
    return readinessState === "ready" && ready;
  } catch {
    return false;
  }
}

/** Test-only reset; production code never calls this. */
export function resetProductionRuntimeBindingForTest(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Production runtime binding reset is test-only.");
  }
  installedBinding = null;
  refreshLiveReadiness = null;
  readinessState = "uninstalled";
}

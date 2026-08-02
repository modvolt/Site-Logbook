import {
  recoveryStorageFingerprint,
  type RecoveryStorageIdentity,
} from "./object-recovery";
import type { RecoveryStorageReadinessInspection } from "./objectStorage";

export type RecoveryStorageRequirements = {
  expectedFingerprint?: string;
  allowInsecureLoopback?: boolean;
  requireVersioning?: boolean;
  requireObjectLock?: boolean;
  minimumDefaultRetentionDays?: number;
  requireEncryption?: boolean;
  requirePublicAccessBlock?: boolean;
};

export type RecoveryStoragePreflight = RecoveryStorageReadinessInspection & {
  fingerprint: string;
  requirements: Required<
    Omit<RecoveryStorageRequirements, "expectedFingerprint">
  > & {
    expectedFingerprint: string | null;
  };
  violations: string[];
  ready: boolean;
};

function validFingerprint(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

export function evaluateRecoveryStorageReadiness(
  inspection: RecoveryStorageReadinessInspection,
  requirements: RecoveryStorageRequirements = {},
): RecoveryStoragePreflight {
  const normalized = {
    expectedFingerprint: requirements.expectedFingerprint ?? null,
    allowInsecureLoopback: requirements.allowInsecureLoopback ?? false,
    requireVersioning: requirements.requireVersioning ?? false,
    requireObjectLock: requirements.requireObjectLock ?? false,
    minimumDefaultRetentionDays: requirements.minimumDefaultRetentionDays ?? 0,
    requireEncryption: requirements.requireEncryption ?? false,
    requirePublicAccessBlock: requirements.requirePublicAccessBlock ?? false,
  };
  if (
    !Number.isFinite(normalized.minimumDefaultRetentionDays) ||
    normalized.minimumDefaultRetentionDays < 0
  ) {
    throw new Error(
      "Minimum default retention must be zero or a positive number of days.",
    );
  }
  if (
    normalized.expectedFingerprint !== null &&
    !validFingerprint(normalized.expectedFingerprint)
  ) {
    throw new Error("Expected storage fingerprint must be a SHA-256 value.");
  }

  const fingerprint = recoveryStorageFingerprint(
    inspection.identity as RecoveryStorageIdentity,
  );
  const violations: string[] = [];
  if (inspection.checks.bucketAccess.status !== "pass") {
    violations.push("bucket_access_not_proven");
  }
  if (
    inspection.checks.transportSecurity.status !== "pass" &&
    !(
      normalized.allowInsecureLoopback &&
      inspection.checks.transportSecurity.status === "unknown" &&
      inspection.checks.transportSecurity.detail.includes("Loopback HTTP")
    )
  ) {
    violations.push("transport_security_not_proven");
  }
  if (
    normalized.requireVersioning &&
    inspection.checks.versioning.status !== "pass"
  ) {
    violations.push("versioning_not_enabled");
  }
  if (
    normalized.requireObjectLock &&
    inspection.checks.objectLock.status !== "pass"
  ) {
    violations.push("object_lock_not_enabled");
  }
  const retentionDays = inspection.checks.objectLock.defaultRetentionDays;
  if (
    normalized.minimumDefaultRetentionDays > 0 &&
    (typeof retentionDays !== "number" ||
      retentionDays < normalized.minimumDefaultRetentionDays)
  ) {
    violations.push("default_retention_too_short_or_unknown");
  }
  if (
    normalized.requireEncryption &&
    inspection.checks.encryption.status !== "pass"
  ) {
    violations.push("default_encryption_not_proven");
  }
  if (
    normalized.requirePublicAccessBlock &&
    inspection.checks.publicAccessBlock.status !== "pass"
  ) {
    violations.push("public_access_block_not_proven");
  }
  if (
    normalized.expectedFingerprint !== null &&
    fingerprint !== normalized.expectedFingerprint
  ) {
    violations.push("storage_fingerprint_mismatch");
  }

  return {
    ...inspection,
    fingerprint,
    requirements: normalized,
    violations,
    ready: violations.length === 0,
  };
}

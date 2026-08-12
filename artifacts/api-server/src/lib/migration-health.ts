import { createHash } from "node:crypto";

export interface ExpectedMigrationIdentity {
  when: number;
  tag: string;
  hash: string;
}

export interface AppliedMigrationIdentityRow {
  created_at: string | number | null;
  hash: string | null;
}

export interface OpaqueMigrationIdentity {
  createdAt: number | null;
  hash: string | null;
}

export interface MigrationInventoryClassification {
  knownExpectedMigrations: number;
  knownAppliedMigrations: number;
  knownAppliedRowsSha256: string;
  opaqueAppliedMigrations: number;
  opaqueLegacyRowsSha256: string;
  missingKnownMigrationTags: string[];
}

interface RuntimeMigrationLineage {
  decision: "ALREADY_0107";
  knownAppliedRowsSha256: string;
  mode: "clean" | "production-copy-restricted";
  knownExpectedMigrations: number;
  knownAppliedMigrations: number;
  latestKnownAppliedTag: string;
  missingKnownToPredecessor: number;
  opaqueLegacyRowCount: number;
  opaqueLegacyRowsSha256: string;
  opaqueLegacyMeaningInferred: false;
  excludedMigration0100Present: false;
}

export interface ProductionRuntimeReleaseBinding {
  schemaVersion: "site-logbook.production-runtime-binding/v1";
  sourceSha: string;
  apiImage: string;
  apiImageDigest: string;
  targetEvidenceSha256: string;
  releaseEvidenceSha256: string;
  resolvedComposeSha256: string;
  deployedConfigSha256: string;
  desiredConfigSha256: string;
  livePostgresTargetSha256: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  preMigrationBackupEvidenceSha256: string;
  backupIntegritySha256: string;
  transitionChainSha256: string;
  activationApprovalSha256: string;
  lineage: Record<string, unknown>;
}

interface RuntimeMigrationReleaseBinding {
  schemaVersion: "site-logbook.runtime-migration-release-binding/v1";
  buildSha: string;
  releaseEvidenceSha256: string;
  lineage: RuntimeMigrationLineage;
}

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE_PATTERN =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function binaryCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalOpaqueRows(rows: readonly OpaqueMigrationIdentity[]): string {
  return JSON.stringify(
    [...rows].sort((left, right) => {
      const leftCreatedAt = left.createdAt ?? Number.MIN_SAFE_INTEGER;
      const rightCreatedAt = right.createdAt ?? Number.MIN_SAFE_INTEGER;
      return (
        leftCreatedAt - rightCreatedAt ||
        binaryCompare(left.hash ?? "", right.hash ?? "")
      );
    }),
  );
}

function canonicalKnownRows(
  rows: readonly { createdAt: number; hash: string }[],
): string {
  return JSON.stringify(
    [...rows]
      .map((row) => ({ createdAt: row.createdAt, hash: row.hash }))
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt ||
          binaryCompare(left.hash, right.hash),
      ),
  );
}

export function knownMigrationRowsSha256(
  rows: readonly { createdAt: number; hash: string }[],
): string {
  return `sha256:${createHash("sha256").update(canonicalKnownRows(rows)).digest("hex")}`;
}

export function opaqueMigrationRowsSha256(
  rows: readonly OpaqueMigrationIdentity[],
): string {
  return `sha256:${createHash("sha256").update(canonicalOpaqueRows(rows)).digest("hex")}`;
}

/**
 * Classify the live drizzle journal by exact `(created_at, hash)` identity.
 * One exact row can satisfy one expected migration. Duplicate expected rows,
 * hash drift, invalid rows and unknown timestamps remain opaque instead of
 * being silently counted as known migrations.
 */
export function classifyMigrationInventory(
  expected: readonly ExpectedMigrationIdentity[],
  applied: readonly AppliedMigrationIdentityRow[],
): MigrationInventoryClassification {
  const expectedByWhen = new Map<number, ExpectedMigrationIdentity>();
  for (const identity of expected) {
    if (
      !Number.isSafeInteger(identity.when) ||
      !identity.tag ||
      !/^[0-9a-f]{64}$/.test(identity.hash)
    ) {
      throw new Error("Expected migration identities must be exact and valid.");
    }
    if (expectedByWhen.has(identity.when)) {
      throw new Error("Expected migration timestamps must be unique.");
    }
    expectedByWhen.set(identity.when, identity);
  }

  const satisfied = new Set<number>();
  const satisfiedRows: Array<{ createdAt: number; hash: string }> = [];
  const opaqueRows: OpaqueMigrationIdentity[] = [];
  for (const row of applied) {
    const createdAt =
      row.created_at === null ? Number.NaN : Number(row.created_at);
    const validCreatedAt = Number.isSafeInteger(createdAt) ? createdAt : null;
    const hash = typeof row.hash === "string" ? row.hash.toLowerCase() : null;
    const expectedIdentity =
      validCreatedAt === null ? undefined : expectedByWhen.get(validCreatedAt);
    if (
      expectedIdentity &&
      validCreatedAt !== null &&
      hash === expectedIdentity.hash &&
      !satisfied.has(validCreatedAt)
    ) {
      satisfied.add(validCreatedAt);
      satisfiedRows.push({ createdAt: validCreatedAt, hash });
      continue;
    }
    opaqueRows.push({ createdAt: validCreatedAt, hash });
  }

  const missingKnownMigrationTags = expected
    .filter((identity) => !satisfied.has(identity.when))
    .map((identity) => identity.tag);

  return {
    knownExpectedMigrations: expected.length,
    knownAppliedMigrations: satisfied.size,
    knownAppliedRowsSha256: knownMigrationRowsSha256(satisfiedRows),
    opaqueAppliedMigrations: opaqueRows.length,
    opaqueLegacyRowsSha256: opaqueMigrationRowsSha256(opaqueRows),
    missingKnownMigrationTags,
  };
}

/**
 * Validate the narrow, non-secret binding exported by the startup evidence
 * checker. Production readiness still recomputes the live DB inventory and
 * accepts the binding only when every count and the opaque-row digest match.
 */
export function migrationReleaseBindingMatches(
  encodedBinding: string | undefined,
  buildSha: string,
  latestExpectedTag: string | null,
  inventory: MigrationInventoryClassification,
): boolean {
  if (!encodedBinding || encodedBinding.length > 32_768) return false;

  let parsed: unknown;
  try {
    const bytes = Buffer.from(encodedBinding, "base64");
    if (bytes.toString("base64") !== encodedBinding) return false;
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }

  const binding = objectValue(parsed);
  if (
    !binding ||
    !hasExactKeys(binding, [
      "schemaVersion",
      "buildSha",
      "releaseEvidenceSha256",
      "lineage",
    ]) ||
    binding.schemaVersion !==
      "site-logbook.runtime-migration-release-binding/v1" ||
    typeof binding.buildSha !== "string" ||
    !SHA_PATTERN.test(binding.buildSha) ||
    binding.buildSha !== buildSha.toLowerCase() ||
    typeof binding.releaseEvidenceSha256 !== "string" ||
    !SHA256_PATTERN.test(binding.releaseEvidenceSha256)
  ) {
    return false;
  }

  const lineage = objectValue(binding.lineage);
  if (
    !lineage ||
    !hasExactKeys(lineage, [
      "decision",
      "knownAppliedRowsSha256",
      "mode",
      "knownExpectedMigrations",
      "knownAppliedMigrations",
      "latestKnownAppliedTag",
      "missingKnownToPredecessor",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
      "opaqueLegacyMeaningInferred",
      "excludedMigration0100Present",
    ]) ||
    lineage.decision !== "ALREADY_0107" ||
    lineage.knownAppliedRowsSha256 !== inventory.knownAppliedRowsSha256 ||
    typeof lineage.knownAppliedRowsSha256 !== "string" ||
    !SHA256_PATTERN.test(lineage.knownAppliedRowsSha256) ||
    !["clean", "production-copy-restricted"].includes(String(lineage.mode)) ||
    lineage.knownExpectedMigrations !== inventory.knownExpectedMigrations ||
    lineage.knownAppliedMigrations !== inventory.knownAppliedMigrations ||
    lineage.latestKnownAppliedTag !== latestExpectedTag ||
    lineage.missingKnownToPredecessor !== 0 ||
    lineage.opaqueLegacyRowCount !== inventory.opaqueAppliedMigrations ||
    lineage.opaqueLegacyRowsSha256 !== inventory.opaqueLegacyRowsSha256 ||
    lineage.opaqueLegacyMeaningInferred !== false ||
    lineage.excludedMigration0100Present !== false
  ) {
    return false;
  }

  return (
    inventory.knownAppliedMigrations === inventory.knownExpectedMigrations &&
    inventory.missingKnownMigrationTags.length === 0 &&
    ((lineage.mode === "clean" && inventory.opaqueAppliedMigrations === 0) ||
      (lineage.mode === "production-copy-restricted" &&
        inventory.opaqueAppliedMigrations === 2))
  );
}

/** Match the in-memory, pre-start production binding against each live poll. */
export function productionRuntimeBindingMatches(
  binding: ProductionRuntimeReleaseBinding | null,
  buildSha: string,
  latestExpectedTag: string | null,
  inventory: MigrationInventoryClassification,
): boolean {
  if (
    !binding ||
    binding.schemaVersion !== "site-logbook.production-runtime-binding/v1" ||
    !SHA_PATTERN.test(binding.sourceSha) ||
    binding.sourceSha !== buildSha.toLowerCase() ||
    !IMMUTABLE_IMAGE_PATTERN.test(binding.apiImage) ||
    binding.apiImageDigest !==
      `sha256:${binding.apiImage.split("@sha256:")[1]}` ||
    ![
      binding.targetEvidenceSha256,
      binding.releaseEvidenceSha256,
      binding.resolvedComposeSha256,
      binding.deployedConfigSha256,
      binding.desiredConfigSha256,
      binding.livePostgresTargetSha256,
      binding.schemaFingerprintSha256,
      binding.preMigrationBackupEvidenceSha256,
      binding.backupIntegritySha256,
      binding.transitionChainSha256,
      binding.activationApprovalSha256,
    ].every((value) => SHA256_PATTERN.test(value)) ||
    binding.desiredConfigSha256 !== binding.deployedConfigSha256 ||
    !binding.databaseName ||
    !binding.databaseUser
  ) {
    return false;
  }

  const lineage = objectValue(binding.lineage);
  if (
    !lineage ||
    !hasExactKeys(lineage, [
      "decision",
      "mode",
      "knownExpectedMigrations",
      "knownAppliedMigrations",
      "knownAppliedRowsSha256",
      "latestKnownAppliedTag",
      "missingKnownToPredecessor",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
      "opaqueLegacyMeaningInferred",
      "excludedMigration0100Present",
    ]) ||
    lineage.decision !== "ALREADY_0107" ||
    lineage.mode !== "production-copy-restricted" ||
    lineage.knownExpectedMigrations !== 107 ||
    lineage.knownExpectedMigrations !== inventory.knownExpectedMigrations ||
    lineage.knownAppliedMigrations !== 107 ||
    lineage.knownAppliedMigrations !== inventory.knownAppliedMigrations ||
    lineage.knownAppliedRowsSha256 !== inventory.knownAppliedRowsSha256 ||
    lineage.latestKnownAppliedTag !== latestExpectedTag ||
    lineage.missingKnownToPredecessor !== 0 ||
    lineage.opaqueLegacyRowCount !== 2 ||
    lineage.opaqueLegacyRowCount !== inventory.opaqueAppliedMigrations ||
    lineage.opaqueLegacyRowsSha256 !== inventory.opaqueLegacyRowsSha256 ||
    lineage.opaqueLegacyMeaningInferred !== false ||
    lineage.excludedMigration0100Present !== false
  ) {
    return false;
  }
  return inventory.missingKnownMigrationTags.length === 0;
}

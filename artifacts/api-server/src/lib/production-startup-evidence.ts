import { createHash } from "node:crypto";
import {
  AUDIT_SCHEMA_KNOWN_ROWS_SHA256,
  AUDIT_SCHEMA_OPAQUE_ROWS_SHA256,
} from "@workspace/db/audit-schema-preflight";
import { requireProductionRuntimeDatabaseUser } from "./production-runtime-database";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const MAX_ARTIFACT_BYTES = 256 * 1024;

export const PRODUCTION_TARGET = Object.freeze({
  projectId: "bai77dzr0h7b5gu1jqwpriew",
  environmentId: "d5m70pb2i5s7c41n21vaokr7",
  applicationId: "ef09696arga7h9ox6ojgv7ru",
  environmentLabel: "production",
  logicalEnvironmentId: "site-logbook-production",
});

const TARGET_KIND = "site-logbook-production-audit-0107-target";
const INTENT_KIND = "site-logbook-production-audit-0107-intent";
const EXECUTION_KIND = "site-logbook-production-audit-0107-execution";
const STEADY_KIND = "site-logbook-production-audit-0107-steady";
const RELEASE_KIND = "site-logbook-production-audit-0107-release-evidence";
const ACTIVATION_APPROVAL_SCHEMA =
  "site-logbook.production-activation-approval/v1";
const TRANSITION_CONFIRMATION =
  "APPLY_0107_AUDIT_EVIDENCE_TO_EXACT_MODVOLT_PRODUCTION";
const START_CONFIRMATION =
  "AUTHORIZE_EXACT_0107_MODVOLT_PRODUCTION_APPLICATION_START";

export class ProductionStartupEvidenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "ProductionStartupEvidenceError";
  }
}

function fail(code: string, message: string): never {
  throw new ProductionStartupEvidenceError(code, message);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalProductionEvidenceJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function productionEvidenceSha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_EVIDENCE_SCHEMA_INVALID", `${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): Record<string, unknown> {
  const object = objectAt(value, field);
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expected].sort())
  ) {
    fail(
      "PRODUCTION_EVIDENCE_SCHEMA_INVALID",
      `${field} must contain only the exact approved fields.`,
    );
  }
  return object;
}

function stringAt(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    fail("PRODUCTION_EVIDENCE_SCHEMA_INVALID", `${field} must be exact text.`);
  }
  return value;
}

function shaAt(value: unknown, field: string): string {
  const result = stringAt(value, field).toLowerCase();
  if (!SHA.test(result) || /^0{40}$/.test(result)) {
    fail(
      "PRODUCTION_EVIDENCE_SHA_INVALID",
      `${field} must be an exact Git SHA.`,
    );
  }
  return result;
}

function digestAt(value: unknown, field: string): string {
  const result = stringAt(value, field).toLowerCase();
  if (!SHA256.test(result) || /^sha256:0{64}$/.test(result)) {
    fail("PRODUCTION_EVIDENCE_DIGEST_INVALID", `${field} must be SHA-256.`);
  }
  return result;
}

function timeAt(value: unknown, field: string): number {
  const text = stringAt(value, field);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || !text.endsWith("Z")) {
    fail("PRODUCTION_EVIDENCE_TIME_INVALID", `${field} must be UTC.`);
  }
  return parsed;
}

function requireValue(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(
      "PRODUCTION_EVIDENCE_BINDING_INVALID",
      `${field} must equal ${JSON.stringify(expected)}.`,
    );
  }
}

function scanForSecrets(value: unknown, field: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      scanForSecrets(entry, `${field}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (
      /(password|secret|token|credential|private.?key|database.?url)/i.test(key)
    ) {
      fail(
        "PRODUCTION_EVIDENCE_SECRET_MATERIAL",
        `${field}.${key} is forbidden.`,
      );
    }
    scanForSecrets(entry, `${field}.${key}`);
  }
}

export interface CanonicalProductionEvidenceArtifact {
  bytes: Buffer;
  base64: string;
  sha256: string;
}

interface CanonicalArtifact {
  value: Record<string, unknown>;
  sha256: string;
}

/**
 * Secret-free canonical serialization helper. This does not observe Coolify,
 * Docker or PostgreSQL and therefore is not a production evidence producer.
 * A reviewed host runner must supply the observed values before using it.
 */
export function createCanonicalProductionEvidenceArtifact(
  value: Record<string, unknown>,
): CanonicalProductionEvidenceArtifact {
  scanForSecrets(value, "productionEvidence");
  const bytes = Buffer.from(canonicalProductionEvidenceJson(value), "utf8");
  if (bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    fail(
      "PRODUCTION_EVIDENCE_ARTIFACT_INVALID",
      "Canonical production evidence is empty or too large.",
    );
  }
  return Object.freeze({
    bytes,
    base64: bytes.toString("base64"),
    sha256: productionEvidenceSha256(bytes),
  });
}

function decodeArtifact(
  base64: string,
  expectedSha256: string,
  field: string,
): CanonicalArtifact {
  const digest = digestAt(expectedSha256, `${field}Sha256`);
  if (!base64 || base64.length > Math.ceil((MAX_ARTIFACT_BYTES * 4) / 3) + 4) {
    fail(
      "PRODUCTION_EVIDENCE_ARTIFACT_INVALID",
      `${field} is missing or too large.`,
    );
  }
  const bytes = Buffer.from(base64, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_ARTIFACT_BYTES ||
    bytes.toString("base64") !== base64 ||
    productionEvidenceSha256(bytes) !== digest
  ) {
    fail(
      "PRODUCTION_EVIDENCE_ARTIFACT_INVALID",
      `${field} bytes or separately trusted digest do not match.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("PRODUCTION_EVIDENCE_ARTIFACT_INVALID", `${field} must be JSON.`);
  }
  if (
    !bytes.equals(Buffer.from(canonicalProductionEvidenceJson(value), "utf8"))
  ) {
    fail(
      "PRODUCTION_EVIDENCE_ARTIFACT_INVALID",
      `${field} must be canonical JSON with one trailing LF.`,
    );
  }
  scanForSecrets(value, field);
  return { value: objectAt(value, field), sha256: digest };
}

export interface ProductionEvidenceInput {
  expectedSourceSha: string;
  expectedApiImage: string;
  expectedDatabaseName: string;
  expectedDatabaseUser: string;
  expectedTargetSha256: string;
  expectedSchemaFingerprintSha256: string;
  expectedPreMigrationBackupEvidenceSha256: string;
  expectedBackupIntegritySha256: string;
  expectedTransitionChainSha256: string;
  expectedActivationApprovalSha256: string;
  targetEvidenceB64: string;
  targetEvidenceSha256: string;
  intentEvidenceB64: string;
  intentEvidenceSha256: string;
  executionEvidenceB64: string;
  executionEvidenceSha256: string;
  steadyEvidenceB64: string;
  steadyEvidenceSha256: string;
  releaseEvidenceB64: string;
  releaseEvidenceSha256: string;
  activationApprovalEvidenceB64: string;
  activationApprovalEvidenceSha256: string;
}

export interface ProductionReleaseSummary {
  sourceSha: string;
  apiImage: string;
  apiImageDigest: string;
  publicationReceiptSha256: string;
  reviewedImageSetSha256: string;
  apiRunnableManifestDigest: string;
  apiOciProvenanceSha256: string;
  postgresImage: string;
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

export interface ProductionRuntimeBinding extends ProductionReleaseSummary {
  schemaVersion: "site-logbook.production-runtime-binding/v1";
}

function validateTarget(
  target: Record<string, unknown>,
  input: ProductionEvidenceInput,
  now: number,
): Record<string, unknown> {
  exactKeys(
    target,
    [
      "schemaVersion",
      "kind",
      "logicalEnvironmentId",
      "coolify",
      "build",
      "database",
      "livePostgresTarget",
      "schemaFingerprintSha256",
      "capturedAt",
    ],
    "target",
  );
  requireValue(target.schemaVersion, 2, "target.schemaVersion");
  requireValue(target.kind, TARGET_KIND, "target.kind");
  requireValue(
    target.logicalEnvironmentId,
    PRODUCTION_TARGET.logicalEnvironmentId,
    "target.logicalEnvironmentId",
  );
  const coolify = exactKeys(
    target.coolify,
    [
      "projectId",
      "environmentId",
      "environmentLabel",
      "applicationId",
      "pendingChanges",
      "deployedConfigSha256",
      "desiredConfigSha256",
      "resolvedComposeSha256",
    ],
    "target.coolify",
  );
  for (const key of [
    "projectId",
    "environmentId",
    "environmentLabel",
    "applicationId",
  ] as const) {
    requireValue(coolify[key], PRODUCTION_TARGET[key], `target.coolify.${key}`);
  }
  requireValue(coolify.pendingChanges, false, "target.coolify.pendingChanges");
  const deployed = digestAt(
    coolify.deployedConfigSha256,
    "target.coolify.deployedConfigSha256",
  );
  const desired = digestAt(
    coolify.desiredConfigSha256,
    "target.coolify.desiredConfigSha256",
  );
  requireValue(desired, deployed, "target.coolify.desiredConfigSha256");
  digestAt(
    coolify.resolvedComposeSha256,
    "target.coolify.resolvedComposeSha256",
  );

  const build = exactKeys(
    target.build,
    [
      "sourceSha",
      "provenanceSourceSha",
      "provenanceEvidenceSha256",
      "publicationReceiptSha256",
      "reviewedImageSetSha256",
      "apiRunnableManifestDigest",
      "apiOciProvenanceSha256",
      "apiImage",
      "apiImageDigest",
      "imageProfile",
      "mutatingEntrypointsPresent",
    ],
    "target.build",
  );
  const sourceSha = shaAt(build.sourceSha, "target.build.sourceSha");
  requireValue(sourceSha, input.expectedSourceSha, "target.build.sourceSha");
  requireValue(
    shaAt(build.provenanceSourceSha, "target.build.provenanceSourceSha"),
    sourceSha,
    "target.build.provenanceSourceSha",
  );
  digestAt(
    build.provenanceEvidenceSha256,
    "target.build.provenanceEvidenceSha256",
  );
  for (const field of [
    "publicationReceiptSha256",
    "reviewedImageSetSha256",
    "apiRunnableManifestDigest",
    "apiOciProvenanceSha256",
  ] as const) {
    digestAt(build[field], `target.build.${field}`);
  }
  const apiImage = stringAt(build.apiImage, "target.build.apiImage");
  if (!IMMUTABLE_IMAGE.test(apiImage)) {
    fail(
      "PRODUCTION_EVIDENCE_IMAGE_INVALID",
      "target.build.apiImage must be immutable.",
    );
  }
  requireValue(apiImage, input.expectedApiImage, "target.build.apiImage");
  requireValue(
    digestAt(build.apiImageDigest, "target.build.apiImageDigest"),
    `sha256:${apiImage.split("@sha256:")[1]}`,
    "target.build.apiImageDigest",
  );
  requireValue(build.imageProfile, "production", "target.build.imageProfile");
  requireValue(
    build.mutatingEntrypointsPresent,
    false,
    "target.build.mutatingEntrypointsPresent",
  );

  const database = exactKeys(
    target.database,
    ["name", "user"],
    "target.database",
  );
  requireValue(
    database.name,
    input.expectedDatabaseName,
    "target.database.name",
  );
  requireValue(
    database.user,
    input.expectedDatabaseUser,
    "target.database.user",
  );

  const postgres = exactKeys(
    target.livePostgresTarget,
    [
      "containerId",
      "dockerExportSha256",
      "backendProofSha256",
      "image",
      "imageId",
      "volumeName",
      "networkName",
      "networkId",
      "projectionSha256",
    ],
    "target.livePostgresTarget",
  );
  for (const key of ["containerId", "networkId"] as const) {
    if (
      !HEX64.test(stringAt(postgres[key], `target.livePostgresTarget.${key}`))
    ) {
      fail(
        "PRODUCTION_EVIDENCE_TARGET_INVALID",
        `${key} must be 64 lowercase hex.`,
      );
    }
  }
  digestAt(postgres.imageId, "target.livePostgresTarget.imageId");
  digestAt(
    postgres.dockerExportSha256,
    "target.livePostgresTarget.dockerExportSha256",
  );
  digestAt(
    postgres.backendProofSha256,
    "target.livePostgresTarget.backendProofSha256",
  );
  if (
    !IMMUTABLE_IMAGE.test(
      stringAt(postgres.image, "target.livePostgresTarget.image"),
    )
  ) {
    fail(
      "PRODUCTION_EVIDENCE_IMAGE_INVALID",
      "Postgres image must be immutable.",
    );
  }
  stringAt(postgres.volumeName, "target.livePostgresTarget.volumeName");
  stringAt(postgres.networkName, "target.livePostgresTarget.networkName");
  const projection = {
    containerId: postgres.containerId,
    dockerExportSha256: postgres.dockerExportSha256,
    backendProofSha256: postgres.backendProofSha256,
    image: postgres.image,
    imageId: postgres.imageId,
    networkId: postgres.networkId,
    networkName: postgres.networkName,
    volumeName: postgres.volumeName,
  };
  requireValue(
    digestAt(
      postgres.projectionSha256,
      "target.livePostgresTarget.projectionSha256",
    ),
    productionEvidenceSha256(canonicalProductionEvidenceJson(projection)),
    "target.livePostgresTarget.projectionSha256",
  );
  requireValue(
    digestAt(target.schemaFingerprintSha256, "target.schemaFingerprintSha256"),
    input.expectedSchemaFingerprintSha256,
    "target.schemaFingerprintSha256",
  );
  const capturedAt = timeAt(target.capturedAt, "target.capturedAt");
  if (capturedAt > now + 5 * 60_000) {
    fail(
      "PRODUCTION_EVIDENCE_TIME_INVALID",
      "target.capturedAt is in the future.",
    );
  }
  return target;
}

function validateLineage(value: unknown): Record<string, unknown> {
  const lineage = exactKeys(
    value,
    [
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
    ],
    "steady.lineage",
  );
  for (const [key, expected] of Object.entries({
    decision: "ALREADY_0107",
    mode: "production-copy-restricted",
    knownExpectedMigrations: 107,
    knownAppliedMigrations: 107,
    knownAppliedRowsSha256: AUDIT_SCHEMA_KNOWN_ROWS_SHA256.target,
    latestKnownAppliedTag: "0107_canonical_audit_evidence",
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256:
      AUDIT_SCHEMA_OPAQUE_ROWS_SHA256.productionCopyRestricted,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  })) {
    requireValue(lineage[key], expected, `steady.lineage.${key}`);
  }
  return lineage;
}

function validateBackupIntegrity(
  value: unknown,
  input: ProductionEvidenceInput,
  field: string,
): Record<string, unknown> {
  const integrity = exactKeys(
    value,
    [
      "schemaVersion",
      "verifiedTableNames",
      "verifiedTableCounts",
      "verifiedTableCountsSha256",
      "backupRowBindingSha256",
    ],
    field,
  );
  requireValue(
    integrity.schemaVersion,
    "site-logbook.audit-schema-backup-integrity/v1",
    `${field}.schemaVersion`,
  );
  if (
    !Array.isArray(integrity.verifiedTableNames) ||
    integrity.verifiedTableNames.length === 0 ||
    integrity.verifiedTableNames.some(
      (name) => typeof name !== "string" || !name.trim(),
    ) ||
    new Set(integrity.verifiedTableNames).size !==
      integrity.verifiedTableNames.length
  ) {
    fail(
      "PRODUCTION_EVIDENCE_BACKUP_INTEGRITY_INVALID",
      `${field}.verifiedTableNames is invalid.`,
    );
  }
  const counts = exactKeys(
    integrity.verifiedTableCounts,
    integrity.verifiedTableNames as string[],
    `${field}.verifiedTableCounts`,
  );
  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || Number(count) < 0) {
      fail(
        "PRODUCTION_EVIDENCE_BACKUP_INTEGRITY_INVALID",
        `${field}.verifiedTableCounts.${name} is invalid.`,
      );
    }
  }
  requireValue(
    digestAt(
      integrity.verifiedTableCountsSha256,
      `${field}.verifiedTableCountsSha256`,
    ),
    productionEvidenceSha256(canonicalProductionEvidenceJson(counts)),
    `${field}.verifiedTableCountsSha256`,
  );
  digestAt(integrity.backupRowBindingSha256, `${field}.backupRowBindingSha256`);
  requireValue(
    productionEvidenceSha256(canonicalProductionEvidenceJson(integrity)),
    input.expectedBackupIntegritySha256,
    `${field}Sha256`,
  );
  return integrity;
}

export function validateProductionAudit0107ReleaseEvidence(
  rawInput: ProductionEvidenceInput,
  options: { now?: number } = {},
): ProductionReleaseSummary {
  const input = {
    ...rawInput,
    expectedSourceSha: shaAt(rawInput.expectedSourceSha, "expectedSourceSha"),
    expectedApiImage: stringAt(rawInput.expectedApiImage, "expectedApiImage"),
    expectedDatabaseName: stringAt(
      rawInput.expectedDatabaseName,
      "expectedDatabaseName",
    ),
    expectedDatabaseUser: requireProductionRuntimeDatabaseUser(
      stringAt(rawInput.expectedDatabaseUser, "expectedDatabaseUser"),
    ),
    expectedTargetSha256: digestAt(
      rawInput.expectedTargetSha256,
      "expectedTargetSha256",
    ),
    expectedSchemaFingerprintSha256: digestAt(
      rawInput.expectedSchemaFingerprintSha256,
      "expectedSchemaFingerprintSha256",
    ),
    expectedPreMigrationBackupEvidenceSha256: digestAt(
      rawInput.expectedPreMigrationBackupEvidenceSha256,
      "expectedPreMigrationBackupEvidenceSha256",
    ),
    expectedBackupIntegritySha256: digestAt(
      rawInput.expectedBackupIntegritySha256,
      "expectedBackupIntegritySha256",
    ),
    expectedTransitionChainSha256: digestAt(
      rawInput.expectedTransitionChainSha256,
      "expectedTransitionChainSha256",
    ),
    expectedActivationApprovalSha256: digestAt(
      rawInput.expectedActivationApprovalSha256,
      "expectedActivationApprovalSha256",
    ),
  };
  if (!IMMUTABLE_IMAGE.test(input.expectedApiImage)) {
    fail(
      "PRODUCTION_EVIDENCE_IMAGE_INVALID",
      "expectedApiImage must be immutable.",
    );
  }
  const now = options.now ?? Date.now();
  const targetArtifact = decodeArtifact(
    input.targetEvidenceB64,
    input.targetEvidenceSha256,
    "targetEvidence",
  );
  requireValue(
    targetArtifact.sha256,
    input.expectedTargetSha256,
    "targetEvidenceSha256",
  );
  const target = validateTarget(targetArtifact.value, input, now);
  const intentArtifact = decodeArtifact(
    input.intentEvidenceB64,
    input.intentEvidenceSha256,
    "intentEvidence",
  );
  const intent = exactKeys(
    intentArtifact.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "targetEvidenceSha256",
      "expectedSchemaFingerprintSha256",
      "backupIntegrity",
      "productionTargetsTouched",
      "confirmation",
      "authorizesApplicationStart",
    ],
    "intent",
  );
  requireValue(intent.schemaVersion, 1, "intent.schemaVersion");
  requireValue(intent.kind, INTENT_KIND, "intent.kind");
  requireValue(intent.sourceSha, input.expectedSourceSha, "intent.sourceSha");
  requireValue(
    intent.targetEvidenceSha256,
    targetArtifact.sha256,
    "intent.targetEvidenceSha256",
  );
  requireValue(
    intent.expectedSchemaFingerprintSha256,
    input.expectedSchemaFingerprintSha256,
    "intent.expectedSchemaFingerprintSha256",
  );
  const intentBackupIntegrity = validateBackupIntegrity(
    intent.backupIntegrity,
    input,
    "intent.backupIntegrity",
  );
  requireValue(
    intent.productionTargetsTouched,
    true,
    "intent.productionTargetsTouched",
  );
  requireValue(
    intent.confirmation,
    TRANSITION_CONFIRMATION,
    "intent.confirmation",
  );
  requireValue(
    intent.authorizesApplicationStart,
    false,
    "intent.authorizesApplicationStart",
  );

  const executionArtifact = decodeArtifact(
    input.executionEvidenceB64,
    input.executionEvidenceSha256,
    "executionEvidence",
  );
  const execution = exactKeys(
    executionArtifact.value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "operation",
      "sourceSha",
      "targetEvidenceSha256",
      "intentEvidenceSha256",
      "expectedSchemaFingerprintSha256",
      "backupIntegrity",
      "productionTargetsTouched",
      "migration0107AppliedOrVerified",
      "preMigrationBackupEvidenceSha256",
      "transitionChainSha256",
      "completedAt",
      "authorizesApplicationStart",
    ],
    "execution",
  );
  requireValue(execution.schemaVersion, 1, "execution.schemaVersion");
  requireValue(execution.kind, EXECUTION_KIND, "execution.kind");
  requireValue(execution.decision, "PASS", "execution.decision");
  if (!["applied", "verified-noop"].includes(String(execution.operation))) {
    fail(
      "PRODUCTION_EVIDENCE_BINDING_INVALID",
      "execution.operation is invalid.",
    );
  }
  requireValue(
    execution.sourceSha,
    input.expectedSourceSha,
    "execution.sourceSha",
  );
  requireValue(
    execution.targetEvidenceSha256,
    targetArtifact.sha256,
    "execution.targetEvidenceSha256",
  );
  requireValue(
    execution.intentEvidenceSha256,
    intentArtifact.sha256,
    "execution.intentEvidenceSha256",
  );
  requireValue(
    execution.expectedSchemaFingerprintSha256,
    input.expectedSchemaFingerprintSha256,
    "execution.expectedSchemaFingerprintSha256",
  );
  const executionBackupIntegrity = validateBackupIntegrity(
    execution.backupIntegrity,
    input,
    "execution.backupIntegrity",
  );
  requireValue(
    canonicalProductionEvidenceJson(executionBackupIntegrity),
    canonicalProductionEvidenceJson(intentBackupIntegrity),
    "execution.backupIntegrity",
  );
  requireValue(
    execution.productionTargetsTouched,
    true,
    "execution.productionTargetsTouched",
  );
  requireValue(
    execution.migration0107AppliedOrVerified,
    true,
    "execution.migration0107AppliedOrVerified",
  );
  requireValue(
    digestAt(
      execution.preMigrationBackupEvidenceSha256,
      "execution.preMigrationBackupEvidenceSha256",
    ),
    input.expectedPreMigrationBackupEvidenceSha256,
    "execution.preMigrationBackupEvidenceSha256",
  );
  requireValue(
    digestAt(
      execution.transitionChainSha256,
      "execution.transitionChainSha256",
    ),
    input.expectedTransitionChainSha256,
    "execution.transitionChainSha256",
  );
  const completedAt = timeAt(execution.completedAt, "execution.completedAt");
  requireValue(
    execution.authorizesApplicationStart,
    false,
    "execution.authorizesApplicationStart",
  );

  const steadyArtifact = decodeArtifact(
    input.steadyEvidenceB64,
    input.steadyEvidenceSha256,
    "steadyEvidence",
  );
  const steady = exactKeys(
    steadyArtifact.value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "sourceSha",
      "targetEvidenceSha256",
      "productionTargetsTouched",
      "databaseName",
      "databaseUser",
      "schemaFingerprintSha256",
      "lineage",
      "checkedAt",
      "authorizesApplicationStart",
    ],
    "steady",
  );
  requireValue(steady.schemaVersion, 1, "steady.schemaVersion");
  requireValue(steady.kind, STEADY_KIND, "steady.kind");
  requireValue(steady.decision, "ALREADY_0107", "steady.decision");
  requireValue(steady.sourceSha, input.expectedSourceSha, "steady.sourceSha");
  requireValue(
    steady.targetEvidenceSha256,
    targetArtifact.sha256,
    "steady.targetEvidenceSha256",
  );
  requireValue(
    steady.productionTargetsTouched,
    true,
    "steady.productionTargetsTouched",
  );
  requireValue(
    steady.databaseName,
    input.expectedDatabaseName,
    "steady.databaseName",
  );
  requireValue(
    steady.databaseUser,
    input.expectedDatabaseUser,
    "steady.databaseUser",
  );
  requireValue(
    steady.schemaFingerprintSha256,
    input.expectedSchemaFingerprintSha256,
    "steady.schemaFingerprintSha256",
  );
  const lineage = validateLineage(steady.lineage);
  const checkedAt = timeAt(steady.checkedAt, "steady.checkedAt");
  if (checkedAt < completedAt || checkedAt > now + 5 * 60_000) {
    fail(
      "PRODUCTION_EVIDENCE_TIME_INVALID",
      "steady check must follow execution.",
    );
  }
  requireValue(
    steady.authorizesApplicationStart,
    true,
    "steady.authorizesApplicationStart",
  );

  const releaseArtifact = decodeArtifact(
    input.releaseEvidenceB64,
    input.releaseEvidenceSha256,
    "releaseEvidence",
  );
  const release = exactKeys(
    releaseArtifact.value,
    [
      "schemaVersion",
      "kind",
      "sourceSha",
      "targetEvidenceSha256",
      "intentEvidenceSha256",
      "executionEvidenceSha256",
      "steadyEvidenceSha256",
      "confirmation",
      "activationApprovalSha256",
      "approvedAt",
      "operator",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    "release",
  );
  requireValue(release.schemaVersion, 1, "release.schemaVersion");
  requireValue(release.kind, RELEASE_KIND, "release.kind");
  requireValue(release.sourceSha, input.expectedSourceSha, "release.sourceSha");
  requireValue(
    release.targetEvidenceSha256,
    targetArtifact.sha256,
    "release.targetEvidenceSha256",
  );
  requireValue(
    release.intentEvidenceSha256,
    intentArtifact.sha256,
    "release.intentEvidenceSha256",
  );
  requireValue(
    release.executionEvidenceSha256,
    executionArtifact.sha256,
    "release.executionEvidenceSha256",
  );
  requireValue(
    release.steadyEvidenceSha256,
    steadyArtifact.sha256,
    "release.steadyEvidenceSha256",
  );
  requireValue(
    release.confirmation,
    START_CONFIRMATION,
    "release.confirmation",
  );
  requireValue(
    digestAt(
      release.activationApprovalSha256,
      "release.activationApprovalSha256",
    ),
    input.expectedActivationApprovalSha256,
    "release.activationApprovalSha256",
  );
  stringAt(release.operator, "release.operator");
  const approvedAt = timeAt(release.approvedAt, "release.approvedAt");
  if (approvedAt < checkedAt || approvedAt > now + 5 * 60_000) {
    fail(
      "PRODUCTION_EVIDENCE_TIME_INVALID",
      "release approval must follow steady evidence.",
    );
  }
  requireValue(
    release.productionTargetsTouched,
    true,
    "release.productionTargetsTouched",
  );
  requireValue(
    release.authorizesApplicationStart,
    true,
    "release.authorizesApplicationStart",
  );

  const activationApprovalArtifact = decodeArtifact(
    input.activationApprovalEvidenceB64,
    input.activationApprovalEvidenceSha256,
    "activationApprovalEvidence",
  );
  requireValue(
    activationApprovalArtifact.sha256,
    input.expectedActivationApprovalSha256,
    "activationApprovalEvidenceSha256",
  );
  const activationApproval = exactKeys(
    activationApprovalArtifact.value,
    [
      "schemaVersion",
      "sourceSha",
      "targetEvidenceSha256",
      "confirmation",
      "approvedAt",
      "operator",
    ],
    "activationApprovalEvidence",
  );
  requireValue(
    activationApproval.schemaVersion,
    ACTIVATION_APPROVAL_SCHEMA,
    "activationApprovalEvidence.schemaVersion",
  );
  requireValue(
    activationApproval.sourceSha,
    input.expectedSourceSha,
    "activationApprovalEvidence.sourceSha",
  );
  requireValue(
    activationApproval.targetEvidenceSha256,
    targetArtifact.sha256,
    "activationApprovalEvidence.targetEvidenceSha256",
  );
  requireValue(
    activationApproval.confirmation,
    START_CONFIRMATION,
    "activationApprovalEvidence.confirmation",
  );
  requireValue(
    activationApproval.approvedAt,
    release.approvedAt,
    "activationApprovalEvidence.approvedAt",
  );
  requireValue(
    activationApproval.operator,
    release.operator,
    "activationApprovalEvidence.operator",
  );

  const coolify = target.coolify as Record<string, unknown>;
  const build = target.build as Record<string, unknown>;
  const postgres = target.livePostgresTarget as Record<string, unknown>;
  return Object.freeze({
    sourceSha: input.expectedSourceSha,
    apiImage: input.expectedApiImage,
    apiImageDigest: String(build.apiImageDigest),
    publicationReceiptSha256: String(build.publicationReceiptSha256),
    reviewedImageSetSha256: String(build.reviewedImageSetSha256),
    apiRunnableManifestDigest: String(build.apiRunnableManifestDigest),
    apiOciProvenanceSha256: String(build.apiOciProvenanceSha256),
    postgresImage: String(postgres.image),
    targetEvidenceSha256: targetArtifact.sha256,
    releaseEvidenceSha256: releaseArtifact.sha256,
    resolvedComposeSha256: String(coolify.resolvedComposeSha256),
    deployedConfigSha256: String(coolify.deployedConfigSha256),
    desiredConfigSha256: String(coolify.desiredConfigSha256),
    livePostgresTargetSha256: String(postgres.projectionSha256),
    databaseName: input.expectedDatabaseName,
    databaseUser: input.expectedDatabaseUser,
    schemaFingerprintSha256: input.expectedSchemaFingerprintSha256,
    preMigrationBackupEvidenceSha256:
      input.expectedPreMigrationBackupEvidenceSha256,
    backupIntegritySha256: input.expectedBackupIntegritySha256,
    transitionChainSha256: input.expectedTransitionChainSha256,
    activationApprovalSha256: input.expectedActivationApprovalSha256,
    lineage: Object.freeze({ ...lineage }),
  });
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("PRODUCTION_EVIDENCE_ENV_MISSING", `${key} is required.`);
  }
  return value;
}

export function readProductionEvidenceInput(
  env: NodeJS.ProcessEnv = process.env,
): ProductionEvidenceInput {
  return {
    expectedSourceSha: required(env, "PRODUCTION_EXPECTED_SOURCE_SHA"),
    expectedApiImage: required(env, "PRODUCTION_EXPECTED_API_IMAGE"),
    expectedDatabaseName: required(env, "PRODUCTION_EXPECTED_DATABASE_NAME"),
    expectedDatabaseUser: required(env, "PRODUCTION_EXPECTED_DATABASE_USER"),
    expectedTargetSha256: required(env, "PRODUCTION_EXPECTED_TARGET_SHA256"),
    expectedSchemaFingerprintSha256: required(
      env,
      "PRODUCTION_EXPECTED_AUDIT_SCHEMA_FINGERPRINT_SHA256",
    ),
    expectedPreMigrationBackupEvidenceSha256: required(
      env,
      "PRODUCTION_EXPECTED_PRE_MIGRATION_BACKUP_EVIDENCE_SHA256",
    ),
    expectedBackupIntegritySha256: required(
      env,
      "PRODUCTION_EXPECTED_BACKUP_INTEGRITY_SHA256",
    ),
    expectedTransitionChainSha256: required(
      env,
      "PRODUCTION_EXPECTED_0096_0107_TRANSITION_CHAIN_SHA256",
    ),
    expectedActivationApprovalSha256: required(
      env,
      "PRODUCTION_EXPECTED_ACTIVATION_APPROVAL_SHA256",
    ),
    targetEvidenceB64: required(
      env,
      "PRODUCTION_AUDIT_0107_TARGET_EVIDENCE_B64",
    ),
    targetEvidenceSha256: required(
      env,
      "PRODUCTION_AUDIT_0107_TARGET_EVIDENCE_SHA256",
    ),
    intentEvidenceB64: required(
      env,
      "PRODUCTION_AUDIT_0107_INTENT_EVIDENCE_B64",
    ),
    intentEvidenceSha256: required(
      env,
      "PRODUCTION_AUDIT_0107_INTENT_EVIDENCE_SHA256",
    ),
    executionEvidenceB64: required(
      env,
      "PRODUCTION_AUDIT_0107_EXECUTION_EVIDENCE_B64",
    ),
    executionEvidenceSha256: required(
      env,
      "PRODUCTION_AUDIT_0107_EXECUTION_EVIDENCE_SHA256",
    ),
    steadyEvidenceB64: required(
      env,
      "PRODUCTION_AUDIT_0107_STEADY_EVIDENCE_B64",
    ),
    steadyEvidenceSha256: required(
      env,
      "PRODUCTION_AUDIT_0107_STEADY_EVIDENCE_SHA256",
    ),
    releaseEvidenceB64: required(
      env,
      "PRODUCTION_AUDIT_0107_RELEASE_EVIDENCE_B64",
    ),
    releaseEvidenceSha256: required(
      env,
      "PRODUCTION_AUDIT_0107_RELEASE_EVIDENCE_SHA256",
    ),
    activationApprovalEvidenceB64: required(
      env,
      "PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_B64",
    ),
    activationApprovalEvidenceSha256: required(
      env,
      "PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_SHA256",
    ),
  };
}

export function createProductionRuntimeBinding(
  summary: ProductionReleaseSummary,
): ProductionRuntimeBinding {
  return Object.freeze({
    schemaVersion: "site-logbook.production-runtime-binding/v1",
    sourceSha: summary.sourceSha,
    apiImage: summary.apiImage,
    apiImageDigest: summary.apiImageDigest,
    publicationReceiptSha256: summary.publicationReceiptSha256,
    reviewedImageSetSha256: summary.reviewedImageSetSha256,
    apiRunnableManifestDigest: summary.apiRunnableManifestDigest,
    apiOciProvenanceSha256: summary.apiOciProvenanceSha256,
    postgresImage: summary.postgresImage,
    targetEvidenceSha256: summary.targetEvidenceSha256,
    releaseEvidenceSha256: summary.releaseEvidenceSha256,
    resolvedComposeSha256: summary.resolvedComposeSha256,
    deployedConfigSha256: summary.deployedConfigSha256,
    desiredConfigSha256: summary.desiredConfigSha256,
    livePostgresTargetSha256: summary.livePostgresTargetSha256,
    databaseName: summary.databaseName,
    databaseUser: summary.databaseUser,
    schemaFingerprintSha256: summary.schemaFingerprintSha256,
    preMigrationBackupEvidenceSha256: summary.preMigrationBackupEvidenceSha256,
    backupIntegritySha256: summary.backupIntegritySha256,
    transitionChainSha256: summary.transitionChainSha256,
    activationApprovalSha256: summary.activationApprovalSha256,
    lineage: summary.lineage,
  });
}

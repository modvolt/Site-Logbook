// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import { parseProductionExact0096BackupPlan } from "../../../../scripts/production-evidence/production-exact-0096-backup-planner.mjs";
import { createHash } from "node:crypto";
// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import {
  parseProductionExact0096BackupExecutorTrace,
  parseProductionExact0096BackupReceipt,
} from "../../../../scripts/production-evidence/production-exact-0096-backup-receipt.mjs";
// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import { verifyDetachedProductionExact0096BackupSignature } from "../../../../scripts/production-evidence/production-exact-0096-backup-signature.mjs";
// @ts-ignore -- the exact public-only backup trust root is source-pinned outside the API rootDir.
import {
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
} from "../../../../scripts/production-evidence/production-migration-pinned-keys.mjs";
// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import { parseCanonicalProductionMigrationArtifact } from "../../../../scripts/production-evidence/production-migration-contract.mjs";
// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import { validateProductionMigrationPlan } from "../../../../scripts/production-evidence/production-migration-planner.mjs";
// @ts-ignore -- canonical production evidence parsers intentionally live outside the API rootDir.
import { verifyProductionMigrationTransitionChain } from "../../../../scripts/production-evidence/production-migration-verifier.mjs";
// @ts-ignore -- the producer-owned exact host observation parser intentionally lives outside the API rootDir.
import {
  OBSERVATION_REQUEST_SCHEMA,
  verifyProductionApiImageProvenanceArtifact,
  verifyProductionObservationExports,
} from "../../../../scripts/production-evidence/host-attestation-contract.mjs";
import {
  PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER,
  type ProductionRuntimeDbCredentialReceiptParser,
  type ProductionRuntimeDbCredentialReceiptParserInput,
  type ProductionRuntimeDbCredentialReceiptVerdict,
} from "./production-runtime-db-credential-cutover";
import {
  canonicalProductionActivationJson,
  ProductionActivationError,
  type JsonValue,
  type ProductionActivationBundleV2,
} from "./production-activation-hold";
import type { ProductionReleaseSummary } from "./production-startup-evidence";

interface CanonicalArtifact<T = Record<string, unknown>> {
  canonical: string;
  sha256: string;
  value: T;
}

export const PRODUCTION_ACTIVATION_APPROVAL_SCHEMA =
  "site-logbook.production-activation-approval/v2" as const;
export const PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION =
  "AUTHORIZE_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_V2" as const;
export const PRODUCTION_ACTIVATION_CONTRACT_TEST_CONFIRMATION =
  "USE_PRODUCTION_ACTIVATION_CONTRACT_TEST_ADAPTERS_ONLY" as const;
export const PRODUCTION_INVOICE_0108_CREDENTIAL_EXECUTION_SOURCE_SHA =
  "6d4d1e73f047974856907e712cf44cdf7ea0236a" as const;

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CONTAINER_ID = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/;
const FULL_CONTAINER_ID = /^[0-9a-f]{64}$/;
const SHORT_CONTAINER_ID = /^[0-9a-f]{12}$/;
const NONCE = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const COMPOSE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const VOLUME_DESTINATION = /^\/[a-z0-9._/-]{1,255}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const OPERATOR = /^[a-z0-9][a-z0-9._@/-]{2,127}$/;
const APPROVAL_KEYS = [
  "schemaVersion",
  "kind",
  "decision",
  "confirmation",
  "sourceSha",
  "apiImage",
  "nonce",
  "containerId",
  "desiredConfigSha256",
  "deployedConfigSha256",
  "resolvedComposeSha256",
  "databaseName",
  "databaseUser",
  "schemaFingerprintSha256",
  "composeProject",
  "postgresService",
  "postgresVolumeDestination",
  "expectedNetworkServices",
  "migrationTransitionSha256",
  "finalLiveIdentitySha256",
  "credentialRequestSha256",
  "credentialReceiptSha256",
  "coolifyObservationSha256",
  "dockerObservationSha256",
  "postgresObservationSha256",
  "approvedAt",
  "operator",
  "authorizesApplicationStart",
  "authorizesDeployment",
] as const;

export interface ProductionObservationVerificationVerdict {
  sourceSha: string;
  apiImage: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  capturedAt: string;
  coolifyObservedAt: string;
  dockerObservedAt: string;
  postgresObservedAt: string;
  desiredConfigSha256: string;
  deployedConfigSha256: string;
  resolvedComposeSha256: string;
  apiContainerId: string;
  apiContainerImage: string;
  apiContainerImageId: string;
  postgresContainerId: string;
  postgresImage: string;
  dockerExportSha256: string;
  backendProofSha256: string;
  coolifySha256: string;
  dockerSha256: string;
  postgresSha256: string;
}

export interface ProductionApiImageProvenanceVerdict {
  sha256: string;
  sourceSha: string;
  subjectImage: string;
  publicationReceiptSha256: string;
  reviewedImageSetSha256: string;
  subjectRunnableManifestDigest: string;
  ociProvenanceSha256: string;
}

export interface ProductionActivationApprovalV2 {
  schemaVersion: typeof PRODUCTION_ACTIVATION_APPROVAL_SCHEMA;
  kind: "site-logbook-production-activation-approval-v2";
  decision: "APPROVE";
  confirmation: typeof PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION;
  sourceSha: string;
  apiImage: string;
  nonce: string;
  containerId: string;
  desiredConfigSha256: string;
  deployedConfigSha256: string;
  resolvedComposeSha256: string;
  databaseName: string;
  databaseUser: string;
  schemaFingerprintSha256: string;
  composeProject: string;
  postgresService: string;
  postgresVolumeDestination: string;
  expectedNetworkServices: readonly ["api", "postgres", "web"];
  migrationTransitionSha256: string;
  finalLiveIdentitySha256: string;
  credentialRequestSha256: string;
  credentialReceiptSha256: string;
  coolifyObservationSha256: string;
  dockerObservationSha256: string;
  postgresObservationSha256: string;
  approvedAt: string;
  operator: string;
  authorizesApplicationStart: true;
  authorizesDeployment: false;
}

export type {
  ProductionRuntimeDbCredentialReceiptParser,
  ProductionRuntimeDbCredentialReceiptParserInput,
  ProductionRuntimeDbCredentialReceiptVerdict,
};

export interface ProductionActivationContractAdapters {
  parseBackupPlan(canonical: string): CanonicalArtifact;
  parseBackupTrace(canonical: string, planCanonical: string): CanonicalArtifact;
  parseBackupReceipt(
    canonical: string,
    planCanonical: string,
    traceCanonical: string,
  ): CanonicalArtifact;
  verifyBackupSignature(input: {
    envelopeCanonical: string;
    detachedSignature: string;
    planCanonical: string;
    executorTraceCanonical: string;
    receiptCanonical: string;
  }): CanonicalArtifact & { publicKeySha256: string };
  parseMigrationArtifact(canonical: string, field: string): CanonicalArtifact;
  validateMigrationPlan(
    value: Record<string, unknown>,
  ): Record<string, unknown>;
  verifyMigrationTransition(input: {
    chainCanonical: string;
    planCanonical: string;
    intentCanonical: string;
    intentPersistenceReceiptCanonical: string;
    receiptCanonicals: string[];
    finalInventory: unknown;
    finalLiveIdentityCanonical: string;
    roleTransactionReceiptCanonical: string;
    postCommitRoleArtifactCanonical: string;
  }): CanonicalArtifact;
  verifyApiImageProvenance?(input: {
    canonical: string;
    signature: string;
    sourceSha: string;
    expectedApiImage: string;
  }): ProductionApiImageProvenanceVerdict;
  credentialReceiptParser?: ProductionRuntimeDbCredentialReceiptParser;
  verifyFinalObservations?(input: {
    request: Record<string, unknown>;
    coolifyCanonical: string;
    dockerCanonical: string;
    postgresCanonical: string;
    activationIssuedAt: string;
  }): ProductionObservationVerificationVerdict;
}

const DIRECT_ADAPTERS: ProductionActivationContractAdapters = Object.freeze({
  parseBackupPlan: parseProductionExact0096BackupPlan,
  parseBackupTrace: parseProductionExact0096BackupExecutorTrace,
  parseBackupReceipt: parseProductionExact0096BackupReceipt,
  verifyBackupSignature: (
    input: Parameters<
      ProductionActivationContractAdapters["verifyBackupSignature"]
    >[0],
  ) =>
    verifyDetachedProductionExact0096BackupSignature({
      ...input,
      trustedHostAttestationKeys: PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
      expectedHostEvidencePublicKeySha256:
        PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
    }),
  parseMigrationArtifact: parseCanonicalProductionMigrationArtifact,
  validateMigrationPlan: validateProductionMigrationPlan,
  verifyMigrationTransition: verifyProductionMigrationTransitionChain,
  verifyApiImageProvenance: verifyProductionApiImageProvenanceArtifact,
  credentialReceiptParser: PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER,
  verifyFinalObservations: verifyProductionObservationExports,
});

function fail(code: string, message: string): never {
  throw new ProductionActivationError(code, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      `${field} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function exactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  field: string,
): Record<string, unknown> {
  const result = record(value, field);
  const actual = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return result;
}

function exactString(value: unknown, field: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail("PRODUCTION_ACTIVATION_SEMANTIC_INVALID", `${field} is invalid.`);
  }
  return value;
}

function exactCanonicalArtifact(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 16 * 1024
  ) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      `${field} must be one bounded canonical artifact.`,
    );
  }
  return value;
}

function exactDetachedSignatureBase64(value: unknown, field: string): string {
  const encoded = exactString(value, field, /^[A-Za-z0-9+/]{86}==$/);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || bytes.toString("base64") !== encoded) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      `${field} must be one canonical padded-base64 Ed25519 signature.`,
    );
  }
  return encoded;
}

function exactTimestamp(
  value: unknown,
  field: string,
): Readonly<{ text: string; millis: number }> {
  if (typeof value !== "string" || value.length !== 24) {
    fail(
      "PRODUCTION_ACTIVATION_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== value) {
    fail(
      "PRODUCTION_ACTIVATION_TIME_INVALID",
      `${field} must be a canonical UTC timestamp.`,
    );
  }
  return Object.freeze({ text: value, millis });
}

function prefixedSha256(canonical: string): string {
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Producer-owned parser for the only approval payload that may authorize the
 * exact v2 activation. The approval remains inert until the contract binds it
 * to all authoritative producer verdicts below.
 */
export function parseProductionActivationApprovalV2(
  canonical: string,
): ProductionActivationApprovalV2 {
  if (arguments.length !== 1 || typeof canonical !== "string") {
    fail(
      "PRODUCTION_ACTIVATION_APPROVAL_INVALID",
      "activation approval must be one canonical artifact.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonical);
  } catch {
    fail(
      "PRODUCTION_ACTIVATION_APPROVAL_INVALID",
      "activation approval must be canonical JSON.",
    );
  }
  if (canonicalProductionActivationJson(parsed) !== canonical) {
    fail(
      "PRODUCTION_ACTIVATION_APPROVAL_INVALID",
      "activation approval bytes are not canonical sorted-key JSON.",
    );
  }
  const approval = exactRecord(parsed, APPROVAL_KEYS, "activationApproval");
  if (
    approval.schemaVersion !== PRODUCTION_ACTIVATION_APPROVAL_SCHEMA ||
    approval.kind !== "site-logbook-production-activation-approval-v2" ||
    approval.decision !== "APPROVE" ||
    approval.confirmation !== PRODUCTION_ACTIVATION_APPROVAL_CONFIRMATION ||
    approval.authorizesApplicationStart !== true ||
    approval.authorizesDeployment !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_APPROVAL_DENIED",
      "activation approval is not the exact explicit application-start approval.",
    );
  }
  exactString(approval.sourceSha, "activationApproval.sourceSha", SOURCE_SHA);
  exactString(
    approval.apiImage,
    "activationApproval.apiImage",
    IMMUTABLE_IMAGE,
  );
  exactString(approval.nonce, "activationApproval.nonce", NONCE);
  exactString(
    approval.containerId,
    "activationApproval.containerId",
    CONTAINER_ID,
  );
  for (const key of [
    "desiredConfigSha256",
    "deployedConfigSha256",
    "resolvedComposeSha256",
  ] as const) {
    exactString(approval[key], `activationApproval.${key}`, RAW_SHA256);
  }
  exactString(
    approval.databaseName,
    "activationApproval.databaseName",
    IDENTIFIER,
  );
  exactString(
    approval.databaseUser,
    "activationApproval.databaseUser",
    IDENTIFIER,
  );
  exactString(
    approval.schemaFingerprintSha256,
    "activationApproval.schemaFingerprintSha256",
    SHA256,
  );
  exactString(
    approval.composeProject,
    "activationApproval.composeProject",
    COMPOSE_NAME,
  );
  exactString(
    approval.postgresService,
    "activationApproval.postgresService",
    IDENTIFIER,
  );
  exactString(
    approval.postgresVolumeDestination,
    "activationApproval.postgresVolumeDestination",
    VOLUME_DESTINATION,
  );
  if (
    approval.postgresService !== "postgres" ||
    approval.postgresVolumeDestination !== "/var/lib/postgresql/data" ||
    !Array.isArray(approval.expectedNetworkServices) ||
    approval.expectedNetworkServices.length !== 3 ||
    approval.expectedNetworkServices[0] !== "api" ||
    approval.expectedNetworkServices[1] !== "postgres" ||
    approval.expectedNetworkServices[2] !== "web"
  ) {
    fail(
      "PRODUCTION_ACTIVATION_APPROVAL_INVALID",
      "activation approval is not the exact reviewed PostgreSQL topology.",
    );
  }
  for (const key of [
    "migrationTransitionSha256",
    "finalLiveIdentitySha256",
    "credentialRequestSha256",
    "credentialReceiptSha256",
    "coolifyObservationSha256",
    "dockerObservationSha256",
    "postgresObservationSha256",
  ] as const) {
    exactString(approval[key], `activationApproval.${key}`, SHA256);
  }
  exactTimestamp(approval.approvedAt, "activationApproval.approvedAt");
  exactString(approval.operator, "activationApproval.operator", OPERATOR);
  return Object.freeze(approval as unknown as ProductionActivationApprovalV2);
}

function artifactPayload(
  parent: Record<string, unknown>,
  key: string,
  field: string,
): JsonValue {
  const artifact = record(parent[key], `${field}.${key}`);
  if (!("payload" in artifact)) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      `${field}.${key} has no actual payload.`,
    );
  }
  return artifact.payload as JsonValue;
}

function canonicalArtifactPayload(
  parent: Record<string, unknown>,
  key: string,
  field: string,
): string {
  return canonicalProductionActivationJson(artifactPayload(parent, key, field));
}

function exactEqual(actual: unknown, expected: unknown, field: string): void {
  if (actual !== expected) {
    fail(
      "PRODUCTION_ACTIVATION_CROSS_BINDING_INVALID",
      `${field} is not the exact canonical artifact already verified in this bundle.`,
    );
  }
}

/**
 * Docker's default in-container hostname is the unique 12-hex short form of
 * the 64-hex daemon ID returned by `docker container inspect`. A caller that
 * already has the full ID receives no prefix relaxation.
 */
export function productionActivationContainerIdMatches(
  challengeContainerId: string,
  observedContainerId: string,
): boolean {
  if (!FULL_CONTAINER_ID.test(observedContainerId)) return false;
  if (FULL_CONTAINER_ID.test(challengeContainerId)) {
    return challengeContainerId === observedContainerId;
  }
  return (
    SHORT_CONTAINER_ID.test(challengeContainerId) &&
    observedContainerId.startsWith(challengeContainerId)
  );
}

function requireObservedContainerIdBinding(
  challengeContainerId: unknown,
  observedContainerId: unknown,
): void {
  if (
    typeof challengeContainerId !== "string" ||
    typeof observedContainerId !== "string" ||
    !productionActivationContainerIdMatches(
      challengeContainerId,
      observedContainerId,
    )
  ) {
    fail(
      "PRODUCTION_ACTIVATION_CROSS_BINDING_INVALID",
      "observations.apiContainerId is not the exact full Docker ID bound by the runtime challenge.",
    );
  }
}

function detachedSignature(backup: Record<string, unknown>): string {
  const payload = record(
    artifactPayload(
      backup,
      "detachedSignature",
      "activation.evidence.exact0096Backup",
    ),
    "activation.evidence.exact0096Backup.detachedSignature.payload",
  );
  const value = payload.signatureBase64;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      "exact-0096 detached signature payload is invalid.",
    );
  }
  return value;
}

/**
 * Directly re-runs the source-pinned API-image provenance, canonical exact-0096,
 * 0096->0107 and runtime credential producer-owned parsers before HOLD may
 * start any application work.
 */
async function verifyProductionActivationContractV2Core(
  bundle: ProductionActivationBundleV2,
  adapters: ProductionActivationContractAdapters,
  credentialExecutorSourceSha?: string,
): Promise<ProductionReleaseSummary> {
  const activation = record(bundle.activation, "activation");
  const expectedCredentialExecutorSourceSha =
    credentialExecutorSourceSha ?? String(activation.sourceSha);
  if (!SOURCE_SHA.test(expectedCredentialExecutorSourceSha)) {
    fail(
      "PRODUCTION_ACTIVATION_CREDENTIAL_EXECUTOR_SOURCE_INVALID",
      "the pinned runtime credential executor source is invalid.",
    );
  }
  const evidence = record(activation.evidence, "activation.evidence");
  const backup = record(
    evidence.exact0096Backup,
    "activation.evidence.exact0096Backup",
  );
  const migration = record(
    evidence.migration0096To0107,
    "activation.evidence.migration0096To0107",
  );
  const credential = record(
    evidence.runtimeDatabaseCredentialCutover,
    "activation.evidence.runtimeDatabaseCredentialCutover",
  );
  const observations = record(
    evidence.finalObservations,
    "activation.evidence.finalObservations",
  );
  const apiImageProvenance = exactRecord(
    evidence.apiImageProvenance,
    ["canonical", "signatureB64"],
    "activation.evidence.apiImageProvenance",
  );
  const hostAttestation = record(bundle.hostAttestation, "hostAttestation");
  if (!adapters.verifyApiImageProvenance) {
    fail(
      "PRODUCTION_ACTIVATION_PROVENANCE_PARSER_MISSING",
      "the API image provenance producer exports no authoritative source-pinned verifier; remain in HOLD.",
    );
  }
  let imageProvenanceVerdict: ProductionApiImageProvenanceVerdict;
  try {
    imageProvenanceVerdict = adapters.verifyApiImageProvenance({
      canonical: exactCanonicalArtifact(
        apiImageProvenance.canonical,
        "activation.evidence.apiImageProvenance.canonical",
      ),
      signature: exactDetachedSignatureBase64(
        apiImageProvenance.signatureB64,
        "activation.evidence.apiImageProvenance.signatureB64",
      ),
      sourceSha: exactString(
        activation.sourceSha,
        "activation.sourceSha",
        SOURCE_SHA,
      ),
      expectedApiImage: exactString(
        activation.apiImage,
        "activation.apiImage",
        IMMUTABLE_IMAGE,
      ),
    });
  } catch (error) {
    if (error instanceof ProductionActivationError) throw error;
    fail(
      "PRODUCTION_ACTIVATION_PROVENANCE_INVALID",
      "the signed API image provenance artifact is invalid or does not match this activation.",
    );
  }
  exactEqual(
    imageProvenanceVerdict.sourceSha,
    activation.sourceSha,
    "apiImageProvenance.sourceSha",
  );
  exactEqual(
    imageProvenanceVerdict.subjectImage,
    activation.apiImage,
    "apiImageProvenance.subjectImage",
  );
  for (const field of [
    "publicationReceiptSha256",
    "reviewedImageSetSha256",
    "subjectRunnableManifestDigest",
    "ociProvenanceSha256",
  ] as const) {
    exactString(
      imageProvenanceVerdict[field],
      `apiImageProvenance.${field}`,
      SHA256,
    );
  }
  const approvalCanonical = canonicalArtifactPayload(
    evidence,
    "activationApproval",
    "activation.evidence",
  );
  const approval = parseProductionActivationApprovalV2(approvalCanonical);

  const backupPlanCanonical = canonicalArtifactPayload(
    backup,
    "plan",
    "activation.evidence.exact0096Backup",
  );
  const backupTraceCanonical = canonicalArtifactPayload(
    backup,
    "trace",
    "activation.evidence.exact0096Backup",
  );
  const backupReceiptCanonical = canonicalArtifactPayload(
    backup,
    "passReceipt",
    "activation.evidence.exact0096Backup",
  );
  const backupSignatureCanonical = canonicalArtifactPayload(
    backup,
    "signature",
    "activation.evidence.exact0096Backup",
  );
  const backupPlan = adapters.parseBackupPlan(backupPlanCanonical);
  const backupTrace = adapters.parseBackupTrace(
    backupTraceCanonical,
    backupPlanCanonical,
  );
  const backupReceipt = adapters.parseBackupReceipt(
    backupReceiptCanonical,
    backupPlanCanonical,
    backupTraceCanonical,
  );
  adapters.verifyBackupSignature({
    envelopeCanonical: backupSignatureCanonical,
    detachedSignature: detachedSignature(backup),
    planCanonical: backupPlanCanonical,
    executorTraceCanonical: backupTraceCanonical,
    receiptCanonical: backupReceiptCanonical,
  });
  const backupPlanValue = record(
    backupPlan.value,
    "activation.exact0096Backup.plan.value",
  );
  const backupLiveSource = record(
    backupPlanValue.liveSource,
    "activation.exact0096Backup.plan.value.liveSource",
  );

  const migrationPlanCanonical = canonicalArtifactPayload(
    migration,
    "plan",
    "activation.evidence.migration0096To0107",
  );
  const migrationIntentCanonical = canonicalArtifactPayload(
    migration,
    "intent",
    "activation.evidence.migration0096To0107",
  );
  const migrationPersistenceCanonical = canonicalArtifactPayload(
    migration,
    "persistence",
    "activation.evidence.migration0096To0107",
  );
  const finalLiveCanonical = canonicalArtifactPayload(
    migration,
    "finalLive",
    "activation.evidence.migration0096To0107",
  );
  const roleCanonical = canonicalArtifactPayload(
    migration,
    "role",
    "activation.evidence.migration0096To0107",
  );
  const postcommitCanonical = canonicalArtifactPayload(
    migration,
    "postcommit",
    "activation.evidence.migration0096To0107",
  );
  const transitionCanonical = canonicalArtifactPayload(
    migration,
    "transitionPass",
    "activation.evidence.migration0096To0107",
  );
  const receiptArtifacts = migration.receipts;
  if (!Array.isArray(receiptArtifacts) || receiptArtifacts.length !== 10) {
    fail(
      "PRODUCTION_ACTIVATION_SEMANTIC_INVALID",
      "migration must contain the exact ten actual receipts.",
    );
  }
  const receiptCanonicals = receiptArtifacts.map((receipt, index) =>
    canonicalArtifactPayload(
      { receipt },
      "receipt",
      `activation.evidence.migration0096To0107.receipts[${index}]`,
    ),
  );
  const migrationPlanArtifact = adapters.parseMigrationArtifact(
    migrationPlanCanonical,
    "activation.migration.plan",
  );
  const migrationPlan = adapters.validateMigrationPlan(
    record(migrationPlanArtifact.value, "activation.migration.plan.value"),
  );
  const migrationDatabase = record(
    migrationPlan.database,
    "activation.migration.plan.database",
  );
  exactEqual(
    migrationPlan.backupPlanCanonical,
    backupPlan.canonical,
    "migration.plan.backupPlanCanonical",
  );
  exactEqual(
    migrationPlan.backupExecutorTraceCanonical,
    backupTrace.canonical,
    "migration.plan.backupExecutorTraceCanonical",
  );
  exactEqual(
    migrationPlan.backupReceiptCanonical,
    backupReceipt.canonical,
    "migration.plan.backupReceiptCanonical",
  );
  exactEqual(
    migrationPlan.backupSignatureEnvelopeCanonical,
    backupSignatureCanonical,
    "migration.plan.backupSignatureEnvelopeCanonical",
  );
  exactEqual(
    migrationPlan.backupDetachedSignatureB64,
    detachedSignature(backup),
    "migration.plan.backupDetachedSignatureB64",
  );

  const finalLivePayload = record(
    artifactPayload(
      migration,
      "finalLive",
      "activation.evidence.migration0096To0107",
    ),
    "activation.evidence.migration0096To0107.finalLive.payload",
  );
  const transition = adapters.verifyMigrationTransition({
    chainCanonical: transitionCanonical,
    planCanonical: migrationPlanCanonical,
    intentCanonical: migrationIntentCanonical,
    intentPersistenceReceiptCanonical: migrationPersistenceCanonical,
    receiptCanonicals,
    finalInventory: finalLivePayload.inventory,
    finalLiveIdentityCanonical: finalLiveCanonical,
    roleTransactionReceiptCanonical: roleCanonical,
    postCommitRoleArtifactCanonical: postcommitCanonical,
  });
  const roleArtifact = adapters.parseMigrationArtifact(
    roleCanonical,
    "activation.migration.role",
  );
  const postcommitArtifact = adapters.parseMigrationArtifact(
    postcommitCanonical,
    "activation.migration.postcommit",
  );

  const credentialRequestCanonical = canonicalArtifactPayload(
    credential,
    "request",
    "activation.evidence.runtimeDatabaseCredentialCutover",
  );
  const credentialReceiptCanonical = canonicalArtifactPayload(
    credential,
    "passReceipt",
    "activation.evidence.runtimeDatabaseCredentialCutover",
  );
  if (transition.value.decision !== "PASS") {
    fail(
      "PRODUCTION_ACTIVATION_MIGRATION_TRANSITION_INVALID",
      "the authoritative migration transition verifier did not return PASS.",
    );
  }
  if (!adapters.credentialReceiptParser) {
    fail(
      "PRODUCTION_ACTIVATION_CREDENTIAL_RECEIPT_PARSER_MISSING",
      "the credential cutover producer exports no authoritative PASS-receipt parser; remain in HOLD rather than trusting a self-asserted receipt.",
    );
  }
  const transitionValue = record(
    transition.value,
    "activation.migration.transition.value",
  );
  const credentialVerdict = adapters.credentialReceiptParser.parseAndVerify({
    requestCanonical: credentialRequestCanonical,
    receiptCanonical: credentialReceiptCanonical,
    expected: Object.freeze({
      sourceSha: String(backupLiveSource.sha),
      executorSourceSha: expectedCredentialExecutorSourceSha,
      liveSourceImage: String(backupLiveSource.imageRef),
      databaseName: String(migrationDatabase.name),
      migrationPlanSha256: migrationPlanArtifact.sha256,
      roleTransactionReceiptSha256: roleArtifact.sha256,
      rolePostCommitArtifactSha256: postcommitArtifact.sha256,
      migrationTransitionSha256: transition.sha256,
      migrationTransition: Object.freeze({
        decision: transitionValue.decision as "PASS",
        sourceSha: String(transitionValue.sourceSha),
        planSha256: String(transitionValue.planSha256),
        rolePreconditionSha256: String(transitionValue.rolePreconditionSha256),
        roleTransactionReceiptSha256: String(
          transitionValue.roleTransactionReceiptSha256,
        ),
        postCommitRoleArtifactSha256: String(
          transitionValue.postCommitRoleArtifactSha256,
        ),
        finalLiveIdentitySha256: String(
          transitionValue.finalLiveIdentitySha256,
        ),
        completedAt: String(transitionValue.completedAt),
        authorizesApplicationStart:
          transitionValue.authorizesApplicationStart as false,
      }),
      activationIssuedAt: String(activation.issuedAt),
    }),
  });
  exactEqual(
    credentialVerdict.request.expectedMigrationPlanSha256,
    migrationPlanArtifact.sha256,
    "credential.request.expectedMigrationPlanSha256",
  );
  exactEqual(
    credentialVerdict.request.expectedRoleTransactionReceiptSha256,
    roleArtifact.sha256,
    "credential.request.expectedRoleTransactionReceiptSha256",
  );
  exactEqual(
    credentialVerdict.request.expectedRolePostCommitArtifactSha256,
    postcommitArtifact.sha256,
    "credential.request.expectedRolePostCommitArtifactSha256",
  );
  exactEqual(
    credentialVerdict.request.liveSourceSha,
    transitionValue.sourceSha,
    "credential.request.liveSourceSha",
  );
  exactEqual(
    credentialVerdict.request.executorSourceSha,
    expectedCredentialExecutorSourceSha,
    "credential.request.executorSourceSha",
  );
  exactEqual(
    credentialVerdict.migrationTransitionSha256,
    transition.sha256,
    "credential.migrationTransitionSha256",
  );
  exactEqual(
    credentialVerdict.finalLiveIdentitySha256,
    transitionValue.finalLiveIdentitySha256,
    "credential.finalLiveIdentitySha256",
  );
  const credentialReceiptSha256 = `sha256:${createHash("sha256")
    .update(credentialReceiptCanonical)
    .digest("hex")}`;
  if (
    credentialVerdict.decision !== "PASS" ||
    credentialVerdict.receiptSha256 !== credentialReceiptSha256 ||
    credentialVerdict.authorizesApplicationStart !== false ||
    credentialVerdict.authorizesDeployment !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_CREDENTIAL_RECEIPT_INVALID",
      "authoritative credential receipt verdict is not exact, PASS, and non-authorizing.",
    );
  }

  if (!adapters.verifyFinalObservations) {
    fail(
      "PRODUCTION_ACTIVATION_OBSERVATION_PARSER_MISSING",
      "the host evidence producer exports no authoritative observation parser; remain in HOLD.",
    );
  }
  const coolifyCanonical = canonicalArtifactPayload(
    observations,
    "coolify",
    "activation.evidence.finalObservations",
  );
  const dockerCanonical = canonicalArtifactPayload(
    observations,
    "docker",
    "activation.evidence.finalObservations",
  );
  const postgresCanonical = canonicalArtifactPayload(
    observations,
    "postgres",
    "activation.evidence.finalObservations",
  );
  const observationVerdict = adapters.verifyFinalObservations({
    request: {
      schemaVersion: OBSERVATION_REQUEST_SCHEMA,
      sourceSha: activation.sourceSha,
      expectedApiImage: activation.apiImage,
      databaseName: approval.databaseName,
      databaseUser: approval.databaseUser,
      schemaFingerprintSha256: approval.schemaFingerprintSha256,
      composeProject: approval.composeProject,
      postgresService: approval.postgresService,
      postgresVolumeDestination: approval.postgresVolumeDestination,
      expectedNetworkServices: approval.expectedNetworkServices,
    },
    coolifyCanonical,
    dockerCanonical,
    postgresCanonical,
    activationIssuedAt: String(activation.issuedAt),
  });
  requireObservedContainerIdBinding(
    activation.containerId,
    observationVerdict.apiContainerId,
  );

  for (const [field, actual, expected] of [
    ["approval.sourceSha", approval.sourceSha, activation.sourceSha],
    ["approval.apiImage", approval.apiImage, activation.apiImage],
    ["approval.nonce", approval.nonce, activation.nonce],
    ["approval.containerId", approval.containerId, activation.containerId],
    [
      "approval.desiredConfigSha256",
      approval.desiredConfigSha256,
      activation.desiredConfigSha256,
    ],
    [
      "approval.deployedConfigSha256",
      approval.deployedConfigSha256,
      activation.deployedConfigSha256,
    ],
    [
      "approval.resolvedComposeSha256",
      approval.resolvedComposeSha256,
      activation.resolvedComposeSha256,
    ],
    ["approval.databaseName", approval.databaseName, migrationDatabase.name],
    [
      "approval.databaseUser",
      approval.databaseUser,
      credentialVerdict.request.runtimeRole,
    ],
    [
      "approval.migrationTransitionSha256",
      approval.migrationTransitionSha256,
      transition.sha256,
    ],
    [
      "approval.finalLiveIdentitySha256",
      approval.finalLiveIdentitySha256,
      credentialVerdict.finalLiveIdentitySha256,
    ],
    [
      "approval.credentialRequestSha256",
      approval.credentialRequestSha256,
      prefixedSha256(credentialRequestCanonical),
    ],
    [
      "approval.credentialReceiptSha256",
      approval.credentialReceiptSha256,
      credentialReceiptSha256,
    ],
    [
      "approval.coolifyObservationSha256",
      approval.coolifyObservationSha256,
      observationVerdict.coolifySha256,
    ],
    [
      "approval.dockerObservationSha256",
      approval.dockerObservationSha256,
      observationVerdict.dockerSha256,
    ],
    [
      "approval.postgresObservationSha256",
      approval.postgresObservationSha256,
      observationVerdict.postgresSha256,
    ],
    [
      "observations.sourceSha",
      observationVerdict.sourceSha,
      activation.sourceSha,
    ],
    ["observations.apiImage", observationVerdict.apiImage, activation.apiImage],
    [
      "observations.databaseName",
      observationVerdict.databaseName,
      migrationDatabase.name,
    ],
    [
      "observations.databaseUser",
      observationVerdict.databaseUser,
      credentialVerdict.request.runtimeRole,
    ],
    [
      "observations.schemaFingerprintSha256",
      observationVerdict.schemaFingerprintSha256,
      approval.schemaFingerprintSha256,
    ],
    [
      "observations.desiredConfigSha256",
      observationVerdict.desiredConfigSha256,
      `sha256:${String(activation.desiredConfigSha256)}`,
    ],
    [
      "observations.deployedConfigSha256",
      observationVerdict.deployedConfigSha256,
      `sha256:${String(activation.deployedConfigSha256)}`,
    ],
    [
      "observations.resolvedComposeSha256",
      observationVerdict.resolvedComposeSha256,
      `sha256:${String(activation.resolvedComposeSha256)}`,
    ],
    [
      "observations.apiContainerImage",
      observationVerdict.apiContainerImage,
      activation.apiImage,
    ],
  ] as const) {
    exactEqual(actual, expected, field);
  }
  if (
    observationVerdict.desiredConfigSha256 !==
    observationVerdict.deployedConfigSha256
  ) {
    fail(
      "PRODUCTION_ACTIVATION_CONFIGURATION_DRIFT",
      "desired and deployed production configuration digests must be identical before activation.",
    );
  }

  const transitionCompletedAt = exactTimestamp(
    transitionValue.completedAt,
    "migration.transition.completedAt",
  ).millis;
  const credentialStartedAt = exactTimestamp(
    credentialVerdict.startedAt,
    "credential.startedAt",
  ).millis;
  const credentialCompletedAt = exactTimestamp(
    credentialVerdict.completedAt,
    "credential.completedAt",
  ).millis;
  const observationTimes = [
    exactTimestamp(
      observationVerdict.coolifyObservedAt,
      "observations.coolifyObservedAt",
    ).millis,
    exactTimestamp(
      observationVerdict.dockerObservedAt,
      "observations.dockerObservedAt",
    ).millis,
    exactTimestamp(
      observationVerdict.postgresObservedAt,
      "observations.postgresObservedAt",
    ).millis,
  ];
  const observationsCapturedAt = exactTimestamp(
    observationVerdict.capturedAt,
    "observations.capturedAt",
  ).millis;
  const approvalAt = exactTimestamp(
    approval.approvedAt,
    "activationApproval.approvedAt",
  ).millis;
  const hostAttestedAt = exactTimestamp(
    hostAttestation.observedAt,
    "hostAttestation.observedAt",
  ).millis;
  const activationIssuedAt = exactTimestamp(
    activation.issuedAt,
    "activation.issuedAt",
  ).millis;
  if (
    transitionCompletedAt > credentialStartedAt ||
    credentialStartedAt > credentialCompletedAt ||
    observationTimes.some((observedAt) => credentialCompletedAt > observedAt) ||
    Math.max(...observationTimes) !== observationsCapturedAt ||
    observationsCapturedAt > hostAttestedAt ||
    hostAttestedAt > approvalAt ||
    approvalAt > activationIssuedAt
  ) {
    fail(
      "PRODUCTION_ACTIVATION_CHRONOLOGY_INVALID",
      "migration, credential, observations, approval and activation are not one ordered chain.",
    );
  }

  const finalState = record(
    transitionValue.final,
    "migration.transition.final",
  );
  const knownAppliedMigrations = Number(finalState.knownAppliedMigrations);
  const opaqueLegacyRowCount = Number(finalState.opaqueLegacyRowCount);
  if (
    !Number.isSafeInteger(knownAppliedMigrations) ||
    knownAppliedMigrations !== 107 ||
    !Number.isSafeInteger(opaqueLegacyRowCount) ||
    opaqueLegacyRowCount !== 2 ||
    finalState.latestKnownAppliedTag !== "0107_canonical_audit_evidence" ||
    finalState.excludedMigration0100Present !== false
  ) {
    fail(
      "PRODUCTION_ACTIVATION_MIGRATION_TRANSITION_INVALID",
      "the verified transition does not end at the exact reviewed 0107 plus two opaque rows.",
    );
  }
  const knownAppliedRowsSha256 = exactString(
    finalState.knownAppliedRowsSha256,
    "migration.transition.final.knownAppliedRowsSha256",
    SHA256,
  );
  const opaqueLegacyRowsSha256 = exactString(
    finalState.opaqueLegacyRowsSha256,
    "migration.transition.final.opaqueLegacyRowsSha256",
    SHA256,
  );
  const transitionBackupIntegritySha256 = exactString(
    transitionValue.backupIntegritySha256,
    "migration.transition.backupIntegritySha256",
    SHA256,
  );

  // The existing runtime health schema is v1. Each field below is populated
  // from an authoritative artifact in this verified v2 chain; no legacy
  // environment/B64 evidence is reconstructed or trusted.
  return Object.freeze({
    sourceSha: String(activation.sourceSha),
    apiImage: String(activation.apiImage),
    apiImageDigest: `sha256:${String(activation.apiImage).split("@sha256:")[1]}`,
    publicationReceiptSha256: imageProvenanceVerdict.publicationReceiptSha256,
    reviewedImageSetSha256: imageProvenanceVerdict.reviewedImageSetSha256,
    apiRunnableManifestDigest:
      imageProvenanceVerdict.subjectRunnableManifestDigest,
    apiOciProvenanceSha256: imageProvenanceVerdict.ociProvenanceSha256,
    postgresImage: observationVerdict.postgresImage,
    targetEvidenceSha256: prefixedSha256(
      canonicalProductionActivationJson(observations as JsonValue),
    ),
    releaseEvidenceSha256: prefixedSha256(
      canonicalProductionActivationJson(evidence as JsonValue),
    ),
    resolvedComposeSha256: observationVerdict.resolvedComposeSha256,
    deployedConfigSha256: observationVerdict.deployedConfigSha256,
    desiredConfigSha256: observationVerdict.desiredConfigSha256,
    livePostgresTargetSha256: observationVerdict.postgresSha256,
    databaseName: observationVerdict.databaseName,
    databaseUser: observationVerdict.databaseUser,
    schemaFingerprintSha256: observationVerdict.schemaFingerprintSha256,
    preMigrationBackupEvidenceSha256: backupReceipt.sha256,
    backupIntegritySha256: transitionBackupIntegritySha256,
    transitionChainSha256: transition.sha256,
    activationApprovalSha256: prefixedSha256(approvalCanonical),
    lineage: Object.freeze({
      decision: "ALREADY_0107",
      mode: "production-copy-restricted",
      knownExpectedMigrations: knownAppliedMigrations,
      knownAppliedMigrations,
      knownAppliedRowsSha256,
      latestKnownAppliedTag: finalState.latestKnownAppliedTag,
      missingKnownToPredecessor: 0,
      opaqueLegacyRowCount,
      opaqueLegacyRowsSha256,
      opaqueLegacyMeaningInferred: false,
      excludedMigration0100Present: false,
    }),
  });
}

/** Production runtime entrypoint: deliberately accepts no adapter override. */
export async function verifyProductionActivationContractV2(
  bundle: ProductionActivationBundleV2,
): Promise<ProductionReleaseSummary> {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_ACTIVATION_VERIFIER_INPUT_INVALID",
      "production semantic verification accepts the signed bundle only.",
    );
  }
  return verifyProductionActivationContractV2Core(bundle, DIRECT_ADAPTERS);
}

/** Exact 0108 handoff: reuses the already completed, source-pinned credential rotation. */
export async function verifyProductionInvoice0108PredecessorActivationContractV2(
  bundle: ProductionActivationBundleV2,
): Promise<ProductionReleaseSummary> {
  if (arguments.length !== 1) {
    fail(
      "PRODUCTION_ACTIVATION_VERIFIER_INPUT_INVALID",
      "production semantic verification accepts the signed bundle only.",
    );
  }
  return verifyProductionActivationContractV2Core(
    bundle,
    DIRECT_ADAPTERS,
    PRODUCTION_INVOICE_0108_CREDENTIAL_EXECUTION_SOURCE_SHA,
  );
}

export interface ProductionActivationContractTestVerifier {
  (
    bundle: ProductionActivationBundleV2,
    adapters: ProductionActivationContractAdapters,
    credentialExecutorSourceSha?: string,
  ): Promise<ProductionReleaseSummary>;
}

/**
 * Explicit test-only seam. It cannot be reached by the production verifier and
 * remains disabled outside a test process even when imported accidentally.
 */
export function createProductionActivationContractTestVerifier(
  confirmation: typeof PRODUCTION_ACTIVATION_CONTRACT_TEST_CONFIRMATION,
): ProductionActivationContractTestVerifier {
  if (
    confirmation !== PRODUCTION_ACTIVATION_CONTRACT_TEST_CONFIRMATION ||
    (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true")
  ) {
    fail(
      "PRODUCTION_ACTIVATION_TEST_ADAPTERS_FORBIDDEN",
      "injectable production activation adapters are available to tests only.",
    );
  }
  return verifyProductionActivationContractV2Core;
}

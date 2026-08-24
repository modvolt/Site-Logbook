import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// @ts-ignore -- the exact migration/role lock is source-pinned outside the API rootDir.
import { PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY } from "../../../../scripts/production-evidence/production-migration-contract.mjs";
import {
  assertProductionMigrationRolePostCommit,
  assertProductionMigrationRolePrecondition,
  normalizeProductionMigrationRoleProjection,
  PRODUCTION_ROLE_PROJECTION_SQL,
  validateProductionRoleProjection,
  type ProductionRolePlan,
  type ProductionRoleProjection,
} from "@workspace/db/production-migration-role-authority";
import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_DATABASE_USER,
  requireProductionRuntimeDatabasePassword,
} from "./production-runtime-database";

export const PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA =
  "site-logbook.production-runtime-db-credential-cutover-request/v1" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA =
  "site-logbook.production-runtime-db-credential-cutover-receipt/v1" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA =
  "site-logbook.production-runtime-db-credential-rotation-request/v2" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_RECEIPT_SCHEMA =
  "site-logbook.production-runtime-db-credential-rotation-receipt/v2" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION =
  "SET_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_AFTER_ROLE_SEPARATION" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION =
  "ROTATE_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_FOR_NEW_ACTIVATION_PREDECESSOR" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_CONFIRMATION =
  "PREPARE_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_READ_ONLY" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_AGE_MS =
  24 * 60 * 60 * 1000;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_DURATION_MS =
  10 * 60 * 1000;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS =
  30 * 1000;
export { PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY };

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
const CONTROL_PLANE_IMAGE =
  /^ghcr\.io\/modvolt\/site-logbook-control-plane@sha256:[0-9a-f]{64}$/;
const SCRAM_VERIFIER =
  /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const APPROVAL_ID = /^[a-z0-9][a-z0-9._:/-]{7,127}$/;
const REQUEST_KEYS = [
  "schemaVersion",
  "kind",
  "liveSourceSha",
  "executorSourceSha",
  "executorImage",
  "databaseName",
  "runtimeRole",
  "migratorRole",
  "expectedMigrationPlanSha256",
  "expectedRoleTransactionReceiptSha256",
  "expectedRolePostCommitArtifactSha256",
  "approvalId",
  "advisoryLockKey",
  "confirmation",
  "authorizesDeployment",
] as const;
const ROTATION_REQUEST_KEYS = [
  "schemaVersion",
  "kind",
  "operation",
  "liveSourceSha",
  "executorSourceSha",
  "executorImage",
  "databaseName",
  "runtimeRole",
  "migratorRole",
  "expectedMigrationPlanSha256",
  "expectedRoleTransactionReceiptSha256",
  "expectedRolePostCommitArtifactSha256",
  "expectedCurrentCredentialVerifierSha256",
  "approvalId",
  "issuedAt",
  "expiresAt",
  "advisoryLockKey",
  "confirmation",
  "authorizesDeployment",
] as const;
const RECEIPT_KEYS = [
  "schemaVersion",
  "kind",
  "decision",
  "sourceBinding",
  "requestSha256",
  "database",
  "roleEvidence",
  "transaction",
  "verification",
  "approvalId",
  "startedAt",
  "completedAt",
  "requiresExplicitCoolifySecretTransfer",
  "authorizesApplicationStart",
  "authorizesDeployment",
] as const;
const ROTATION_RECEIPT_KEYS = [...RECEIPT_KEYS, "operation"] as const;
const RECEIPT_SOURCE_BINDING_KEYS = [
  "liveSourceSha",
  "executorSourceSha",
  "executorImage",
] as const;
const RECEIPT_DATABASE_KEYS = [
  "name",
  "adminSessionUser",
  "runtimeUser",
  "migratorUser",
] as const;
const RECEIPT_ROLE_EVIDENCE_KEYS = [
  "migrationPlanSha256",
  "transactionReceiptSha256",
  "postCommitArtifactSha256",
] as const;
const RECEIPT_TRANSACTION_KEYS = [
  "isolationLevel",
  "advisoryLockKey",
  "credentialMutationMechanism",
  "cleartextCredentialSentInSql",
  "cleartextCredentialSentAsQueryParameter",
  "committed",
] as const;
const RECEIPT_VERIFICATION_KEYS = [
  "credentialWasAbsentBefore",
  "credentialPresentInTransaction",
  "exactScramVerifierStoredInTransaction",
  "freshRuntimeLoginVerified",
  "exactRuntimeIdentityVerified",
] as const;
const ROTATION_RECEIPT_VERIFICATION_KEYS = [
  "credentialWasPresentBefore",
  "predecessorVerifierSha256Matched",
  "previousVerifierDifferedFromNew",
  "credentialPresentInTransaction",
  "exactScramVerifierStoredInTransaction",
  "freshRuntimeLoginVerified",
  "exactRuntimeIdentityVerified",
  "freshSecretGeneratedByControlPlane",
  "secretBytesAbsentFromEvidenceAndLogs",
] as const;
const RECEIPT_PARSER_INPUT_KEYS = [
  "requestCanonical",
  "receiptCanonical",
  "expected",
] as const;
const RECEIPT_EXPECTED_KEYS = [
  "sourceSha",
  "executorSourceSha",
  "liveSourceImage",
  "databaseName",
  "migrationPlanSha256",
  "roleTransactionReceiptSha256",
  "rolePostCommitArtifactSha256",
  "migrationTransitionSha256",
  "migrationTransition",
  "activationIssuedAt",
] as const;
const RECEIPT_TRANSITION_KEYS = [
  "decision",
  "sourceSha",
  "planSha256",
  "rolePreconditionSha256",
  "roleTransactionReceiptSha256",
  "postCommitRoleArtifactSha256",
  "finalLiveIdentitySha256",
  "completedAt",
  "authorizesApplicationStart",
] as const;
const FORBIDDEN_EVIDENCE_VALUE =
  /(?:-----BEGIN [^-]*PRIVATE KEY-----|\bSCRAM-SHA-256\$|\b(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s/@:]+:[^\s/@]+@|\bAKIA[0-9A-Z]{16}\b|\bBearer\s+[A-Za-z0-9._~+/-]+=*)/i;

const ADMIN_PRECONDITION_SQL = `SELECT
  current_database()::text AS "databaseName",
  session_user::text AS "sessionUser",
  current_user::text AS "currentUser",
  COALESCE((SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user), false) AS "adminSuperuser",
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1::text) AS "runtimeExists",
  COALESCE((SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $1::text), false) AS "runtimeLogin",
  COALESCE((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_catalog.pg_roles WHERE rolname = $1::text), true) AS "runtimePrivileged",
  COALESCE((SELECT rolpassword IS NOT NULL FROM pg_catalog.pg_authid WHERE rolname = $1::text), false) AS "runtimeCredentialPresent",
  EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $2::text) AS "migratorExists",
  COALESCE((SELECT rolcanlogin FROM pg_catalog.pg_roles WHERE rolname = $2::text), true) AS "migratorLogin"
`;
const RUNTIME_CREDENTIAL_STATE_SQL = `SELECT
  COALESCE((SELECT rolpassword::text FROM pg_catalog.pg_authid WHERE rolname = $1::text), '') AS "runtimeCredentialVerifier"
`;
const RUNTIME_LOGIN_PROOF_SQL = `SELECT
  current_database()::text AS "databaseName",
  session_user::text AS "sessionUser",
  current_user::text AS "currentUser"
`;

type QueryResult = Readonly<{
  rows?: readonly Record<string, unknown>[];
}>;

export type ProductionRuntimeCredentialClient = Readonly<{
  query(statement: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void | Promise<void>;
}>;

export type ProductionRuntimeDbCredentialRequest = Readonly<{
  schemaVersion: typeof PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA;
  kind: "site-logbook-production-runtime-db-credential-cutover-request";
  liveSourceSha: string;
  executorSourceSha: string;
  executorImage: string;
  databaseName: string;
  runtimeRole: typeof PRODUCTION_RUNTIME_DATABASE_USER;
  migratorRole: typeof PRODUCTION_MIGRATOR_DATABASE_USER;
  expectedMigrationPlanSha256: string;
  expectedRoleTransactionReceiptSha256: string;
  expectedRolePostCommitArtifactSha256: string;
  approvalId: string;
  advisoryLockKey: typeof PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY;
  confirmation: typeof PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION;
  authorizesDeployment: false;
}>;

export type ProductionRuntimeDbCredentialRotationRequest = Readonly<{
  schemaVersion: typeof PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA;
  kind: "site-logbook-production-runtime-db-credential-rotation-request";
  operation: "rotate-existing-runtime-credential";
  liveSourceSha: string;
  executorSourceSha: string;
  executorImage: string;
  databaseName: string;
  runtimeRole: typeof PRODUCTION_RUNTIME_DATABASE_USER;
  migratorRole: typeof PRODUCTION_MIGRATOR_DATABASE_USER;
  expectedMigrationPlanSha256: string;
  expectedRoleTransactionReceiptSha256: string;
  expectedRolePostCommitArtifactSha256: string;
  expectedCurrentCredentialVerifierSha256: string;
  approvalId: string;
  issuedAt: string;
  expiresAt: string;
  advisoryLockKey: typeof PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY;
  confirmation: typeof PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION;
  authorizesDeployment: false;
}>;

export type ProductionRuntimeDbCredentialRequestAny =
  | ProductionRuntimeDbCredentialRequest
  | ProductionRuntimeDbCredentialRotationRequest;

export type ProductionRuntimeDbCredentialMigrationTransitionBinding = Readonly<{
  decision: "PASS";
  sourceSha: string;
  planSha256: string;
  rolePreconditionSha256: string;
  roleTransactionReceiptSha256: string;
  postCommitRoleArtifactSha256: string;
  finalLiveIdentitySha256: string;
  completedAt: string;
  authorizesApplicationStart: false;
}>;

export type ProductionRuntimeDbCredentialReceiptParserInput = Readonly<{
  requestCanonical: string;
  receiptCanonical: string;
  expected: Readonly<{
    sourceSha: string;
    executorSourceSha: string;
    liveSourceImage: string;
    databaseName: string;
    migrationPlanSha256: string;
    roleTransactionReceiptSha256: string;
    rolePostCommitArtifactSha256: string;
    migrationTransitionSha256: string;
    migrationTransition: ProductionRuntimeDbCredentialMigrationTransitionBinding;
    activationIssuedAt: string;
  }>;
}>;

export type ProductionRuntimeDbCredentialReceiptVerdict = Readonly<{
  request: ProductionRuntimeDbCredentialRequestAny;
  decision: "PASS";
  receiptSha256: string;
  migrationTransitionSha256: string;
  finalLiveIdentitySha256: string;
  startedAt: string;
  completedAt: string;
  authorizesApplicationStart: false;
  authorizesDeployment: false;
}>;

export interface ProductionRuntimeDbCredentialReceiptParser {
  parseAndVerify(
    input: ProductionRuntimeDbCredentialReceiptParserInput,
  ): ProductionRuntimeDbCredentialReceiptVerdict;
}

export type ProductionRuntimeDbCredentialCutoverInput = Readonly<{
  requestCanonical: string;
  migrationPlanCanonical: string;
  roleTransactionReceiptCanonical: string;
  rolePostCommitArtifactCanonical: string;
  embeddedSourceSha: string;
  executorImage: string;
  runtimePassword: string;
  connectAdmin: () => Promise<ProductionRuntimeCredentialClient>;
  connectRuntime: (input: {
    databaseName: string;
    databaseUser: typeof PRODUCTION_RUNTIME_DATABASE_USER;
    password: string;
  }) => Promise<ProductionRuntimeCredentialClient>;
  signal: AbortSignal;
  now?: () => Date;
}>;

export type ProductionRuntimeDbCredentialRotationInput = Readonly<
  Omit<ProductionRuntimeDbCredentialCutoverInput, "runtimePassword"> & {
    persistGeneratedSecret: (secret: string) => Promise<void>;
  }
>;

export type ProductionRuntimeDbCredentialRotationPrepareInput = Readonly<{
  migrationPlanCanonical: string;
  roleTransactionReceiptCanonical: string;
  rolePostCommitArtifactCanonical: string;
  embeddedSourceSha: string;
  executorImage: string;
  liveSourceSha: string;
  databaseName: string;
  approvalId: string;
  connectAdmin: () => Promise<ProductionRuntimeCredentialClient>;
  signal: AbortSignal;
  now?: () => Date;
}>;

export class ProductionRuntimeDbCredentialCutoverError extends Error {
  readonly code: string;
  readonly manualReviewRequired: boolean;
  readonly commitOutcomeUnknown: boolean;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & {
      manualReviewRequired?: boolean;
      commitOutcomeUnknown?: boolean;
    },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionRuntimeDbCredentialCutoverError";
    this.code = code;
    this.manualReviewRequired = options?.manualReviewRequired === true;
    this.commitOutcomeUnknown = options?.commitOutcomeUnknown === true;
  }
}

function fail(
  code: string,
  message: string,
  options?: ErrorOptions & {
    manualReviewRequired?: boolean;
    commitOutcomeUnknown?: boolean;
  },
): never {
  throw new ProductionRuntimeDbCredentialCutoverError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

export function canonicalProductionRuntimeDbCredentialJson(
  value: unknown,
): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function productionRuntimeDbCredentialSha256(
  value: string | Buffer,
): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * PostgreSQL 16 does not accept ParamRef in ALTER ROLE PASSWORD (its grammar
 * requires Sconst). This mirrors PG16 psql's documented `\password` safety:
 * derive the SCRAM verifier client-side so the cleartext password is never in
 * SQL text, SQL parameters, server statement logs, argv, or evidence.
 */
export function createPostgres16ScramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
): string {
  requireProductionRuntimeDatabasePassword(password);
  if (!Buffer.isBuffer(salt) || salt.length !== 16) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_SCRAM_SALT_INVALID",
      "SCRAM salt must be exactly 16 random bytes.",
    );
  }
  const saltedPassword = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", saltedPassword)
    .update("Client Key", "utf8")
    .digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", saltedPassword)
    .update("Server Key", "utf8")
    .digest();
  const verifier = `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
  if (!SCRAM_VERIFIER.test(verifier)) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_SCRAM_VERIFIER_INVALID",
      "Client-side SCRAM verifier has an invalid PostgreSQL 16 shape.",
    );
  }
  return verifier;
}

export function createPostgres16RuntimeCredentialAlterStatement(
  verifier: string,
): string {
  if (!SCRAM_VERIFIER.test(verifier)) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_SCRAM_VERIFIER_INVALID",
      "Client-side SCRAM verifier has an invalid PostgreSQL 16 shape.",
    );
  }
  return `ALTER ROLE "site_logbook_runtime" PASSWORD '${verifier}'`;
}

function parseCanonicalObject(
  canonical: string,
  field: string,
  maximumBytes = 512 * 1024,
): Record<string, unknown> {
  if (
    typeof canonical !== "string" ||
    Buffer.byteLength(canonical, "utf8") <= 0 ||
    Buffer.byteLength(canonical, "utf8") > maximumBytes ||
    canonical.includes("\0")
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ARTIFACT_INVALID",
      `${field} is not one bounded canonical artifact.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ARTIFACT_INVALID",
      `${field} is not JSON.`,
      { cause: error },
    );
  }
  if (
    !isRecord(value) ||
    canonicalProductionRuntimeDbCredentialJson(value) !== canonical
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ARTIFACT_INVALID",
      `${field} is not exact canonical JSON with one trailing LF.`,
    );
  }
  return value;
}

export function parseProductionRuntimeDbCredentialRequest(
  canonical: string,
): ProductionRuntimeDbCredentialRequestAny {
  const value = parseCanonicalObject(canonical, "credentialRequest", 64 * 1024);
  if (
    value.schemaVersion ===
      PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA ||
    value.kind ===
      "site-logbook-production-runtime-db-credential-rotation-request"
  ) {
    if (
      !exactKeys(value, ROTATION_REQUEST_KEYS) ||
      value.schemaVersion !==
        PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA ||
      value.kind !==
        "site-logbook-production-runtime-db-credential-rotation-request" ||
      value.operation !== "rotate-existing-runtime-credential" ||
      typeof value.liveSourceSha !== "string" ||
      !SOURCE_SHA.test(value.liveSourceSha) ||
      typeof value.executorSourceSha !== "string" ||
      !SOURCE_SHA.test(value.executorSourceSha) ||
      value.executorSourceSha === value.liveSourceSha ||
      typeof value.executorImage !== "string" ||
      !CONTROL_PLANE_IMAGE.test(value.executorImage) ||
      typeof value.databaseName !== "string" ||
      !IDENTIFIER.test(value.databaseName) ||
      value.runtimeRole !== PRODUCTION_RUNTIME_DATABASE_USER ||
      value.migratorRole !== PRODUCTION_MIGRATOR_DATABASE_USER ||
      typeof value.expectedMigrationPlanSha256 !== "string" ||
      !SHA256.test(value.expectedMigrationPlanSha256) ||
      typeof value.expectedRoleTransactionReceiptSha256 !== "string" ||
      !SHA256.test(value.expectedRoleTransactionReceiptSha256) ||
      typeof value.expectedRolePostCommitArtifactSha256 !== "string" ||
      !SHA256.test(value.expectedRolePostCommitArtifactSha256) ||
      typeof value.expectedCurrentCredentialVerifierSha256 !== "string" ||
      !SHA256.test(value.expectedCurrentCredentialVerifierSha256) ||
      typeof value.approvalId !== "string" ||
      !APPROVAL_ID.test(value.approvalId) ||
      value.advisoryLockKey !== PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY ||
      value.confirmation !==
        PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION ||
      value.authorizesDeployment !== false
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_INVALID",
        "Credential rotation request differs from the source-pinned production contract.",
      );
    }
    const issuedAt = parseCredentialTimestamp(
      value.issuedAt,
      "credentialRotationRequest.issuedAt",
    );
    const expiresAt = parseCredentialTimestamp(
      value.expiresAt,
      "credentialRotationRequest.expiresAt",
    );
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_AGE_MS
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_TIME_INVALID",
        "Credential rotation request must have one positive validity window of at most 24 hours.",
      );
    }
    return Object.freeze(
      value as unknown as ProductionRuntimeDbCredentialRotationRequest,
    );
  }
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.schemaVersion !== PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA ||
    value.kind !==
      "site-logbook-production-runtime-db-credential-cutover-request" ||
    typeof value.liveSourceSha !== "string" ||
    !SOURCE_SHA.test(value.liveSourceSha) ||
    typeof value.executorSourceSha !== "string" ||
    !SOURCE_SHA.test(value.executorSourceSha) ||
    value.executorSourceSha === value.liveSourceSha ||
    typeof value.executorImage !== "string" ||
    !CONTROL_PLANE_IMAGE.test(value.executorImage) ||
    typeof value.databaseName !== "string" ||
    !IDENTIFIER.test(value.databaseName) ||
    value.runtimeRole !== PRODUCTION_RUNTIME_DATABASE_USER ||
    value.migratorRole !== PRODUCTION_MIGRATOR_DATABASE_USER ||
    typeof value.expectedMigrationPlanSha256 !== "string" ||
    !SHA256.test(value.expectedMigrationPlanSha256) ||
    typeof value.expectedRoleTransactionReceiptSha256 !== "string" ||
    !SHA256.test(value.expectedRoleTransactionReceiptSha256) ||
    typeof value.expectedRolePostCommitArtifactSha256 !== "string" ||
    !SHA256.test(value.expectedRolePostCommitArtifactSha256) ||
    typeof value.approvalId !== "string" ||
    !APPROVAL_ID.test(value.approvalId) ||
    value.advisoryLockKey !== PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY ||
    value.confirmation !== PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION ||
    value.authorizesDeployment !== false
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_INVALID",
      "Credential request differs from the source-pinned production contract.",
    );
  }
  return Object.freeze(
    value as unknown as ProductionRuntimeDbCredentialRequest,
  );
}

export function createProductionRuntimeDbCredentialRequest(
  value: ProductionRuntimeDbCredentialRequest,
) {
  const canonical = canonicalProductionRuntimeDbCredentialJson(value);
  const request = parseProductionRuntimeDbCredentialRequest(canonical);
  return Object.freeze({
    value: request,
    canonical,
    sha256: productionRuntimeDbCredentialSha256(canonical),
  });
}

export function createProductionRuntimeDbCredentialRotationRequest(
  value: ProductionRuntimeDbCredentialRotationRequest,
) {
  const canonical = canonicalProductionRuntimeDbCredentialJson(value);
  const request = parseProductionRuntimeDbCredentialRequest(canonical);
  if (
    request.schemaVersion !==
    PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_INVALID",
      "Credential rotation request parsed as a different ceremony.",
    );
  }
  return Object.freeze({
    value: request,
    canonical,
    sha256: productionRuntimeDbCredentialSha256(canonical),
  });
}

function exactReceiptObject(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!isRecord(value) || !exactKeys(value, keys)) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_INVALID",
      `${field} has an unexpected canonical key set.`,
    );
  }
  return value;
}

function assertSecretFreeCredentialEvidence(
  value: unknown,
  field: string,
): void {
  if (typeof value === "string") {
    if (value.length > 2_048 || FORBIDDEN_EVIDENCE_VALUE.test(value)) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_EVIDENCE_SECRET_LEAK",
        `${field} contains forbidden private material.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertSecretFreeCredentialEvidence(entry, `${field}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertSecretFreeCredentialEvidence(entry, `${field}.${key}`);
    }
  }
}

function parseCredentialTimestamp(value: unknown, field: string): number {
  if (typeof value !== "string" || value.length !== 24) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_TIME_INVALID",
      `${field} is not a canonical UTC timestamp.`,
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== value
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_TIME_INVALID",
      `${field} is not a canonical UTC timestamp.`,
    );
  }
  return timestamp;
}

function immutableImageDigest(image: string): string {
  return image.slice(image.lastIndexOf("@sha256:") + 1);
}

/**
 * Producer-owned verifier for the canonical PASS receipt. It deliberately
 * reconstructs every deterministic field from the request and the already
 * authoritative migration transition verdict. No receipt boolean is accepted
 * without its exact request, source, role, transaction and time binding.
 */
export function parseAndVerifyProductionRuntimeDbCredentialReceipt(
  input: ProductionRuntimeDbCredentialReceiptParserInput,
): ProductionRuntimeDbCredentialReceiptVerdict {
  if (!isRecord(input) || !exactKeys(input, RECEIPT_PARSER_INPUT_KEYS)) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_INPUT_INVALID",
      "Credential receipt parser input has an unexpected key set.",
    );
  }
  const expected = exactReceiptObject(
    input.expected,
    RECEIPT_EXPECTED_KEYS,
    "credentialReceiptExpected",
  );
  const transition = exactReceiptObject(
    expected.migrationTransition,
    RECEIPT_TRANSITION_KEYS,
    "credentialReceiptExpected.migrationTransition",
  );
  if (
    typeof expected.sourceSha !== "string" ||
    !SOURCE_SHA.test(expected.sourceSha) ||
    typeof expected.executorSourceSha !== "string" ||
    !SOURCE_SHA.test(expected.executorSourceSha) ||
    expected.executorSourceSha === expected.sourceSha ||
    typeof expected.liveSourceImage !== "string" ||
    !IMMUTABLE_IMAGE.test(expected.liveSourceImage) ||
    typeof expected.databaseName !== "string" ||
    !IDENTIFIER.test(expected.databaseName) ||
    typeof expected.migrationPlanSha256 !== "string" ||
    !SHA256.test(expected.migrationPlanSha256) ||
    typeof expected.roleTransactionReceiptSha256 !== "string" ||
    !SHA256.test(expected.roleTransactionReceiptSha256) ||
    typeof expected.rolePostCommitArtifactSha256 !== "string" ||
    !SHA256.test(expected.rolePostCommitArtifactSha256) ||
    typeof expected.migrationTransitionSha256 !== "string" ||
    !SHA256.test(expected.migrationTransitionSha256) ||
    transition.decision !== "PASS" ||
    typeof transition.sourceSha !== "string" ||
    !SOURCE_SHA.test(transition.sourceSha) ||
    typeof transition.planSha256 !== "string" ||
    !SHA256.test(transition.planSha256) ||
    typeof transition.rolePreconditionSha256 !== "string" ||
    !SHA256.test(transition.rolePreconditionSha256) ||
    typeof transition.roleTransactionReceiptSha256 !== "string" ||
    !SHA256.test(transition.roleTransactionReceiptSha256) ||
    typeof transition.postCommitRoleArtifactSha256 !== "string" ||
    !SHA256.test(transition.postCommitRoleArtifactSha256) ||
    typeof transition.finalLiveIdentitySha256 !== "string" ||
    !SHA256.test(transition.finalLiveIdentitySha256) ||
    transition.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_AUTHORITY_INVALID",
      "Authoritative migration transition context is malformed or authorizing.",
    );
  }
  const migrationCompletedAt = parseCredentialTimestamp(
    transition.completedAt,
    "credentialReceiptExpected.migrationTransition.completedAt",
  );
  const activationIssuedAt = parseCredentialTimestamp(
    expected.activationIssuedAt,
    "credentialReceiptExpected.activationIssuedAt",
  );
  if (
    transition.sourceSha !== expected.sourceSha ||
    transition.planSha256 !== expected.migrationPlanSha256 ||
    transition.roleTransactionReceiptSha256 !==
      expected.roleTransactionReceiptSha256 ||
    transition.postCommitRoleArtifactSha256 !==
      expected.rolePostCommitArtifactSha256 ||
    migrationCompletedAt >
      activationIssuedAt +
        PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS ||
    new Set([
      expected.migrationPlanSha256,
      transition.rolePreconditionSha256,
      expected.roleTransactionReceiptSha256,
      expected.rolePostCommitArtifactSha256,
      expected.migrationTransitionSha256,
      transition.finalLiveIdentitySha256,
    ]).size !== 6
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_AUTHORITY_INVALID",
      "Migration plan, role evidence and final transition chain are not exact-bound.",
    );
  }

  const request = parseProductionRuntimeDbCredentialRequest(
    input.requestCanonical,
  );
  const isRotation =
    request.schemaVersion ===
    PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA;
  const receipt = parseCanonicalObject(
    input.receiptCanonical,
    "credentialReceipt",
    64 * 1024,
  );
  assertSecretFreeCredentialEvidence(request, "credentialRequest");
  assertSecretFreeCredentialEvidence(receipt, "credentialReceipt");
  exactReceiptObject(
    receipt,
    isRotation ? ROTATION_RECEIPT_KEYS : RECEIPT_KEYS,
    "credentialReceipt",
  );
  const sourceBinding = exactReceiptObject(
    receipt.sourceBinding,
    RECEIPT_SOURCE_BINDING_KEYS,
    "credentialReceipt.sourceBinding",
  );
  const database = exactReceiptObject(
    receipt.database,
    RECEIPT_DATABASE_KEYS,
    "credentialReceipt.database",
  );
  const roleEvidence = exactReceiptObject(
    receipt.roleEvidence,
    RECEIPT_ROLE_EVIDENCE_KEYS,
    "credentialReceipt.roleEvidence",
  );
  const transaction = exactReceiptObject(
    receipt.transaction,
    RECEIPT_TRANSACTION_KEYS,
    "credentialReceipt.transaction",
  );
  const verification = exactReceiptObject(
    receipt.verification,
    isRotation ? ROTATION_RECEIPT_VERIFICATION_KEYS : RECEIPT_VERIFICATION_KEYS,
    "credentialReceipt.verification",
  );

  if (
    request.liveSourceSha !== expected.sourceSha ||
    request.executorSourceSha !== expected.executorSourceSha ||
    request.databaseName !== expected.databaseName ||
    request.expectedMigrationPlanSha256 !== expected.migrationPlanSha256 ||
    request.expectedRoleTransactionReceiptSha256 !==
      expected.roleTransactionReceiptSha256 ||
    request.expectedRolePostCommitArtifactSha256 !==
      expected.rolePostCommitArtifactSha256 ||
    request.liveSourceSha === request.executorSourceSha ||
    request.executorImage === expected.liveSourceImage ||
    immutableImageDigest(request.executorImage) ===
      immutableImageDigest(expected.liveSourceImage)
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_BINDING_INVALID",
      "Credential request is not bound to the immutable live source and authoritative migration chain.",
    );
  }

  if (
    (isRotation
      ? receipt.schemaVersion !==
          PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_RECEIPT_SCHEMA ||
        receipt.kind !==
          "site-logbook-production-runtime-db-credential-rotation-receipt" ||
        receipt.operation !== "rotate-existing-runtime-credential"
      : receipt.schemaVersion !==
          PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA ||
        receipt.kind !==
          "site-logbook-production-runtime-db-credential-cutover-receipt") ||
    receipt.decision !== "PASS" ||
    receipt.requestSha256 !==
      productionRuntimeDbCredentialSha256(input.requestCanonical) ||
    sourceBinding.liveSourceSha !== request.liveSourceSha ||
    sourceBinding.executorSourceSha !== request.executorSourceSha ||
    sourceBinding.executorImage !== request.executorImage ||
    database.name !== request.databaseName ||
    typeof database.adminSessionUser !== "string" ||
    !IDENTIFIER.test(database.adminSessionUser) ||
    database.adminSessionUser === request.runtimeRole ||
    database.adminSessionUser === request.migratorRole ||
    database.runtimeUser !== request.runtimeRole ||
    database.migratorUser !== request.migratorRole ||
    roleEvidence.migrationPlanSha256 !== request.expectedMigrationPlanSha256 ||
    roleEvidence.transactionReceiptSha256 !==
      request.expectedRoleTransactionReceiptSha256 ||
    roleEvidence.postCommitArtifactSha256 !==
      request.expectedRolePostCommitArtifactSha256 ||
    transaction.isolationLevel !== "serializable" ||
    transaction.advisoryLockKey !== request.advisoryLockKey ||
    transaction.credentialMutationMechanism !==
      "postgresql-16-client-side-scram-sha-256-verifier" ||
    transaction.cleartextCredentialSentInSql !== false ||
    transaction.cleartextCredentialSentAsQueryParameter !== false ||
    transaction.committed !== true ||
    (isRotation
      ? verification.credentialWasPresentBefore !== true ||
        verification.predecessorVerifierSha256Matched !== true ||
        verification.previousVerifierDifferedFromNew !== true ||
        verification.freshSecretGeneratedByControlPlane !== true ||
        verification.secretBytesAbsentFromEvidenceAndLogs !== true
      : verification.credentialWasAbsentBefore !== true) ||
    verification.credentialPresentInTransaction !== true ||
    verification.exactScramVerifierStoredInTransaction !== true ||
    verification.freshRuntimeLoginVerified !== true ||
    verification.exactRuntimeIdentityVerified !== true ||
    receipt.approvalId !== request.approvalId ||
    receipt.requiresExplicitCoolifySecretTransfer !== true ||
    receipt.authorizesApplicationStart !== false ||
    receipt.authorizesDeployment !== false
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_INVALID",
      "Credential receipt is not the exact committed, read-back and fresh-login PASS evidence for its request.",
    );
  }

  const startedAt = parseCredentialTimestamp(
    receipt.startedAt,
    "credentialReceipt.startedAt",
  );
  const completedAt = parseCredentialTimestamp(
    receipt.completedAt,
    "credentialReceipt.completedAt",
  );
  if (isRotation) {
    const requestIssuedAt = parseCredentialTimestamp(
      request.issuedAt,
      "credentialRotationRequest.issuedAt",
    );
    const requestExpiresAt = parseCredentialTimestamp(
      request.expiresAt,
      "credentialRotationRequest.expiresAt",
    );
    if (
      startedAt + PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS <
        requestIssuedAt ||
      completedAt >
        requestExpiresAt +
          PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS ||
      activationIssuedAt >
        requestExpiresAt +
          PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_STALE",
        "Credential rotation request was not valid for the ceremony and activation predecessor.",
      );
    }
  }
  if (
    startedAt < migrationCompletedAt ||
    completedAt < startedAt ||
    completedAt - startedAt >
      PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_DURATION_MS ||
    completedAt >
      activationIssuedAt +
        PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_TIME_INVALID",
      "Credential receipt timestamps do not follow the completed migration in a bounded ceremony.",
    );
  }
  if (
    activationIssuedAt - completedAt >
    PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_AGE_MS
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_STALE",
      "Credential PASS receipt is stale and cannot be replayed into a new activation.",
    );
  }

  return Object.freeze({
    request,
    decision: "PASS" as const,
    receiptSha256: productionRuntimeDbCredentialSha256(input.receiptCanonical),
    migrationTransitionSha256: expected.migrationTransitionSha256,
    finalLiveIdentitySha256: transition.finalLiveIdentitySha256,
    startedAt: String(receipt.startedAt),
    completedAt: String(receipt.completedAt),
    authorizesApplicationStart: false as const,
    authorizesDeployment: false as const,
  });
}

export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_PARSER: ProductionRuntimeDbCredentialReceiptParser =
  Object.freeze({
    parseAndVerify: parseAndVerifyProductionRuntimeDbCredentialReceipt,
  });

function oneRow(
  result: QueryResult,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || !isRecord(row) || !exactKeys(row, keys)) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_PROJECTION_INVALID",
      `${field} did not return its exact source-reviewed projection.`,
    );
  }
  return row;
}

function exactTimestamp(now: () => Date): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_CLOCK_INVALID",
      "Credential ceremony clock is invalid.",
    );
  }
  return value.toISOString();
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ABORTED",
      "Credential ceremony was aborted and failed closed.",
      { cause: signal.reason },
    );
  }
}

function assertRoleAuthority(
  request: ProductionRuntimeDbCredentialRequestAny,
  input: Readonly<{
    migrationPlanCanonical: string;
    roleTransactionReceiptCanonical: string;
    rolePostCommitArtifactCanonical: string;
    embeddedSourceSha: string;
    executorImage: string;
    signal: AbortSignal;
  }>,
): Readonly<{
  rolePlan: ProductionRolePlan;
  approvedProjection: ProductionRoleProjection;
}> {
  if (
    request.executorSourceSha !== input.embeddedSourceSha ||
    request.executorImage !== input.executorImage ||
    productionRuntimeDbCredentialSha256(input.migrationPlanCanonical) !==
      request.expectedMigrationPlanSha256 ||
    productionRuntimeDbCredentialSha256(
      input.roleTransactionReceiptCanonical,
    ) !== request.expectedRoleTransactionReceiptSha256 ||
    productionRuntimeDbCredentialSha256(
      input.rolePostCommitArtifactCanonical,
    ) !== request.expectedRolePostCommitArtifactSha256
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_SOURCE_BINDING_INVALID",
      "Credential request, embedded source, and role evidence are not exact matches.",
    );
  }
  let precondition: any;
  let postCommit: any;
  try {
    precondition = assertProductionMigrationRolePrecondition(
      { planCanonical: input.migrationPlanCanonical },
      { signal: input.signal },
    );
    postCommit = assertProductionMigrationRolePostCommit(
      {
        planCanonical: input.migrationPlanCanonical,
        roleTransactionReceiptCanonical: input.roleTransactionReceiptCanonical,
        postCommitRoleArtifactCanonical: input.rolePostCommitArtifactCanonical,
      },
      { signal: input.signal },
    );
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROLE_AUTHORITY_INVALID",
      "Role-separation evidence is not accepted by the source authority.",
      { cause: error },
    );
  }
  const rolePlan = precondition?.value?.rolePlanCanonical;
  let parsedRolePlan: unknown;
  try {
    parsedRolePlan = JSON.parse(rolePlan);
  } catch {
    parsedRolePlan = undefined;
  }
  const postProjection = postCommit?.value?.projection;
  if (
    precondition?.value?.sourceSha !== request.liveSourceSha ||
    !isRecord(parsedRolePlan) ||
    parsedRolePlan.databaseName !== request.databaseName ||
    parsedRolePlan.runtimeRole !== request.runtimeRole ||
    parsedRolePlan.migratorRole !== request.migratorRole ||
    !isRecord(postProjection) ||
    postProjection.databaseName !== request.databaseName ||
    !isRecord(postProjection.runtimeRole) ||
    postProjection.runtimeRole.name !== request.runtimeRole ||
    postProjection.runtimeRole.login !== true ||
    !isRecord(postProjection.migratorRole) ||
    postProjection.migratorRole.name !== request.migratorRole ||
    postProjection.migratorRole.login !== false
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROLE_AUTHORITY_INVALID",
      "Role-separation authority is not bound to the exact runtime cutover.",
    );
  }
  return Object.freeze({
    rolePlan: parsedRolePlan as unknown as ProductionRolePlan,
    approvedProjection: postProjection as unknown as ProductionRoleProjection,
  });
}

export function generateFreshProductionRuntimeDbCredentialSecret(): string {
  const secret = randomBytes(48).toString("base64url");
  return requireProductionRuntimeDatabasePassword(secret);
}

export async function prepareProductionRuntimeDbCredentialRotationRequest(
  input: ProductionRuntimeDbCredentialRotationPrepareInput,
) {
  if (
    !isRecord(input) ||
    typeof input.migrationPlanCanonical !== "string" ||
    typeof input.roleTransactionReceiptCanonical !== "string" ||
    typeof input.rolePostCommitArtifactCanonical !== "string" ||
    typeof input.embeddedSourceSha !== "string" ||
    !SOURCE_SHA.test(input.embeddedSourceSha) ||
    typeof input.executorImage !== "string" ||
    !CONTROL_PLANE_IMAGE.test(input.executorImage) ||
    typeof input.liveSourceSha !== "string" ||
    !SOURCE_SHA.test(input.liveSourceSha) ||
    input.liveSourceSha === input.embeddedSourceSha ||
    typeof input.databaseName !== "string" ||
    !IDENTIFIER.test(input.databaseName) ||
    typeof input.approvalId !== "string" ||
    !APPROVAL_ID.test(input.approvalId) ||
    typeof input.connectAdmin !== "function" ||
    !(input.signal instanceof AbortSignal) ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_INPUT_INVALID",
      "Read-only credential rotation preparation input is malformed.",
    );
  }
  throwIfAborted(input.signal);
  const now = input.now ?? (() => new Date());
  const issuedAt = exactTimestamp(now);
  const expiresAt = new Date(
    Date.parse(issuedAt) + PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_AGE_MS,
  ).toISOString();
  const requestBase = {
    schemaVersion: PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA,
    kind: "site-logbook-production-runtime-db-credential-rotation-request",
    operation: "rotate-existing-runtime-credential",
    liveSourceSha: input.liveSourceSha,
    executorSourceSha: input.embeddedSourceSha,
    executorImage: input.executorImage,
    databaseName: input.databaseName,
    runtimeRole: PRODUCTION_RUNTIME_DATABASE_USER,
    migratorRole: PRODUCTION_MIGRATOR_DATABASE_USER,
    expectedMigrationPlanSha256: productionRuntimeDbCredentialSha256(
      input.migrationPlanCanonical,
    ),
    expectedRoleTransactionReceiptSha256: productionRuntimeDbCredentialSha256(
      input.roleTransactionReceiptCanonical,
    ),
    expectedRolePostCommitArtifactSha256: productionRuntimeDbCredentialSha256(
      input.rolePostCommitArtifactCanonical,
    ),
    approvalId: input.approvalId,
    issuedAt,
    expiresAt,
    advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    confirmation: PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION,
    authorizesDeployment: false,
  } as const;
  const provisional = createProductionRuntimeDbCredentialRotationRequest({
    ...requestBase,
    expectedCurrentCredentialVerifierSha256: `sha256:${"0".repeat(64)}`,
  }).value;
  const roleAuthority = assertRoleAuthority(provisional, input);
  let admin: ProductionRuntimeCredentialClient | undefined;
  let transactionOpen = false;
  let destroyAdmin = false;
  try {
    admin = await input.connectAdmin();
    throwIfAborted(input.signal);
    await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE READ ONLY");
    transactionOpen = true;
    await admin.query("SELECT pg_advisory_xact_lock($1::integer)", [
      PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    ]);
    const liveProjectionRow = oneRow(
      await admin.query(PRODUCTION_ROLE_PROJECTION_SQL, [
        input.databaseName,
        PRODUCTION_RUNTIME_DATABASE_USER,
        PRODUCTION_MIGRATOR_DATABASE_USER,
      ]),
      ["projection"],
      "rotationPrepareLiveRoleProjection",
    );
    let liveRoleProjection: ProductionRoleProjection;
    try {
      liveRoleProjection = normalizeProductionMigrationRoleProjection(
        liveProjectionRow.projection,
        roleAuthority.rolePlan,
        { allowNullFunctions: true },
      );
      const validation = validateProductionRoleProjection(liveRoleProjection);
      if (!validation.ok) {
        const first = validation.errors[0];
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_ROLE_INVALID",
          `Live role projection failed at ${first?.code ?? "UNKNOWN"}:${first?.path ?? "$"}.`,
        );
      }
    } catch (error) {
      if (error instanceof ProductionRuntimeDbCredentialCutoverError) {
        throw error;
      }
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_ROLE_INVALID",
        "Live role projection could not be normalized under the read-only attended lock.",
        { cause: error },
      );
    }
    if (
      canonicalProductionRuntimeDbCredentialJson(liveRoleProjection) !==
      canonicalProductionRuntimeDbCredentialJson(
        roleAuthority.approvedProjection,
      )
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_ROLE_DRIFT",
        "Live role projection differs from the approved post-commit authority.",
      );
    }
    const pre = oneRow(
      await admin.query(ADMIN_PRECONDITION_SQL, [
        PRODUCTION_RUNTIME_DATABASE_USER,
        PRODUCTION_MIGRATOR_DATABASE_USER,
      ]),
      [
        "databaseName",
        "sessionUser",
        "currentUser",
        "adminSuperuser",
        "runtimeExists",
        "runtimeLogin",
        "runtimePrivileged",
        "runtimeCredentialPresent",
        "migratorExists",
        "migratorLogin",
      ],
      "rotationPrepareAdminPrecondition",
    );
    if (
      pre.databaseName !== input.databaseName ||
      typeof pre.sessionUser !== "string" ||
      pre.sessionUser !== pre.currentUser ||
      pre.sessionUser === PRODUCTION_RUNTIME_DATABASE_USER ||
      pre.sessionUser === PRODUCTION_MIGRATOR_DATABASE_USER ||
      pre.adminSuperuser !== true ||
      pre.runtimeExists !== true ||
      pre.runtimeLogin !== true ||
      pre.runtimePrivileged !== false ||
      pre.runtimeCredentialPresent !== true ||
      pre.migratorExists !== true ||
      pre.migratorLogin !== false
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_PRECONDITION_FAILED",
        "Live roles or attended administrator differ from the exact rotation predecessor.",
      );
    }
    const current = oneRow(
      await admin.query(RUNTIME_CREDENTIAL_STATE_SQL, [
        PRODUCTION_RUNTIME_DATABASE_USER,
      ]),
      ["runtimeCredentialVerifier"],
      "rotationPrepareCredentialState",
    );
    if (
      typeof current.runtimeCredentialVerifier !== "string" ||
      !SCRAM_VERIFIER.test(current.runtimeCredentialVerifier)
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_PREDECESSOR_INVALID",
        "Existing runtime credential is absent, ambiguous, or not an exact PostgreSQL 16 SCRAM verifier.",
      );
    }
    const prepared = createProductionRuntimeDbCredentialRotationRequest({
      ...requestBase,
      expectedCurrentCredentialVerifierSha256:
        productionRuntimeDbCredentialSha256(current.runtimeCredentialVerifier),
    });
    assertSecretFreeCredentialEvidence(prepared.value, "rotationRequest");
    throwIfAborted(input.signal);
    await admin.query("ROLLBACK");
    transactionOpen = false;
    return Object.freeze({
      decision: "PREPARED" as const,
      requestCanonical: prepared.canonical,
      requestSha256: prepared.sha256,
      authorizesCredentialMutation: false as const,
      authorizesApplicationStart: false as const,
      authorizesDeployment: false as const,
    });
  } catch (error) {
    if (transactionOpen && admin) {
      try {
        await admin.query("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError) {
        destroyAdmin = true;
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_ROLLBACK_UNKNOWN",
          "Read-only preparation transaction closure is unknown; emit no request and investigate.",
          { cause: rollbackError, manualReviewRequired: true },
        );
      }
    }
    throw error;
  } finally {
    if (admin) await admin.release(destroyAdmin);
  }
}

async function applyProductionRuntimeDbCredentialMutation(
  input:
    | ProductionRuntimeDbCredentialCutoverInput
    | ProductionRuntimeDbCredentialRotationInput,
  expectedCeremony: "first-cutover" | "rotation",
) {
  const rotation = expectedCeremony === "rotation";
  if (
    !isRecord(input) ||
    typeof input.requestCanonical !== "string" ||
    typeof input.migrationPlanCanonical !== "string" ||
    typeof input.roleTransactionReceiptCanonical !== "string" ||
    typeof input.rolePostCommitArtifactCanonical !== "string" ||
    typeof input.embeddedSourceSha !== "string" ||
    !SOURCE_SHA.test(input.embeddedSourceSha) ||
    typeof input.executorImage !== "string" ||
    !IMMUTABLE_IMAGE.test(input.executorImage) ||
    (rotation
      ? !("persistGeneratedSecret" in input) ||
        typeof input.persistGeneratedSecret !== "function"
      : !("runtimePassword" in input) ||
        typeof input.runtimePassword !== "string") ||
    typeof input.connectAdmin !== "function" ||
    typeof input.connectRuntime !== "function" ||
    !(input.signal instanceof AbortSignal) ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_INPUT_INVALID",
      "Credential ceremony input is malformed.",
    );
  }
  const request = parseProductionRuntimeDbCredentialRequest(
    input.requestCanonical,
  );
  if (
    (rotation &&
      request.schemaVersion !==
        PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA) ||
    (!rotation &&
      request.schemaVersion !== PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA)
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_CEREMONY_MISMATCH",
      "Credential request schema does not match the selected attended ceremony.",
    );
  }
  let runtimePassword = rotation
    ? ""
    : requireProductionRuntimeDatabasePassword(
        (input as ProductionRuntimeDbCredentialCutoverInput).runtimePassword,
      );
  const roleAuthority = assertRoleAuthority(request, input);
  throwIfAborted(input.signal);
  const now = input.now ?? (() => new Date());
  const startedAt = exactTimestamp(now);
  if (rotation) {
    const issuedAt = parseCredentialTimestamp(
      (request as ProductionRuntimeDbCredentialRotationRequest).issuedAt,
      "credentialRotationRequest.issuedAt",
    );
    const expiresAt = parseCredentialTimestamp(
      (request as ProductionRuntimeDbCredentialRotationRequest).expiresAt,
      "credentialRotationRequest.expiresAt",
    );
    const startTime = Date.parse(startedAt);
    if (
      startTime + PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS <
        issuedAt ||
      startTime >
        expiresAt + PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_STALE",
        "Credential rotation request is not currently valid.",
      );
    }
    runtimePassword = generateFreshProductionRuntimeDbCredentialSecret();
    try {
      await (
        input as ProductionRuntimeDbCredentialRotationInput
      ).persistGeneratedSecret(runtimePassword);
    } catch (error) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_CUSTODY_FAILED",
        "Fresh runtime credential could not be durably transferred to private custody before mutation.",
        { cause: error },
      );
    }
  }
  let admin: ProductionRuntimeCredentialClient | undefined;
  let runtime: ProductionRuntimeCredentialClient | undefined;
  let transactionOpen = false;
  let commitStarted = false;
  let commitConfirmed = false;
  let destroyAdmin = false;
  try {
    admin = await input.connectAdmin();
    throwIfAborted(input.signal);
    await admin.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    transactionOpen = true;
    await admin.query("SELECT pg_advisory_xact_lock($1::integer)", [
      request.advisoryLockKey,
    ]);
    let liveRoleProjection: ProductionRoleProjection;
    try {
      const liveProjectionRow = oneRow(
        await admin.query(PRODUCTION_ROLE_PROJECTION_SQL, [
          request.databaseName,
          PRODUCTION_RUNTIME_DATABASE_USER,
          PRODUCTION_MIGRATOR_DATABASE_USER,
        ]),
        ["projection"],
        "liveRoleProjection",
      );
      liveRoleProjection = normalizeProductionMigrationRoleProjection(
        liveProjectionRow.projection,
        roleAuthority.rolePlan,
        { allowNullFunctions: true },
      );
      const validation = validateProductionRoleProjection(liveRoleProjection);
      if (!validation.ok) {
        const first = validation.errors[0];
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_LIVE_ROLE_PROJECTION_INVALID",
          `Live role projection failed the source-reviewed contract at ${first?.code ?? "UNKNOWN"}:${first?.path ?? "$"}.`,
        );
      }
    } catch (error) {
      if (error instanceof ProductionRuntimeDbCredentialCutoverError) {
        throw error;
      }
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_LIVE_ROLE_PROJECTION_INVALID",
        "Live role projection could not be normalized and validated under the attended transaction lock.",
        { cause: error },
      );
    }
    if (
      canonicalProductionRuntimeDbCredentialJson(liveRoleProjection) !==
      canonicalProductionRuntimeDbCredentialJson(
        roleAuthority.approvedProjection,
      )
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROLE_DRIFT",
        "Live memberships, ACLs, defaults, owners, settings, or role attributes differ from the approved post-commit projection.",
      );
    }
    const pre = oneRow(
      await admin.query(ADMIN_PRECONDITION_SQL, [
        PRODUCTION_RUNTIME_DATABASE_USER,
        PRODUCTION_MIGRATOR_DATABASE_USER,
      ]),
      [
        "databaseName",
        "sessionUser",
        "currentUser",
        "adminSuperuser",
        "runtimeExists",
        "runtimeLogin",
        "runtimePrivileged",
        "runtimeCredentialPresent",
        "migratorExists",
        "migratorLogin",
      ],
      "adminPrecondition",
    );
    if (
      pre.databaseName !== request.databaseName ||
      typeof pre.sessionUser !== "string" ||
      pre.sessionUser !== pre.currentUser ||
      pre.sessionUser === request.runtimeRole ||
      pre.sessionUser === request.migratorRole ||
      pre.adminSuperuser !== true ||
      pre.runtimeExists !== true ||
      pre.runtimeLogin !== true ||
      pre.runtimePrivileged !== false ||
      pre.runtimeCredentialPresent !== rotation ||
      pre.migratorExists !== true ||
      pre.migratorLogin !== false
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_PRECONDITION_FAILED",
        "Live roles or attended administrator differ from the approved separated state.",
      );
    }
    let previousRuntimeVerifier: string | undefined;
    if (rotation) {
      const current = oneRow(
        await admin.query(RUNTIME_CREDENTIAL_STATE_SQL, [
          PRODUCTION_RUNTIME_DATABASE_USER,
        ]),
        ["runtimeCredentialVerifier"],
        "runtimeCredentialStateBeforeRotation",
      );
      if (
        typeof current.runtimeCredentialVerifier !== "string" ||
        !SCRAM_VERIFIER.test(current.runtimeCredentialVerifier) ||
        productionRuntimeDbCredentialSha256(
          current.runtimeCredentialVerifier,
        ) !==
          (request as ProductionRuntimeDbCredentialRotationRequest)
            .expectedCurrentCredentialVerifierSha256
      ) {
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREDECESSOR_INVALID",
          "Existing runtime credential is absent, ambiguous, or not an exact PostgreSQL 16 SCRAM verifier.",
        );
      }
      previousRuntimeVerifier = current.runtimeCredentialVerifier;
    }
    throwIfAborted(input.signal);
    const scramVerifier = createPostgres16ScramSha256Verifier(runtimePassword);
    if (rotation && scramVerifier === previousRuntimeVerifier) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_REUSE_DETECTED",
        "Fresh credential unexpectedly reproduced the existing verifier.",
      );
    }
    const alterRoleStatement =
      createPostgres16RuntimeCredentialAlterStatement(scramVerifier);
    if (alterRoleStatement.includes(runtimePassword)) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_SQL_SECRET_LEAK",
        "Credential mutation SQL unexpectedly contains cleartext secret material.",
      );
    }
    await admin.query(alterRoleStatement);
    const changed = oneRow(
      await admin.query(RUNTIME_CREDENTIAL_STATE_SQL, [
        PRODUCTION_RUNTIME_DATABASE_USER,
      ]),
      ["runtimeCredentialVerifier"],
      "runtimeCredentialState",
    );
    if (changed.runtimeCredentialVerifier !== scramVerifier) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_IN_TRANSACTION_VERIFY_FAILED",
        "The exact client-derived SCRAM verifier was not stored inside the attended transaction.",
      );
    }
    throwIfAborted(input.signal);
    commitStarted = true;
    await admin.query("COMMIT");
    transactionOpen = false;
    commitConfirmed = true;

    throwIfAborted(input.signal);
    try {
      runtime = await input.connectRuntime({
        databaseName: request.databaseName,
        databaseUser: PRODUCTION_RUNTIME_DATABASE_USER,
        password: runtimePassword,
      });
      const proof = oneRow(
        await runtime.query(RUNTIME_LOGIN_PROOF_SQL),
        ["databaseName", "sessionUser", "currentUser"],
        "runtimeLoginProof",
      );
      if (
        proof.databaseName !== request.databaseName ||
        proof.sessionUser !== PRODUCTION_RUNTIME_DATABASE_USER ||
        proof.currentUser !== PRODUCTION_RUNTIME_DATABASE_USER
      ) {
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_POST_COMMIT_VERIFY_FAILED",
          "Fresh runtime login did not assume the exact source-pinned identity.",
          { manualReviewRequired: true },
        );
      }
    } catch (error) {
      if (error instanceof ProductionRuntimeDbCredentialCutoverError) {
        throw error;
      }
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_POST_COMMIT_VERIFY_FAILED",
        "Credential may be committed but fresh runtime login verification failed; do not retry blindly.",
        { cause: error, manualReviewRequired: true },
      );
    }
    const completedAt = exactTimestamp(now);
    if (
      rotation &&
      Date.parse(completedAt) >
        Date.parse(
          (request as ProductionRuntimeDbCredentialRotationRequest).expiresAt,
        ) +
          PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_MAX_CLOCK_SKEW_MS
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_EXPIRED_AFTER_COMMIT",
        "Credential rotated, but the attended request expired before verification completed; do not activate or retry blindly.",
        { manualReviewRequired: true },
      );
    }
    const receipt = Object.freeze({
      schemaVersion: rotation
        ? PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_RECEIPT_SCHEMA
        : PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA,
      kind: rotation
        ? "site-logbook-production-runtime-db-credential-rotation-receipt"
        : "site-logbook-production-runtime-db-credential-cutover-receipt",
      ...(rotation
        ? { operation: "rotate-existing-runtime-credential" as const }
        : {}),
      decision: "PASS",
      sourceBinding: Object.freeze({
        liveSourceSha: request.liveSourceSha,
        executorSourceSha: request.executorSourceSha,
        executorImage: request.executorImage,
      }),
      requestSha256: productionRuntimeDbCredentialSha256(
        input.requestCanonical,
      ),
      database: Object.freeze({
        name: request.databaseName,
        adminSessionUser: pre.sessionUser,
        runtimeUser: PRODUCTION_RUNTIME_DATABASE_USER,
        migratorUser: PRODUCTION_MIGRATOR_DATABASE_USER,
      }),
      roleEvidence: Object.freeze({
        migrationPlanSha256: request.expectedMigrationPlanSha256,
        transactionReceiptSha256: request.expectedRoleTransactionReceiptSha256,
        postCommitArtifactSha256: request.expectedRolePostCommitArtifactSha256,
      }),
      transaction: Object.freeze({
        isolationLevel: "serializable",
        advisoryLockKey: request.advisoryLockKey,
        credentialMutationMechanism:
          "postgresql-16-client-side-scram-sha-256-verifier",
        cleartextCredentialSentInSql: false,
        cleartextCredentialSentAsQueryParameter: false,
        committed: true,
      }),
      verification: rotation
        ? Object.freeze({
            credentialWasPresentBefore: true,
            predecessorVerifierSha256Matched: true,
            previousVerifierDifferedFromNew: true,
            credentialPresentInTransaction: true,
            exactScramVerifierStoredInTransaction: true,
            freshRuntimeLoginVerified: true,
            exactRuntimeIdentityVerified: true,
            freshSecretGeneratedByControlPlane: true,
            secretBytesAbsentFromEvidenceAndLogs: true,
          })
        : Object.freeze({
            credentialWasAbsentBefore: true,
            credentialPresentInTransaction: true,
            exactScramVerifierStoredInTransaction: true,
            freshRuntimeLoginVerified: true,
            exactRuntimeIdentityVerified: true,
          }),
      approvalId: request.approvalId,
      startedAt,
      completedAt,
      requiresExplicitCoolifySecretTransfer: true,
      authorizesApplicationStart: false,
      authorizesDeployment: false,
    });
    const receiptCanonical =
      canonicalProductionRuntimeDbCredentialJson(receipt);
    if (receiptCanonical.includes(runtimePassword)) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_EVIDENCE_SECRET_LEAK",
        "Credential receipt unexpectedly contains secret material.",
        { manualReviewRequired: true },
      );
    }
    return Object.freeze({
      request,
      receiptCanonical,
      receiptSha256: productionRuntimeDbCredentialSha256(receiptCanonical),
      authorizesApplicationStart: false as const,
      authorizesDeployment: false as const,
    });
  } catch (error) {
    if (commitStarted && !commitConfirmed) {
      destroyAdmin = true;
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_COMMIT_OUTCOME_UNKNOWN",
        "Credential commit outcome is unknown; do not retry or change Coolify until attended read-only investigation.",
        {
          cause: error,
          manualReviewRequired: true,
          commitOutcomeUnknown: true,
        },
      );
    }
    if (commitConfirmed) {
      destroyAdmin = true;
      if (
        error instanceof ProductionRuntimeDbCredentialCutoverError &&
        error.manualReviewRequired
      ) {
        throw error;
      }
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_POST_COMMIT_INCOMPLETE",
        "Credential was committed but ceremony completion is unverified; do not retry blindly.",
        { cause: error, manualReviewRequired: true },
      );
    }
    if (transactionOpen && admin) {
      try {
        await admin.query("ROLLBACK");
        transactionOpen = false;
      } catch (rollbackError) {
        destroyAdmin = true;
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROLLBACK_OUTCOME_UNKNOWN",
          "Credential rollback outcome is unknown; stop for attended investigation.",
          {
            cause: rollbackError,
            manualReviewRequired: true,
            commitOutcomeUnknown: true,
          },
        );
      }
    }
    throw error;
  } finally {
    if (runtime) await runtime.release(false);
    if (admin) await admin.release(destroyAdmin);
  }
}

export async function applyProductionRuntimeDbCredentialCutover(
  input: ProductionRuntimeDbCredentialCutoverInput,
) {
  return applyProductionRuntimeDbCredentialMutation(input, "first-cutover");
}

export async function applyProductionRuntimeDbCredentialRotation(
  input: ProductionRuntimeDbCredentialRotationInput,
) {
  return applyProductionRuntimeDbCredentialMutation(input, "rotation");
}

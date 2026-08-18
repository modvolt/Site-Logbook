import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

// @ts-ignore -- the exact migration/role lock is source-pinned outside the API rootDir.
import { PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY } from "../../../../scripts/production-evidence/production-migration-contract.mjs";
// @ts-ignore -- the credential control plane intentionally binds the existing source role authority outside the API rootDir.
import {
  assertProductionMigrationRolePostCommit,
  assertProductionMigrationRolePrecondition,
} from "../../../../scripts/production-evidence/production-migration-role-authority.js";
// @ts-ignore -- this source-reviewed normalizer lives outside the API rootDir by design.
import { normalizeProductionMigrationRoleBootstrapProjection } from "../../../../scripts/production-evidence/production-migration-role-bootstrap.js";
// @ts-ignore -- the credential control plane reuses the exact source role projection contract outside the API rootDir.
import {
  PRODUCTION_ROLE_PROJECTION_SQL,
  validateProductionRoleProjection,
  type ProductionRolePlan,
  type ProductionRoleProjection,
} from "../../../../lib/db/src/production-role-separation-contract.js";
import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_DATABASE_USER,
  requireProductionRuntimeDatabasePassword,
} from "./production-runtime-database";

export const PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA =
  "site-logbook.production-runtime-db-credential-cutover-request/v1" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA =
  "site-logbook.production-runtime-db-credential-cutover-receipt/v1" as const;
export const PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION =
  "SET_EXACT_PRODUCTION_RUNTIME_DB_CREDENTIAL_AFTER_ROLE_SEPARATION" as const;
export { PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY };

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;
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
): ProductionRuntimeDbCredentialRequest {
  const value = parseCanonicalObject(canonical, "credentialRequest", 64 * 1024);
  if (
    !exactKeys(value, REQUEST_KEYS) ||
    value.schemaVersion !== PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA ||
    value.kind !==
      "site-logbook-production-runtime-db-credential-cutover-request" ||
    typeof value.liveSourceSha !== "string" ||
    !SOURCE_SHA.test(value.liveSourceSha) ||
    typeof value.executorSourceSha !== "string" ||
    !SOURCE_SHA.test(value.executorSourceSha) ||
    typeof value.executorImage !== "string" ||
    !IMMUTABLE_IMAGE.test(value.executorImage) ||
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
  request: ProductionRuntimeDbCredentialRequest,
  input: ProductionRuntimeDbCredentialCutoverInput,
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

export async function applyProductionRuntimeDbCredentialCutover(
  input: ProductionRuntimeDbCredentialCutoverInput,
) {
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
    typeof input.runtimePassword !== "string" ||
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
  const runtimePassword = requireProductionRuntimeDatabasePassword(
    input.runtimePassword,
  );
  const roleAuthority = assertRoleAuthority(request, input);
  throwIfAborted(input.signal);
  const now = input.now ?? (() => new Date());
  const startedAt = exactTimestamp(now);
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
      liveRoleProjection = normalizeProductionMigrationRoleBootstrapProjection(
        liveProjectionRow.projection,
        roleAuthority.rolePlan,
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
      pre.runtimeCredentialPresent !== false ||
      pre.migratorExists !== true ||
      pre.migratorLogin !== false
    ) {
      fail(
        "PRODUCTION_RUNTIME_DB_CREDENTIAL_PRECONDITION_FAILED",
        "Live roles or attended administrator differ from the approved separated state.",
      );
    }
    throwIfAborted(input.signal);
    const scramVerifier = createPostgres16ScramSha256Verifier(runtimePassword);
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
    const receipt = Object.freeze({
      schemaVersion: PRODUCTION_RUNTIME_DB_CREDENTIAL_RECEIPT_SCHEMA,
      kind: "site-logbook-production-runtime-db-credential-cutover-receipt",
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
      verification: Object.freeze({
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

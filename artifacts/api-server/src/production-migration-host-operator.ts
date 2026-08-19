import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";

import { Pool } from "pg";

// @ts-ignore -- source-bound host authority is intentionally bundled from outside the API rootDir.
import * as runtimeAuthority from "../../../scripts/production-evidence/production-migration-docker-runtime-authority.mjs";
import * as roleAuthority from "@workspace/db/production-migration-role-authority";
// prettier-ignore
// @ts-ignore -- host-only runner is intentionally bundled from outside the API rootDir.
import { PRODUCTION_MIGRATION_AUTHORITY_BINDINGS, persistProductionMigrationMode0600Exclusive, runProductionMigrationCli } from "../../../scripts/production-evidence/run-production-migration.mjs";
// prettier-ignore
// @ts-ignore -- host-only bootstrap is intentionally bundled from outside the API rootDir.
import { PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION, runProductionMigrationRoleBootstrap } from "../../../scripts/production-evidence/production-migration-role-bootstrap.js";
// prettier-ignore
// @ts-ignore -- host-only migration adapter is intentionally bundled from outside the API rootDir.
import { createPgProductionMigrationDatabase, createProductionMigrationBackupAuthority, createProductionMigrationRoleBinding, createVerifiedProductionMigrationPlan, loadProductionMigrationCatalog } from "../../../scripts/production-evidence/production-migration-adapter.mjs";
// prettier-ignore
// @ts-ignore -- host-only migration contract is intentionally bundled from outside the API rootDir.
import { createProductionMigrationArtifact, parseProductionMigrationLiveIdentity } from "../../../scripts/production-evidence/production-migration-contract.mjs";
// @ts-ignore -- host-only backup parser is intentionally bundled from outside the API rootDir.
import { parseProductionExact0096BackupPlan } from "../../../scripts/production-evidence/production-exact-0096-backup-planner.mjs";
// @ts-ignore -- host-only backup canonicalizer is intentionally bundled from outside the API rootDir.
import { canonicalProductionExact0096BackupJson } from "../../../scripts/production-evidence/production-exact-0096-backup-contract.mjs";
import { canonicalProductionRoleJson } from "@workspace/db/production-migration-role-authority";

const MAX_REQUEST_BYTES = 64 * 1024;
const ROLE_BOOTSTRAP_TIMEOUT_MS = 15 * 60 * 1000;
const ROLE_BOOTSTRAP_SCHEMA =
  "site-logbook.production-migration-role-bootstrap-request/v1";
const BASELINE_OBSERVATION_SCHEMA =
  "site-logbook.production-migration-baseline-observation-request/v1";
const BASELINE_OBSERVATION_CONFIRMATION =
  "OBSERVE_EXACT_0096_PRODUCTION_MIGRATION_BASELINE_READ_ONLY";
const ASSEMBLY_SCHEMA =
  "site-logbook.production-migration-runner-assembly-request/v2";
const ASSEMBLY_CONFIRMATION =
  "ASSEMBLE_EXACT_0096_PRODUCTION_MIGRATION_ARTIFACTS";
const ROLE_BOOTSTRAP_KEYS = [
  "schemaVersion",
  "kind",
  "sourceSha",
  "databaseName",
  "sessionUser",
  "migrationRole",
  "runtimeRole",
  "approvalId",
  "advisoryLockKey",
  "confirmation",
  "authorizesApplicationStart",
] as const;
const BASELINE_OBSERVATION_KEYS = [
  "schemaVersion",
  "kind",
  "sourceSha",
  "databaseName",
  "sessionUser",
  "migrationRole",
  "runtimeRole",
  "confirmation",
  "authorizesProductionMigration",
] as const;
const ASSEMBLY_KEYS = [
  "schemaVersion",
  "kind",
  "sourceSha",
  "databaseName",
  "sessionUser",
  "migrationRole",
  "runtimeRole",
  "intentId",
  "approvalId",
  "inputs",
  "confirmation",
  "authorizesProductionMigration",
  "authorizesApplicationStart",
] as const;
const ASSEMBLY_INPUT_KEYS = [
  "targetEvidence",
  "baselineLiveIdentity",
  "backupPlan",
  "backupExecutorTrace",
  "backupReceipt",
  "backupSignatureEnvelope",
  "backupDetachedSignature",
  "rolePrecondition",
  "roleBootstrapReceipt",
] as const;
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const EVIDENCE_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

function fail(code: string, message: string, cause?: unknown): never {
  const error = new Error(`${code}: ${message}`, { cause });
  Object.assign(error, { code });
  throw error;
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  field: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      `${field} is invalid.`,
    );
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      `${field} does not have the exact reviewed keys.`,
    );
  }
  return record;
}

function parseOptions(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_ARGUMENT_INVALID",
        "Role-bootstrap arguments must be exact --name value pairs.",
      );
    }
    const name = key.slice(2);
    if (name in result) {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_ARGUMENT_INVALID",
        "Role-bootstrap arguments must not repeat.",
      );
    }
    result[name] = value;
  }
  return result;
}

async function readStableCanonicalRequest(
  filename: string,
  keys: readonly string[] = ROLE_BOOTSTRAP_KEYS,
  field = "roleBootstrapRequest",
) {
  const absolute = path.resolve(filename);
  const before = await lstat(absolute, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(MAX_REQUEST_BYTES)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Role-bootstrap request is not one bounded regular file.",
    );
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    bytes.length !== Number(before.size)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_DRIFT",
      "Role-bootstrap request changed during its bounded read.",
    );
  }
  const raw = bytes.toString("utf8");
  if (Buffer.from(raw, "utf8").compare(bytes) !== 0 || raw.includes("\0")) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Role-bootstrap request is not exact UTF-8.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Role-bootstrap request is not JSON.",
      error,
    );
  }
  const request = exactObject(parsed, keys, field);
  if (canonicalProductionRoleJson(request) !== raw) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Role-bootstrap request is not canonical JSON.",
    );
  }
  return request;
}

async function readStableBytes(filename: string, maximumBytes: number) {
  const absolute = path.resolve(filename);
  const before = await lstat(absolute, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Input artifact is not one bounded regular file.",
    );
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    bytes.length !== Number(before.size)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_DRIFT",
      "Input artifact changed during its bounded read.",
    );
  }
  return bytes;
}

async function readStableUtf8(filename: string, maximumBytes: number) {
  const bytes = await readStableBytes(filename, maximumBytes);
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.includes("\0")) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Input artifact is not exact UTF-8.",
    );
  }
  return text;
}

function reviewedRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value !== value.trim() ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    !/^[A-Za-z0-9._/-]+$/.test(value)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
      `${field} is not one reviewed descriptor-relative path.`,
    );
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
      `${field} contains an unsafe path segment.`,
    );
  }
  return value;
}

async function resolveInputBelow(
  rootReal: string,
  relative: unknown,
  field: string,
): Promise<string> {
  const reviewed = reviewedRelativePath(relative, field);
  const target = path.resolve(rootReal, ...reviewed.split("/"));
  const metadata = await lstat(target, { bigint: true });
  const targetReal = await realpath(target);
  const relation = path.relative(rootReal, targetReal);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1n ||
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
      `${field} is not one regular input below the evidence root.`,
    );
  }
  return targetReal;
}

function connectionStringFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment.PRODUCTION_MIGRATION_DATABASE_URL;
  if (
    typeof value !== "string" ||
    value.length < 16 ||
    value.length > 8192 ||
    value !== value.trim()
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_CONNECTION_UNAVAILABLE",
      "PRODUCTION_MIGRATION_DATABASE_URL is unavailable.",
    );
  }
  return value;
}

function validateAssemblyRequest(value: unknown) {
  const request = exactObject(value, ASSEMBLY_KEYS, "runnerAssemblyRequest");
  const inputs = exactObject(
    request.inputs,
    ASSEMBLY_INPUT_KEYS,
    "runnerAssemblyRequest.inputs",
  );
  if (
    request.schemaVersion !== ASSEMBLY_SCHEMA ||
    request.kind !==
      "site-logbook-production-migration-runner-assembly-request" ||
    request.confirmation !== ASSEMBLY_CONFIRMATION ||
    request.authorizesProductionMigration !== false ||
    request.authorizesApplicationStart !== false ||
    typeof request.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(request.sourceSha) ||
    typeof request.intentId !== "string" ||
    !/^[0-9a-f]{64}$/.test(request.intentId) ||
    typeof request.approvalId !== "string" ||
    !EVIDENCE_ID.test(request.approvalId)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Runner assembly request is not exact, attended and non-authorizing.",
    );
  }
  for (const field of [
    "databaseName",
    "sessionUser",
    "migrationRole",
    "runtimeRole",
  ] as const) {
    if (typeof request[field] !== "string" || !ROLE_NAME.test(request[field])) {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
        `runnerAssemblyRequest.${field} is not one exact PostgreSQL identifier.`,
      );
    }
  }
  if (
    request.sessionUser === request.migrationRole ||
    request.sessionUser === request.runtimeRole ||
    request.migrationRole === request.runtimeRole
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Runner assembly requires three distinct session, migration and runtime roles.",
    );
  }
  for (const field of ASSEMBLY_INPUT_KEYS) {
    reviewedRelativePath(
      inputs[field],
      `runnerAssemblyRequest.inputs.${field}`,
    );
  }
  return Object.freeze({ request, inputs });
}

export function createProductionMigrationRunnerAssembly(
  requestValue: unknown,
  artifactsValue: unknown,
  {
    backupAuthority = createProductionMigrationBackupAuthority(),
  }: {
    backupAuthority?: ReturnType<
      typeof createProductionMigrationBackupAuthority
    >;
  } = {},
) {
  const { request, inputs } = validateAssemblyRequest(requestValue);
  const artifacts = exactObject(
    artifactsValue,
    ASSEMBLY_INPUT_KEYS,
    "runnerAssemblyArtifacts",
  );
  for (const field of ASSEMBLY_INPUT_KEYS.filter(
    (field) => field !== "backupDetachedSignature",
  )) {
    if (typeof artifacts[field] !== "string") {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
        `runnerAssemblyArtifacts.${field} is not canonical UTF-8.`,
      );
    }
  }
  if (
    !Buffer.isBuffer(artifacts.backupDetachedSignature) ||
    artifacts.backupDetachedSignature.length !== 64
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Detached backup signature is not one exact Ed25519 signature.",
    );
  }
  const live = parseProductionMigrationLiveIdentity(
    artifacts.baselineLiveIdentity as string,
    "baselineLiveIdentity",
  );
  const database = live.value.database as {
    name: string;
    sessionUser: string;
    currentUser: string;
  };
  if (
    live.value.sourceSha !== request.sourceSha ||
    database.name !== request.databaseName ||
    database.sessionUser !== request.sessionUser ||
    database.currentUser !== request.migrationRole
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_BASELINE_INVALID",
      "Assembly request differs from the fresh exact-0096 live identity.",
    );
  }
  const plan = createVerifiedProductionMigrationPlan(
    {
      sourceSha: request.sourceSha,
      targetEvidenceCanonical: artifacts.targetEvidence,
      baselineLiveIdentityCanonical: artifacts.baselineLiveIdentity,
      database,
      backupPlanCanonical: artifacts.backupPlan,
      backupExecutorTraceCanonical: artifacts.backupExecutorTrace,
      backupReceiptCanonical: artifacts.backupReceipt,
      backupSignatureEnvelopeCanonical: artifacts.backupSignatureEnvelope,
      backupDetachedSignatureB64:
        artifacts.backupDetachedSignature.toString("base64"),
      rolePreconditionCanonical: artifacts.rolePrecondition,
      roleBootstrapReceiptCanonical: artifacts.roleBootstrapReceipt,
      baselineInventory: live.value.inventory,
    },
    backupAuthority,
  );
  const rolePrecondition = JSON.parse(
    plan.value.rolePreconditionCanonical,
  ) as Record<string, unknown>;
  const roleBootstrapReceipt = JSON.parse(
    plan.value.roleBootstrapReceiptCanonical,
  ) as Record<string, unknown>;
  if (
    rolePrecondition.runtimeRole !== request.runtimeRole ||
    rolePrecondition.migrationRole !== request.migrationRole ||
    roleBootstrapReceipt.approvalId !== request.approvalId
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_ROLE_BINDING_INVALID",
      "Role precondition or bootstrap receipt differs from the exact assembly request.",
    );
  }
  const activationCanonical = canonicalProductionRoleJson({
    schemaVersion:
      "site-logbook.production-migration-role-ceremony-activation/v1",
    kind: "site-logbook-production-migration-role-ceremony-activation",
    enabled: true,
    expectedPlanSha256: rolePrecondition.rolePlanSha256,
    approvalId: request.approvalId,
    preProjectionCanonical: rolePrecondition.preProjectionCanonical,
    expectedPreProjectionSha256: rolePrecondition.preProjectionSha256,
    authorizesApplicationStart: false,
  });
  const descriptor = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-migration-runner-descriptor/v2",
    kind: "site-logbook-production-migration-runner-descriptor",
    executionDefault: "disabled",
    migrationsDirectory: "runner/lib/db/migrations",
    artifactDirectory: "migration-artifacts",
    authorities: {
      runtime: {
        id: PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.runtime.id,
        sha256: PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.runtime.sha256,
      },
      role: {
        id: PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.role.id,
        sha256: PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.role.sha256,
      },
    },
    roleCeremony: {
      activation: "evidence/production-migration-role-ceremony-activation.json",
      transactionReceipt:
        "evidence/production-migration-role-transaction-receipt.json",
      postCommitProjection:
        "evidence/production-migration-role-postcommit-projection.json",
    },
    connection: {
      source: "environment",
      reference: "PRODUCTION_MIGRATION_DATABASE_URL",
    },
    inputs: Object.fromEntries(
      ASSEMBLY_INPUT_KEYS.map((field) => [field, inputs[field]]),
    ),
    roleBinding: {
      databaseName: request.databaseName,
      sessionUser: request.sessionUser,
      migrationRole: request.migrationRole,
      runtimeRole: request.runtimeRole,
    },
    intentId: request.intentId,
    authorizesApplicationStart: false,
  });
  return Object.freeze({
    descriptorCanonical: descriptor.canonical,
    descriptorSha256: descriptor.sha256,
    activationCanonical,
    activationSha256: `sha256:${createHash("sha256")
      .update(activationCanonical, "utf8")
      .digest("hex")}`,
    migrationPlanSha256: plan.sha256,
    authorizesProductionMigration: false,
    authorizesApplicationStart: false,
  });
}

export async function runProductionMigrationRoleBootstrapCli(
  argv: readonly string[],
  { environment = process.env, now = () => new Date() } = {},
) {
  const options = parseOptions(argv);
  if (
    Object.keys(options).sort().join(",") !==
      ["confirm", "evidence-dir", "request"].sort().join(",") ||
    options.confirm !== PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED",
      "Role bootstrap requires the exact request, evidence directory and confirmation.",
    );
  }
  const request = await readStableCanonicalRequest(options.request);
  if (
    request.schemaVersion !== ROLE_BOOTSTRAP_SCHEMA ||
    request.kind !==
      "site-logbook-production-migration-role-bootstrap-request" ||
    request.confirmation !== PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION ||
    request.confirmation !== options.confirm ||
    request.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Role-bootstrap request boundary is invalid.",
    );
  }
  const evidenceDirectory = await realpath(
    path.resolve(options["evidence-dir"]),
  );
  const evidenceMetadata = await lstat(evidenceDirectory, { bigint: true });
  if (!evidenceMetadata.isDirectory() || evidenceMetadata.isSymbolicLink()) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
      "Evidence directory is not one real directory.",
    );
  }
  const connectionString = connectionStringFromEnvironment(environment);
  const controller = new AbortController();
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error("PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_TIMEOUT"),
      ),
    ROLE_BOOTSTRAP_TIMEOUT_MS,
  );
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: "site-logbook-production-role-bootstrap",
  });
  try {
    const result = await runProductionMigrationRoleBootstrap({
      sourceSha: request.sourceSha as string,
      databaseName: request.databaseName as string,
      sessionUser: request.sessionUser as string,
      migrationRole: request.migrationRole as string,
      runtimeRole: request.runtimeRole as string,
      approvalId: request.approvalId as string,
      confirmation:
        request.confirmation as typeof PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_CONFIRMATION,
      advisoryLockKey: request.advisoryLockKey as number,
      connect: () => pool.connect(),
      signal: controller.signal,
      now,
    });
    const preconditionPath = path.join(
      evidenceDirectory,
      "production-migration-role-precondition.json",
    );
    const receiptPath = path.join(
      evidenceDirectory,
      "production-migration-role-bootstrap-receipt.json",
    );
    await persistProductionMigrationMode0600Exclusive(
      evidenceDirectory,
      preconditionPath,
      "productionMigrationRolePrecondition",
      result.preconditionCanonical,
    );
    await persistProductionMigrationMode0600Exclusive(
      evidenceDirectory,
      receiptPath,
      "productionMigrationRoleBootstrapReceipt",
      result.receiptCanonical,
    );
    return Object.freeze({
      status: "ROLE_BOOTSTRAP_COMMITTED",
      preconditionPath,
      preconditionSha256: result.preconditionSha256,
      receiptPath,
      receiptSha256: result.receiptSha256,
      authorizesApplicationStart: false,
      authorizesDeployment: false,
    });
  } finally {
    clearTimeout(timer);
    await pool.end();
  }
}

export async function runProductionMigrationBaselineObservationCli(
  argv: readonly string[],
  { environment = process.env } = {},
) {
  const options = parseOptions(argv);
  if (
    Object.keys(options).sort().join(",") !==
      ["backup-plan", "confirm", "evidence-dir", "migrations-dir", "request"]
        .sort()
        .join(",") ||
    options.confirm !== BASELINE_OBSERVATION_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED",
      "Baseline observation requires the exact paths and read-only confirmation.",
    );
  }
  const request = await readStableCanonicalRequest(
    options.request,
    BASELINE_OBSERVATION_KEYS,
    "baselineObservationRequest",
  );
  if (
    request.schemaVersion !== BASELINE_OBSERVATION_SCHEMA ||
    request.kind !==
      "site-logbook-production-migration-baseline-observation-request" ||
    request.confirmation !== BASELINE_OBSERVATION_CONFIRMATION ||
    request.confirmation !== options.confirm ||
    request.authorizesProductionMigration !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_INPUT_INVALID",
      "Baseline observation request boundary is invalid.",
    );
  }
  const evidenceDirectory = await realpath(
    path.resolve(options["evidence-dir"]),
  );
  const migrationsDirectory = await realpath(
    path.resolve(options["migrations-dir"]),
  );
  for (const [field, directory] of [
    ["evidenceDirectory", evidenceDirectory],
    ["migrationsDirectory", migrationsDirectory],
  ] as const) {
    const metadata = await lstat(directory, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
        `${field} is not one real directory.`,
      );
    }
  }
  const backupPlanCanonical = await readStableUtf8(
    options["backup-plan"],
    512 * 1024,
  );
  const backupPlan = parseProductionExact0096BackupPlan(backupPlanCanonical);
  if (
    backupPlan.value.liveSource.sha !== request.sourceSha ||
    backupPlan.value.sourceDatabase.name !== request.databaseName ||
    backupPlan.value.sourceDatabase.user !== request.sessionUser
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_BACKUP_BINDING_INVALID",
      "Signed backup plan is not bound to the requested live database session.",
    );
  }
  const roleBinding = createProductionMigrationRoleBinding({
    databaseName: request.databaseName,
    sessionUser: request.sessionUser,
    migrationRole: request.migrationRole,
    runtimeRole: request.runtimeRole,
  });
  const runtimeBindingCanonical = canonicalProductionExact0096BackupJson(
    backupPlan.value.runtimeBinding,
  );
  const connectionString = connectionStringFromEnvironment(environment);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("PRODUCTION_MIGRATION_BASELINE_TIMEOUT")),
    ROLE_BOOTSTRAP_TIMEOUT_MS,
  );
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 15_000,
    application_name: "site-logbook-production-baseline-observer",
  });
  try {
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory,
    });
    const database = createPgProductionMigrationDatabase({
      connect: () => pool.connect(),
      catalog,
      roleBindingCanonical: roleBinding.canonical,
      expectedRuntimeBindingCanonical: runtimeBindingCanonical,
      observeLiveRuntime: () =>
        runtimeAuthority.observeProductionMigrationRuntime({
          expectedRuntimeBindingCanonical: runtimeBindingCanonical,
          signal: controller.signal,
        }),
    });
    const liveArtifact = await database.readLiveIdentityReadOnly();
    const live = parseProductionMigrationLiveIdentity(
      liveArtifact.canonical,
      "baselineLiveIdentity",
    );
    if (
      live.value.sourceSha !== request.sourceSha ||
      live.value.database.name !== request.databaseName ||
      live.value.database.sessionUser !== request.sessionUser ||
      live.value.database.currentUser !== request.migrationRole ||
      live.state.stateIndex !== 0
    ) {
      fail(
        "PRODUCTION_MIGRATION_HOST_OPERATOR_BASELINE_INVALID",
        "Live database is not the exact 0096 migration baseline.",
      );
    }
    const target = createProductionMigrationArtifact({
      schemaVersion: "site-logbook.production-migration-target-evidence/v1",
      kind: "site-logbook-production-migration-target-evidence",
      sourceSha: live.value.sourceSha,
      database: live.value.database,
      inventory: live.value.inventory,
      capturedAt: live.value.observedAt,
      authorizesProductionMigration: false,
    });
    const targetPath = path.join(
      evidenceDirectory,
      "production-migration-target-evidence.json",
    );
    const livePath = path.join(
      evidenceDirectory,
      "production-migration-baseline-live-identity.json",
    );
    await persistProductionMigrationMode0600Exclusive(
      evidenceDirectory,
      targetPath,
      "productionMigrationTargetEvidence",
      target.canonical,
    );
    await persistProductionMigrationMode0600Exclusive(
      evidenceDirectory,
      livePath,
      "productionMigrationBaselineLiveIdentity",
      live.artifact.canonical,
    );
    return Object.freeze({
      status: "BASELINE_0096_OBSERVED",
      targetPath,
      targetSha256: `sha256:${target.sha256}`,
      liveIdentityPath: livePath,
      liveIdentitySha256: `sha256:${live.artifact.sha256}`,
      authorizesProductionMigration: false,
      authorizesApplicationStart: false,
    });
  } finally {
    clearTimeout(timer);
    await pool.end();
  }
}

export async function runProductionMigrationRunnerAssemblyCli(
  argv: readonly string[],
) {
  const options = parseOptions(argv);
  if (
    Object.keys(options).sort().join(",") !==
      ["confirm", "request", "root"].sort().join(",") ||
    options.confirm !== ASSEMBLY_CONFIRMATION
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_CONFIRMATION_REQUIRED",
      "Runner assembly requires the exact root, request and attended confirmation.",
    );
  }
  const request = await readStableCanonicalRequest(
    options.request,
    ASSEMBLY_KEYS,
    "runnerAssemblyRequest",
  );
  const validated = validateAssemblyRequest(request);
  const rootReal = await realpath(path.resolve(options.root));
  const rootMetadata = await lstat(rootReal, { bigint: true });
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_PATH_INVALID",
      "Runner assembly root is not one real directory.",
    );
  }
  const artifactInputs: Record<string, string | Buffer> = {};
  for (const field of ASSEMBLY_INPUT_KEYS) {
    const filename = await resolveInputBelow(
      rootReal,
      validated.inputs[field],
      `runnerAssemblyRequest.inputs.${field}`,
    );
    artifactInputs[field] =
      field === "backupDetachedSignature"
        ? await readStableBytes(filename, 128)
        : await readStableUtf8(filename, 512 * 1024);
  }
  const assembly = createProductionMigrationRunnerAssembly(
    validated.request,
    artifactInputs,
  );
  const artifactDirectory = path.join(rootReal, "migration-artifacts");
  try {
    await mkdir(artifactDirectory, { mode: 0o700 });
  } catch (error) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_ARTIFACT_DIRECTORY_INVALID",
      "Migration artifact directory must be created exactly once.",
      error,
    );
  }
  const artifactDirectoryMetadata = await lstat(artifactDirectory, {
    bigint: true,
  });
  if (
    !artifactDirectoryMetadata.isDirectory() ||
    artifactDirectoryMetadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (Number(artifactDirectoryMetadata.mode) & 0o077) !== 0)
  ) {
    fail(
      "PRODUCTION_MIGRATION_HOST_OPERATOR_ARTIFACT_DIRECTORY_INVALID",
      "Migration artifact directory is not one exact mode-0700 directory.",
    );
  }
  const activationPath = path.join(
    rootReal,
    "evidence",
    "production-migration-role-ceremony-activation.json",
  );
  const descriptorPath = path.join(
    rootReal,
    "production-migration-runner-descriptor.json",
  );
  await persistProductionMigrationMode0600Exclusive(
    rootReal,
    activationPath,
    "productionMigrationRoleCeremonyActivation",
    assembly.activationCanonical,
  );
  await persistProductionMigrationMode0600Exclusive(
    rootReal,
    descriptorPath,
    "productionMigrationRunnerDescriptor",
    assembly.descriptorCanonical,
  );
  return Object.freeze({
    status: "PRODUCTION_MIGRATION_RUNNER_ASSEMBLED",
    descriptorPath,
    descriptorSha256: assembly.descriptorSha256,
    activationPath,
    activationSha256: assembly.activationSha256,
    migrationPlanSha256: assembly.migrationPlanSha256,
    artifactDirectory,
    authorizesProductionMigration: false,
    authorizesApplicationStart: false,
  });
}

function exactAuthorityResolver(
  kind: "runtime" | "role",
  binding: { id: string; sha256: string },
) {
  const expected = PRODUCTION_MIGRATION_AUTHORITY_BINDINGS[kind];
  if (binding.id !== expected.id || binding.sha256 !== expected.sha256) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_INVALID",
      "Bundled host operator rejected an unpinned authority binding.",
    );
  }
  return kind === "runtime" ? runtimeAuthority : roleAuthority;
}

export async function runProductionMigrationHostOperator(
  argv: readonly string[],
) {
  if (argv[0] === "role-bootstrap") {
    return runProductionMigrationRoleBootstrapCli(argv.slice(1));
  }
  if (argv[0] === "observe-baseline") {
    return runProductionMigrationBaselineObservationCli(argv.slice(1));
  }
  if (argv[0] === "assemble-runner") {
    return runProductionMigrationRunnerAssemblyCli(argv.slice(1));
  }
  return runProductionMigrationCli(argv, {
    authorityResolver: (
      kind: "runtime" | "role",
      binding: { id: string; sha256: string },
    ) => exactAuthorityResolver(kind as "runtime" | "role", binding),
    createPool: (connectionString: string) =>
      new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 15_000,
        application_name: "site-logbook-production-migration-operator",
      }),
  });
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "--") argv.shift();
    const result = await runProductionMigrationHostOperator(argv);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "PRODUCTION_MIGRATION_HOST_OPERATOR_FAILED";
    process.stderr.write(
      `${code}: production migration host operation failed closed.\n`,
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}

export const PRODUCTION_MIGRATION_ROLE_BOOTSTRAP_REQUEST_SCHEMA =
  ROLE_BOOTSTRAP_SCHEMA;
export const PRODUCTION_MIGRATION_BASELINE_OBSERVATION_REQUEST_SCHEMA =
  BASELINE_OBSERVATION_SCHEMA;
export const PRODUCTION_MIGRATION_BASELINE_OBSERVATION_CONFIRMATION =
  BASELINE_OBSERVATION_CONFIRMATION;
export const PRODUCTION_MIGRATION_RUNNER_ASSEMBLY_REQUEST_SCHEMA =
  ASSEMBLY_SCHEMA;
export const PRODUCTION_MIGRATION_RUNNER_ASSEMBLY_CONFIRMATION =
  ASSEMBLY_CONFIRMATION;
export const productionMigrationRoleBootstrapRequestSha256 = (value: unknown) =>
  createHash("sha256")
    .update(canonicalProductionRoleJson(value), "utf8")
    .digest("hex");

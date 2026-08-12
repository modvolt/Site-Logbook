import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { open, readFile } from "node:fs/promises";

import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_MIGRATION_STEPS,
  PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
  exactDigest,
  exactObject,
  exactString,
  exactTimestamp,
  frozenStateSummary,
  parseCanonicalProductionMigrationArtifact,
  productionMigrationSha256,
  validateProductionMigrationInventory,
} from "./production-migration-contract.mjs";
import {
  createProductionMigrationPlan,
  createProductionMigrationIntentPersistenceReceipt,
  validateProductionMigrationIntent,
  validateProductionMigrationIntentPersistenceReceipt,
  validateProductionMigrationPlan,
} from "./production-migration-planner.mjs";
import {
  classifyProductionMigrationRecovery,
  createProductionMigrationStepReceipt,
  createProductionMigrationTransitionChain,
  verifyProductionMigrationReceiptSequence,
} from "./production-migration-verifier.mjs";
import { verifyDetachedProductionExact0096BackupSignature } from "./production-exact-0096-backup-signature.mjs";
import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
  validateProductionImmutableRuntimeBinding,
} from "./production-exact-0096-backup-contract.mjs";
import {
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
  PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
} from "./production-migration-pinned-keys.mjs";

export const PRODUCTION_MIGRATION_ADAPTER_ACTIVATION_SCHEMA =
  "site-logbook.production-migration-adapter-activation/v1";
export const PRODUCTION_MIGRATION_ROLE_BINDING_SCHEMA =
  "site-logbook.production-migration-role-binding/v1";
export const PRODUCTION_ROLE_CONTRACT_SCHEMA =
  "site-logbook.production-db-role-separation/v1";
export const PRODUCTION_ROLE_CONTRACT_MIGRATION =
  "0107_canonical_audit_evidence";
export const PRODUCTION_ROLE_CONTRACT_MIGRATION_SHA256 =
  "sha256:c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122";
export const PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION =
  "ENABLE_REVIEWED_0096_TO_0107_PRODUCTION_MIGRATION_ADAPTER";
export const PRODUCTION_MIGRATION_RUNTIME_OBSERVATION_SCHEMA =
  "site-logbook.production-migration-runtime-observation/v1";

const MAX_SQL_BYTES = 2 * 1024 * 1024;
const STORAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PG_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const RUN_ID = /^[0-9a-f]{64}$/;
const JOURNAL_SQL =
  "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id";
const ROLE_SQL =
  "SELECT current_database() AS database_name, current_user AS current_user, session_user AS session_user";

export class ProductionMigrationAdapterError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationAdapterError";
    this.code = code;
  }
}

export function createProductionMigrationLiveIdentityEvidence({
  sourceSha,
  database,
  applicationImageRef,
  postgresImageRef,
  runtimeBindingSha256,
  inventory,
  observedAt,
}) {
  const artifact = createProductionMigrationLiveIdentity({
    sourceSha,
    database,
    applicationImageRef,
    postgresImageRef,
    runtimeBindingSha256,
    inventory,
    observedAt,
  });
  return artifact;
}

export function createProductionMigrationRuntimeObservation({
  runtimeBinding,
  observedAt,
}) {
  const binding = validateProductionImmutableRuntimeBinding(
    runtimeBinding,
    "runtimeObservation.runtimeBinding",
  );
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_MIGRATION_RUNTIME_OBSERVATION_SCHEMA,
    kind: "site-logbook-production-migration-runtime-observation",
    runtimeBinding: binding,
    runtimeBindingSha256: productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(binding),
    ),
    observedAt: new Date(
      exactTimestamp(observedAt, "runtimeObservation.observedAt"),
    ).toISOString(),
    productionTargetsTouched: false,
    authorizesProductionMigration: false,
  });
}

function parseProductionMigrationRuntimeObservation(canonical) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "runtimeObservation",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "runtimeBinding",
      "runtimeBindingSha256",
      "observedAt",
      "productionTargetsTouched",
      "authorizesProductionMigration",
    ],
    "runtimeObservation",
  );
  const binding = validateProductionImmutableRuntimeBinding(
    value.runtimeBinding,
    "runtimeObservation.runtimeBinding",
  );
  const bindingCanonical = canonicalProductionExact0096BackupJson(binding);
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_RUNTIME_OBSERVATION_SCHEMA ||
    value.kind !== "site-logbook-production-migration-runtime-observation" ||
    value.runtimeBindingSha256 !==
      productionExact0096BackupSha256(bindingCanonical) ||
    value.productionTargetsTouched !== false ||
    value.authorizesProductionMigration !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_OBSERVATION_INVALID",
      "Runtime observation is not exact canonical non-authorizing host evidence.",
    );
  }
  const observedAt = exactTimestamp(
    value.observedAt,
    "runtimeObservation.observedAt",
  );
  return Object.freeze({
    artifact,
    value,
    binding,
    bindingCanonical,
    observedAt,
  });
}

export class ProductionMigrationRestoreRequiredError extends ProductionMigrationAdapterError {
  constructor(code, message, options) {
    super(code, message, options);
    this.name = "ProductionMigrationRestoreRequiredError";
    this.restoreRequired = true;
  }
}

export function createProductionMigrationBackupAuthority({
  trustedHostAttestationKeys = PINNED_PRODUCTION_MIGRATION_BACKUP_KEYS,
  expectedHostEvidencePublicKeySha256 = PINNED_PRODUCTION_MIGRATION_BACKUP_KEY_SHA256,
} = {}) {
  return Object.freeze({
    assertInputSignature(input) {
      return verifyDetachedProductionExact0096BackupSignature({
        envelopeCanonical: input.backupSignatureEnvelopeCanonical,
        detachedSignature: input.backupDetachedSignatureB64,
        planCanonical: input.backupPlanCanonical,
        executorTraceCanonical: input.backupExecutorTraceCanonical,
        receiptCanonical: input.backupReceiptCanonical,
        trustedHostAttestationKeys,
        expectedHostEvidencePublicKeySha256,
      });
    },
    assertPlanSignature({ planCanonical }) {
      const plan = parseCanonicalProductionMigrationArtifact(
        planCanonical,
        "plan",
      );
      validateProductionMigrationPlan(plan.value);
      return verifyDetachedProductionExact0096BackupSignature({
        envelopeCanonical: plan.value.backupSignatureEnvelopeCanonical,
        detachedSignature: plan.value.backupDetachedSignatureB64,
        planCanonical: plan.value.backupPlanCanonical,
        executorTraceCanonical: plan.value.backupExecutorTraceCanonical,
        receiptCanonical: plan.value.backupReceiptCanonical,
        trustedHostAttestationKeys,
        expectedHostEvidencePublicKeySha256,
      });
    },
  });
}

export function createVerifiedProductionMigrationPlan(input, backupAuthority) {
  if (
    !backupAuthority ||
    typeof backupAuthority.assertInputSignature !== "function"
  ) {
    fail(
      "PRODUCTION_MIGRATION_BACKUP_AUTHORITY_UNAVAILABLE",
      "Pinned backup signature authority is required before plan creation.",
    );
  }
  backupAuthority.assertInputSignature(input);
  return createProductionMigrationPlan(input);
}

function fail(code, message, options) {
  throw new ProductionMigrationAdapterError(code, message, options);
}

function restoreRequired(code, message, options) {
  throw new ProductionMigrationRestoreRequiredError(code, message, options);
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function binaryCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalLfSql(raw, field) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_SQL_BYTES) {
    fail(
      "PRODUCTION_MIGRATION_SQL_INVALID",
      `${field} is missing or exceeds the reviewed bound.`,
    );
  }
  const canonical = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (
    canonical.length === 0 ||
    canonical.charCodeAt(0) === 0xfeff ||
    canonical.includes("\u0000")
  ) {
    fail(
      "PRODUCTION_MIGRATION_SQL_INVALID",
      `${field} must be non-empty UTF-8-compatible canonical LF SQL.`,
    );
  }
  return canonical;
}

function rowsFromResult(result, field) {
  const rows = Array.isArray(result) ? result : result?.rows;
  if (!Array.isArray(rows)) {
    fail(
      "PRODUCTION_MIGRATION_DB_RESULT_INVALID",
      `${field} did not return a row array.`,
    );
  }
  return rows;
}

function exactPgIdentifier(value, field) {
  const identifier = exactString(value, field, 63);
  if (!PG_IDENTIFIER.test(identifier)) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BINDING_INVALID",
      `${field} must be an exact PostgreSQL identifier.`,
    );
  }
  return identifier;
}

export function createProductionMigrationRoleBinding({
  databaseName,
  sessionUser,
  migrationRole,
  runtimeRole,
}) {
  const normalized = {
    schemaVersion: PRODUCTION_MIGRATION_ROLE_BINDING_SCHEMA,
    roleContractSchema: PRODUCTION_ROLE_CONTRACT_SCHEMA,
    roleContractMigration: PRODUCTION_ROLE_CONTRACT_MIGRATION,
    roleContractMigrationSha256: PRODUCTION_ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: exactPgIdentifier(databaseName, "databaseName"),
    sessionUser: exactPgIdentifier(sessionUser, "sessionUser"),
    migrationRole: exactPgIdentifier(migrationRole, "migrationRole"),
    runtimeRole: exactPgIdentifier(runtimeRole, "runtimeRole"),
    provisioningMode: "external-preexisting-no-bootstrap",
    migrationRoleProvisionedExternally: true,
    bootstrapPerformedByAdapter: false,
    authorizesRoleBootstrap: false,
    authorizesApplicationStart: false,
  };
  if (
    new Set([
      normalized.sessionUser,
      normalized.migrationRole,
      normalized.runtimeRole,
    ]).size !== 3
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BINDING_INVALID",
      "Audited session, migration owner and runtime roles must be distinct.",
    );
  }
  return createProductionMigrationArtifact(normalized);
}

function validateRoleBindingCanonical(roleBindingCanonical) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    roleBindingCanonical,
    "roleBinding",
    64 * 1024,
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "roleContractSchema",
      "roleContractMigration",
      "roleContractMigrationSha256",
      "databaseName",
      "sessionUser",
      "migrationRole",
      "runtimeRole",
      "provisioningMode",
      "migrationRoleProvisionedExternally",
      "bootstrapPerformedByAdapter",
      "authorizesRoleBootstrap",
      "authorizesApplicationStart",
    ],
    "roleBinding",
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_ROLE_BINDING_SCHEMA ||
    value.roleContractSchema !== PRODUCTION_ROLE_CONTRACT_SCHEMA ||
    value.roleContractMigration !== PRODUCTION_ROLE_CONTRACT_MIGRATION ||
    value.roleContractMigrationSha256 !==
      PRODUCTION_ROLE_CONTRACT_MIGRATION_SHA256 ||
    value.provisioningMode !== "external-preexisting-no-bootstrap" ||
    value.migrationRoleProvisionedExternally !== true ||
    value.bootstrapPerformedByAdapter !== false ||
    value.authorizesRoleBootstrap !== false ||
    value.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BINDING_INVALID",
      "Role binding does not preserve the reviewed no-bootstrap boundary.",
    );
  }
  exactPgIdentifier(value.databaseName, "roleBinding.databaseName");
  exactPgIdentifier(value.sessionUser, "roleBinding.sessionUser");
  exactPgIdentifier(value.migrationRole, "roleBinding.migrationRole");
  exactPgIdentifier(value.runtimeRole, "roleBinding.runtimeRole");
  if (
    new Set([value.sessionUser, value.migrationRole, value.runtimeRole])
      .size !== 3
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_BINDING_INVALID",
      "Audited session, migration owner and runtime roles must be distinct.",
    );
  }
  return artifact;
}

export function createProductionMigrationAdapterActivation({
  planCanonical,
  roleBindingCanonical,
  approvedAt,
  operator,
  confirmation,
}) {
  const plan = parseCanonicalProductionMigrationArtifact(planCanonical, "plan");
  validateProductionMigrationPlan(plan.value);
  const roleBinding = validateRoleBindingCanonical(roleBindingCanonical);
  if (
    confirmation !== PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION ||
    plan.value.database.name !== roleBinding.value.databaseName ||
    plan.value.database.sessionUser !== roleBinding.value.sessionUser ||
    plan.value.database.currentUser !== roleBinding.value.migrationRole
  ) {
    fail(
      "PRODUCTION_MIGRATION_ADAPTER_ACTIVATION_INVALID",
      "Activation must bind the reviewed plan to its externally provisioned migration role.",
    );
  }
  const approvedAtMillis = exactTimestamp(approvedAt, "approvedAt");
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_MIGRATION_ADAPTER_ACTIVATION_SCHEMA,
    kind: "site-logbook-production-migration-adapter-activation",
    enabled: true,
    planSha256: plan.sha256,
    roleBindingCanonical: roleBinding.canonical,
    roleBindingSha256: roleBinding.sha256,
    approvedAt: new Date(approvedAtMillis).toISOString(),
    operator: exactString(operator, "operator", 256),
    confirmation,
    executionDefault: "disabled",
    authorizesRoleBootstrap: false,
    authorizesApplicationStart: false,
  });
}

function validateActivation({ activationCanonical, planCanonical }) {
  const plan = parseCanonicalProductionMigrationArtifact(planCanonical, "plan");
  validateProductionMigrationPlan(plan.value);
  const activation = parseCanonicalProductionMigrationArtifact(
    activationCanonical,
    "activation",
    128 * 1024,
  );
  const value = exactObject(
    activation.value,
    [
      "schemaVersion",
      "kind",
      "enabled",
      "planSha256",
      "roleBindingCanonical",
      "roleBindingSha256",
      "approvedAt",
      "operator",
      "confirmation",
      "executionDefault",
      "authorizesRoleBootstrap",
      "authorizesApplicationStart",
    ],
    "activation",
  );
  const roleBinding = validateRoleBindingCanonical(value.roleBindingCanonical);
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_ADAPTER_ACTIVATION_SCHEMA ||
    value.kind !== "site-logbook-production-migration-adapter-activation" ||
    value.enabled !== true ||
    value.planSha256 !== plan.sha256 ||
    value.roleBindingSha256 !== roleBinding.sha256 ||
    value.confirmation !== PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION ||
    value.executionDefault !== "disabled" ||
    value.authorizesRoleBootstrap !== false ||
    value.authorizesApplicationStart !== false ||
    roleBinding.value.databaseName !== plan.value.database.name ||
    roleBinding.value.sessionUser !== plan.value.database.sessionUser ||
    roleBinding.value.migrationRole !== plan.value.database.currentUser
  ) {
    fail(
      "PRODUCTION_MIGRATION_ADAPTER_ACTIVATION_INVALID",
      "Activation is not exact, enabled and bound to this plan and role.",
    );
  }
  exactTimestamp(value.approvedAt, "activation.approvedAt");
  exactString(value.operator, "activation.operator", 256);
  return { activation, plan, roleBinding };
}

export async function loadProductionMigrationCatalog({
  migrationsDirectory,
  readUtf8 = (file) => readFile(file, "utf8"),
}) {
  const journalPath = path.join(migrationsDirectory, "meta", "_journal.json");
  let journal;
  try {
    journal = JSON.parse(await readUtf8(journalPath));
  } catch {
    fail(
      "PRODUCTION_MIGRATION_CATALOG_INVALID",
      "Reviewed migration journal is unavailable or invalid.",
    );
  }
  if (!journal || !Array.isArray(journal.entries)) {
    fail(
      "PRODUCTION_MIGRATION_CATALOG_INVALID",
      "Reviewed migration journal has no exact entries.",
    );
  }
  if (
    journal.entries.length !== 107 ||
    journal.entries.some(
      (entry) =>
        entry?.idx === 100 || /^0100(?:_|$)/.test(String(entry?.tag ?? "")),
    )
  ) {
    fail(
      "PRODUCTION_MIGRATION_0100_PRESENT",
      "Reviewed catalog must contain exactly 107 entries and exclude 0100.",
    );
  }
  const expected = [];
  const sqlByTag = new Map();
  for (const [index, entry] of journal.entries.entries()) {
    if (
      !entry ||
      !Number.isSafeInteger(entry.idx) ||
      !Number.isSafeInteger(entry.when) ||
      typeof entry.tag !== "string" ||
      !/^\d{4}_[A-Za-z0-9_-]+$/.test(entry.tag) ||
      entry.idx !== (index < 100 ? index : index + 1)
    ) {
      fail(
        "PRODUCTION_MIGRATION_CATALOG_INVALID",
        "Reviewed journal indices, timestamps or tags are not exact.",
      );
    }
    let canonicalSql;
    try {
      canonicalSql = canonicalLfSql(
        await readUtf8(path.join(migrationsDirectory, `${entry.tag}.sql`)),
        entry.tag,
      );
    } catch (error) {
      if (error instanceof ProductionMigrationAdapterError) throw error;
      fail(
        "PRODUCTION_MIGRATION_CATALOG_INVALID",
        "A reviewed migration SQL file is unavailable.",
      );
    }
    const hash = sha256Hex(canonicalSql);
    expected.push(
      Object.freeze({
        idx: entry.idx,
        when: entry.when,
        tag: entry.tag,
        hash,
      }),
    );
    if (index >= 97) sqlByTag.set(entry.tag, canonicalSql);
  }
  for (const [index, step] of PRODUCTION_MIGRATION_STEPS.entries()) {
    const identity = expected[97 + index];
    if (
      identity.idx !== step.idx ||
      identity.when !== step.when ||
      identity.tag !== step.tag ||
      `sha256:${identity.hash}` !== step.sqlSha256
    ) {
      fail(
        "PRODUCTION_MIGRATION_CATALOG_INVALID",
        "Reviewed 0097 through 0107 SQL suffix does not match the frozen plan.",
      );
    }
  }
  const baselineRows = expected
    .slice(0, 97)
    .map((entry) => ({
      createdAt: entry.when,
      hash: entry.hash,
    }))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        binaryCompare(left.hash, right.hash),
    );
  const targetRows = expected
    .map((entry) => ({
      createdAt: entry.when,
      hash: entry.hash,
    }))
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        binaryCompare(left.hash, right.hash),
    );
  if (
    productionMigrationSha256(JSON.stringify(baselineRows)) !==
      PRODUCTION_MIGRATION_PREFIX_STATES[0].knownAppliedRowsSha256 ||
    productionMigrationSha256(JSON.stringify(targetRows)) !==
      PRODUCTION_MIGRATION_PREFIX_STATES[10].knownAppliedRowsSha256
  ) {
    fail(
      "PRODUCTION_MIGRATION_CATALOG_INVALID",
      "Reviewed catalog does not reproduce the frozen baseline and target digests.",
    );
  }
  return Object.freeze({
    expected: Object.freeze(expected),
    sqlForStep(step) {
      const sql = sqlByTag.get(step.tag);
      if (!sql || `sha256:${sha256Hex(sql)}` !== step.sqlSha256) {
        fail(
          "PRODUCTION_MIGRATION_SQL_INVALID",
          "Exact canonical-LF SQL is unavailable for the requested step.",
        );
      }
      return sql;
    },
  });
}

export function parseProductionMigrationInventoryRows(rows, catalog) {
  if (!Array.isArray(rows) || rows.length > 2048) {
    fail(
      "PRODUCTION_MIGRATION_INVENTORY_INVALID",
      "Journal inventory is not a bounded row array.",
    );
  }
  const expectedByWhen = new Map(
    catalog.expected.map((entry, index) => [entry.when, { entry, index }]),
  );
  const satisfied = new Map();
  const opaque = [];
  for (const [index, raw] of rows.entries()) {
    const row = exactObject(raw, ["created_at", "hash"], `journal[${index}]`);
    const createdAt = Number(row.created_at);
    const hash = row.hash;
    if (!Number.isSafeInteger(createdAt) || !/^[0-9a-f]{64}$/.test(hash)) {
      fail(
        "PRODUCTION_MIGRATION_INVENTORY_INVALID",
        "Journal rows must use exact safe timestamps and lowercase hashes.",
      );
    }
    const expected = expectedByWhen.get(createdAt);
    if (
      expected &&
      expected.entry.hash === hash &&
      !satisfied.has(expected.index)
    ) {
      satisfied.set(expected.index, { createdAt, hash });
    } else {
      opaque.push({ createdAt, hash });
    }
  }
  const knownRows = [...satisfied.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, row]) => row)
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt ||
        binaryCompare(left.hash, right.hash),
    );
  const missingKnownMigrationTags = catalog.expected
    .filter((_, index) => !satisfied.has(index))
    .map((entry) => entry.tag);
  const latestKnownIndex = Math.max(-1, ...satisfied.keys());
  const opaqueLegacyRows = opaque.sort(
    (left, right) =>
      left.createdAt - right.createdAt || binaryCompare(left.hash, right.hash),
  );
  const inventory = {
    knownAppliedMigrations: knownRows.length,
    knownAppliedRowsSha256: productionMigrationSha256(
      JSON.stringify(knownRows),
    ),
    latestKnownAppliedTag:
      latestKnownIndex < 0 ? null : catalog.expected[latestKnownIndex].tag,
    missingKnownMigrationTags,
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows,
    excludedMigration0100Present: false,
    totalJournalRows: rows.length,
  };
  validateProductionMigrationInventory(inventory);
  return Object.freeze(inventory);
}

async function readRole(client, roleBinding) {
  const rows = rowsFromResult(await client.query(ROLE_SQL), "role identity");
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    row.database_name !== roleBinding.databaseName ||
    row.current_user !== roleBinding.migrationRole ||
    row.session_user !== roleBinding.sessionUser
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_MISMATCH",
      "Connected PostgreSQL identity is not the exact external migration role binding.",
    );
  }
}

async function inventoryInCurrentTransaction(client, catalog) {
  const rows = rowsFromResult(
    await client.query(JOURNAL_SQL),
    "journal inventory",
  );
  return parseProductionMigrationInventoryRows(rows, catalog);
}

async function setLocalMigrationRole(client, roleBinding) {
  // All role names passed here were already constrained to PostgreSQL's
  // unquoted identifier alphabet, but quote the identifier as a second guard.
  await client.query(`SET LOCAL ROLE "${roleBinding.migrationRole}"`);
}

export function createPgProductionMigrationDatabase({
  connect,
  catalog,
  roleBindingCanonical,
  expectedRuntimeBindingCanonical,
  observeLiveRuntime,
  now = () => new Date(),
  createRunId = () => randomBytes(32).toString("hex"),
}) {
  if (
    typeof connect !== "function" ||
    !catalog ||
    typeof expectedRuntimeBindingCanonical !== "string" ||
    typeof observeLiveRuntime !== "function"
  ) {
    fail(
      "PRODUCTION_MIGRATION_ADAPTER_UNAVAILABLE",
      "An injected fixed PostgreSQL connection and reviewed catalog are required.",
    );
  }
  const roleBinding = validateRoleBindingCanonical(roleBindingCanonical).value;
  const expectedRuntimeBinding = validateProductionImmutableRuntimeBinding(
    JSON.parse(expectedRuntimeBindingCanonical),
    "expectedRuntimeBinding",
  );
  const exactExpectedRuntimeBindingCanonical =
    canonicalProductionExact0096BackupJson(expectedRuntimeBinding);
  if (
    expectedRuntimeBindingCanonical !== exactExpectedRuntimeBindingCanonical
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNTIME_BINDING_INVALID",
      "Expected runtime binding must be exact canonical raw host evidence.",
    );
  }
  async function withClient(action) {
    const client = await connect();
    if (!client || typeof client.query !== "function") {
      fail(
        "PRODUCTION_MIGRATION_ADAPTER_UNAVAILABLE",
        "Injected PostgreSQL client is unavailable.",
      );
    }
    return action(client);
  }
  async function observeExactRuntime() {
    const canonical = await observeLiveRuntime();
    if (typeof canonical !== "string") {
      fail(
        "PRODUCTION_MIGRATION_RUNTIME_OBSERVATION_INVALID",
        "Authoritative runtime observer must return canonical evidence bytes.",
      );
    }
    const observation = parseProductionMigrationRuntimeObservation(canonical);
    if (observation.bindingCanonical !== exactExpectedRuntimeBindingCanonical) {
      fail(
        "PRODUCTION_MIGRATION_RUNTIME_DRIFT",
        "Live source, host, image or runtime binding differs from the reviewed target.",
      );
    }
    return observation;
  }
  function liveIdentityForInventory(inventory, observation) {
    return createProductionMigrationLiveIdentityEvidence({
      sourceSha: observation.binding.sourceSha,
      database: {
        name: roleBinding.databaseName,
        sessionUser: roleBinding.sessionUser,
        currentUser: roleBinding.migrationRole,
      },
      applicationImageRef: observation.binding.applicationImageRef,
      postgresImageRef: observation.binding.postgresImageRef,
      runtimeBindingSha256: observation.value.runtimeBindingSha256,
      inventory,
      observedAt: observation.value.observedAt,
    });
  }
  async function readBoundaryReadOnly() {
    return withClient(async (client) => {
      let began = false;
      let discarded = false;
      try {
        await client.query(
          "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        began = true;
        await setLocalMigrationRole(client, roleBinding);
        await readRole(client, roleBinding);
        const observation = await observeExactRuntime();
        const inventory = await inventoryInCurrentTransaction(client, catalog);
        await client.query("COMMIT");
        began = false;
        return Object.freeze({ inventory, observation });
      } catch (error) {
        if (began) {
          try {
            await client.query("ROLLBACK");
          } catch {
            discarded = true;
            client.release?.(true);
            // Preserve the original read-only failure without exposing details.
          }
        }
        throw error;
      } finally {
        if (!discarded) client.release?.();
      }
    });
  }
  async function readInventoryReadOnly() {
    return (await readBoundaryReadOnly()).inventory;
  }
  return Object.freeze({
    readInventoryReadOnly,

    async readLiveIdentityReadOnly() {
      const boundary = await readBoundaryReadOnly();
      return liveIdentityForInventory(boundary.inventory, boundary.observation);
    },

    async assertLiveRuntimeReadOnly() {
      return (await observeExactRuntime()).artifact;
    },

    async applyExactStepTransaction({
      step,
      expectedBeforeStateIndex,
      planSha256,
      intentSha256,
      intentPersistenceReceiptSha256,
    }) {
      const expected = PRODUCTION_MIGRATION_STEPS[expectedBeforeStateIndex];
      if (
        !expected ||
        canonicalProductionMigrationJson(step) !==
          canonicalProductionMigrationJson(expected)
      ) {
        fail(
          "PRODUCTION_MIGRATION_STEP_INVALID",
          "Requested step is not the exact next reviewed migration.",
        );
      }
      const sql = catalog.sqlForStep(step);
      exactDigest(planSha256, "planSha256");
      exactDigest(intentSha256, "intentSha256");
      exactDigest(
        intentPersistenceReceiptSha256,
        "intentPersistenceReceiptSha256",
      );
      const executorRunId = createRunId();
      if (!RUN_ID.test(executorRunId)) {
        fail(
          "PRODUCTION_MIGRATION_RUN_ID_INVALID",
          "Executor run identifier must be exact lowercase random evidence.",
        );
      }
      return withClient(async (client) => {
        let transactionOpen = false;
        let commitStarted = false;
        let commitSucceeded = false;
        let clientReleased = false;
        const releaseClient = (destroy = false) => {
          if (clientReleased) return;
          clientReleased = true;
          client.release?.(destroy);
        };
        const startedAt = now().toISOString();
        try {
          await client.query("BEGIN");
          transactionOpen = true;
          await client.query("SET LOCAL lock_timeout = '15s'");
          await client.query("SET LOCAL statement_timeout = '30min'");
          await client.query(
            "SET LOCAL idle_in_transaction_session_timeout = '35min'",
          );
          await setLocalMigrationRole(client, roleBinding);
          await readRole(client, roleBinding);
          await client.query("SELECT pg_advisory_xact_lock($1::integer)", [
            PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
          ]);
          await observeExactRuntime();
          const before = await inventoryInCurrentTransaction(client, catalog);
          const beforeState = validateProductionMigrationInventory(before);
          if (beforeState.stateIndex !== expectedBeforeStateIndex) {
            fail(
              "PRODUCTION_MIGRATION_PRESTATE_DRIFT",
              "Locked transaction inventory is not the exact expected prefix.",
            );
          }
          await client.query(sql);
          await client.query(
            "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1::text, $2::bigint)",
            [step.sqlSha256.slice("sha256:".length), step.when],
          );
          const after = await inventoryInCurrentTransaction(client, catalog);
          await observeExactRuntime();
          const afterState = validateProductionMigrationInventory(after);
          if (afterState.stateIndex !== expectedBeforeStateIndex + 1) {
            fail(
              "PRODUCTION_MIGRATION_POSTSTATE_DRIFT",
              "Locked transaction inventory is not the exact next prefix.",
            );
          }
          commitStarted = true;
          await client.query("COMMIT");
          commitSucceeded = true;
          transactionOpen = false;
          const completedAt = now().toISOString();
          const committedBoundary = await readBoundaryReadOnly();
          const committedInventory = committedBoundary.inventory;
          const committedState =
            validateProductionMigrationInventory(committedInventory);
          if (
            committedState.stateIndex !== expectedBeforeStateIndex + 1 ||
            canonicalProductionMigrationJson(committedInventory) !==
              canonicalProductionMigrationJson(after)
          ) {
            restoreRequired(
              "RESTORE_REQUIRED_POST_COMMIT_INVENTORY_DRIFT",
              "Committed live inventory does not equal the exact in-transaction after state.",
            );
          }
          const liveIdentity = liveIdentityForInventory(
            committedInventory,
            committedBoundary.observation,
          );
          const evidence = createProductionMigrationArtifact({
            schemaVersion: PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
            kind: "site-logbook-production-migration-transaction-evidence",
            executorRunId,
            planSha256,
            intentSha256,
            intentPersistenceReceiptSha256,
            migration: step,
            before,
            after,
            liveIdentityCanonical: liveIdentity.canonical,
            liveIdentitySha256: liveIdentity.sha256,
            advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
            transactionCommitted: true,
            transactionStartedAt: startedAt,
            transactionCompletedAt: completedAt,
            authorizesApplicationStart: false,
          });
          releaseClient();
          return evidence;
        } catch (error) {
          if (commitStarted && !commitSucceeded) {
            releaseClient(true);
            restoreRequired(
              "RESTORE_REQUIRED_COMMIT_OUTCOME_UNKNOWN",
              "PostgreSQL commit outcome is ambiguous; do not retry.",
              { cause: error },
            );
          }
          if (commitSucceeded) {
            releaseClient();
            if (error?.restoreRequired) throw error;
            restoreRequired(
              "RESTORE_REQUIRED_POST_COMMIT_EVIDENCE_INVALID",
              "Committed transaction could not produce exact evidence; do not retry.",
              { cause: error },
            );
          }
          if (transactionOpen) {
            try {
              await client.query("ROLLBACK");
              transactionOpen = false;
            } catch (rollbackError) {
              releaseClient(true);
              restoreRequired(
                "RESTORE_REQUIRED_ROLLBACK_OUTCOME_UNKNOWN",
                "Pre-commit rollback outcome is ambiguous; do not retry.",
                { cause: rollbackError },
              );
            }
          }
          throw error;
        } finally {
          if (!commitStarted) releaseClient();
        }
      });
    },
  });
}

function safeStorageId(storageId) {
  if (!STORAGE_ID.test(String(storageId))) {
    fail(
      "PRODUCTION_MIGRATION_STORAGE_INVALID",
      "Artifact storage identifier is invalid.",
    );
  }
  return storageId;
}

export function createNodeExclusiveArtifactStore({ directory }) {
  if (
    process.platform !== "linux" ||
    typeof fsConstants.O_NOFOLLOW !== "number" ||
    typeof fsConstants.O_DIRECTORY !== "number"
  ) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_STORE_UNAVAILABLE",
      "Default durable storage requires descriptor-relative Linux no-follow primitives; inject a separately reviewed platform adapter elsewhere.",
    );
  }
  const base = path.resolve(directory);
  let pinnedDirectoryIdentity = null;
  async function openPinnedDirectory() {
    let handle;
    try {
      handle = await open(
        base,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
      );
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isDirectory()) {
        fail(
          "PRODUCTION_MIGRATION_STORAGE_INVALID",
          "Artifact root must be one real directory.",
        );
      }
      const identity = `${metadata.dev}:${metadata.ino}`;
      if (pinnedDirectoryIdentity === null) pinnedDirectoryIdentity = identity;
      if (identity !== pinnedDirectoryIdentity) {
        fail(
          "PRODUCTION_MIGRATION_STORAGE_IDENTITY_DRIFT",
          "Artifact root identity changed after custody was pinned.",
        );
      }
      return handle;
    } catch (error) {
      await handle?.close();
      if (error instanceof ProductionMigrationAdapterError) throw error;
      fail(
        "PRODUCTION_MIGRATION_ARTIFACT_STORE_UNAVAILABLE",
        "Descriptor-relative artifact root could not be opened safely.",
        { cause: error },
      );
    }
  }
  function descriptorRelativeTarget(directoryHandle, id) {
    return `/proc/self/fd/${directoryHandle.fd}/${id}`;
  }
  return Object.freeze({
    async persistExclusive(storageId, canonical) {
      const id = safeStorageId(storageId);
      if (
        typeof canonical !== "string" ||
        Buffer.byteLength(canonical) > 512 * 1024
      ) {
        fail(
          "PRODUCTION_MIGRATION_ARTIFACT_PERSIST_FAILED",
          "Canonical artifact bytes are missing or exceed the durable bound.",
        );
      }
      const directoryHandle = await openPinnedDirectory();
      const target = descriptorRelativeTarget(directoryHandle, id);
      let handle;
      try {
        handle = await open(
          target,
          fsConstants.O_CREAT |
            fsConstants.O_EXCL |
            fsConstants.O_RDWR |
            fsConstants.O_NOFOLLOW,
          0o600,
        );
        await handle.writeFile(canonical, "utf8");
        await handle.sync();
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.nlink !== 1) {
          fail(
            "PRODUCTION_MIGRATION_STORAGE_INVALID",
            "Stored artifact must be one regular single-link file.",
          );
        }
        const bytes = Buffer.alloc(metadata.size);
        const readback = await handle.read(bytes, 0, bytes.length, 0);
        if (
          readback.bytesRead !== bytes.length ||
          bytes.toString("utf8") !== canonical
        ) {
          fail(
            "PRODUCTION_MIGRATION_ARTIFACT_READBACK_MISMATCH",
            "Descriptor-held durable artifact read-back differs from canonical bytes.",
          );
        }
        await directoryHandle.sync();
      } catch (error) {
        if (error instanceof ProductionMigrationAdapterError) throw error;
        fail(
          error?.code === "EEXIST"
            ? "PRODUCTION_MIGRATION_ARTIFACT_EXISTS"
            : "PRODUCTION_MIGRATION_ARTIFACT_PERSIST_FAILED",
          "Exclusive durable artifact persistence failed; preserve existing state for review.",
          { cause: error },
        );
      } finally {
        await handle?.close();
        await directoryHandle.close();
      }
      return Object.freeze({ storageId: id });
    },
    async readCanonical(storageId) {
      const id = safeStorageId(storageId);
      const directoryHandle = await openPinnedDirectory();
      const target = descriptorRelativeTarget(directoryHandle, id);
      let handle;
      try {
        handle = await open(
          target,
          fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
        );
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.nlink !== 1 ||
          metadata.size > 512 * 1024
        ) {
          fail(
            "PRODUCTION_MIGRATION_STORAGE_INVALID",
            "Stored artifact must be one bounded regular non-link file.",
          );
        }
        return handle.readFile("utf8");
      } catch (error) {
        if (error instanceof ProductionMigrationAdapterError) throw error;
        fail(
          "PRODUCTION_MIGRATION_ARTIFACT_READ_FAILED",
          "Descriptor-relative artifact read failed closed.",
          { cause: error },
        );
      } finally {
        await handle?.close();
        await directoryHandle.close();
      }
    },
  });
}

function requiredAdapterDependencies(
  database,
  artifacts,
  roleAuthority,
  backupAuthority,
) {
  if (
    !database ||
    typeof database.readInventoryReadOnly !== "function" ||
    typeof database.readLiveIdentityReadOnly !== "function" ||
    typeof database.assertLiveRuntimeReadOnly !== "function" ||
    typeof database.applyExactStepTransaction !== "function" ||
    !artifacts ||
    typeof artifacts.persistExclusive !== "function" ||
    typeof artifacts.readCanonical !== "function" ||
    !roleAuthority ||
    typeof roleAuthority.assertPrecondition !== "function" ||
    !backupAuthority ||
    typeof backupAuthority.assertPlanSignature !== "function"
  ) {
    fail(
      "PRODUCTION_MIGRATION_ADAPTER_UNAVAILABLE",
      "Production adapter dependencies are unavailable; execution remains disabled.",
    );
  }
}

async function persistAndReadback(artifacts, storageId, canonical) {
  await artifacts.persistExclusive(storageId, canonical);
  const readback = await artifacts.readCanonical(storageId);
  if (readback !== canonical) {
    fail(
      "PRODUCTION_MIGRATION_ARTIFACT_READBACK_MISMATCH",
      "Durable artifact read-back differs from canonical bytes.",
    );
  }
  return storageId;
}

export function createProductionMigrationAdapter({
  database = null,
  artifacts = null,
  roleAuthority = null,
  backupAuthority = null,
  now = () => new Date(),
} = {}) {
  async function loadDurableRun({
    planStorageId,
    intentStorageId,
    intentPersistenceReceiptStorageId,
  }) {
    requiredAdapterDependencies(
      database,
      artifacts,
      roleAuthority,
      backupAuthority,
    );
    const planCanonical = await artifacts.readCanonical(planStorageId);
    const intentCanonical = await artifacts.readCanonical(intentStorageId);
    const intentPersistenceReceiptCanonical = await artifacts.readCanonical(
      intentPersistenceReceiptStorageId,
    );
    const plan = parseCanonicalProductionMigrationArtifact(
      planCanonical,
      "plan",
    );
    validateProductionMigrationPlan(plan.value);
    await backupAuthority.assertPlanSignature({ planCanonical });
    await roleAuthority.assertPrecondition({ planCanonical });
    validateProductionMigrationIntent(
      intentCanonical === undefined
        ? null
        : parseCanonicalProductionMigrationArtifact(intentCanonical, "intent")
            .value,
      planCanonical,
    );
    validateProductionMigrationIntentPersistenceReceipt(
      intentPersistenceReceiptCanonical,
      planCanonical,
      intentCanonical,
    );
    return Object.freeze({
      planStorageId,
      intentStorageId,
      intentPersistenceReceiptStorageId,
      planCanonical,
      intentCanonical,
      intentPersistenceReceiptCanonical,
    });
  }

  return Object.freeze({
    async prepareDurableRun({
      activationCanonical,
      planCanonical,
      intentCanonical,
    }) {
      requiredAdapterDependencies(
        database,
        artifacts,
        roleAuthority,
        backupAuthority,
      );
      const binding = validateActivation({
        activationCanonical,
        planCanonical,
      });
      await backupAuthority.assertPlanSignature({ planCanonical });
      await roleAuthority.assertPrecondition({ planCanonical });
      const intent = parseCanonicalProductionMigrationArtifact(
        intentCanonical,
        "intent",
      );
      validateProductionMigrationIntent(intent.value, planCanonical);
      const planStorageId = `plan-${binding.plan.sha256.slice(7)}.json`;
      const intentStorageId = `intent-${intent.value.intentId}.json`;
      await persistAndReadback(artifacts, planStorageId, planCanonical);
      await persistAndReadback(artifacts, intentStorageId, intentCanonical);
      const persistedCanonical = await artifacts.readCanonical(intentStorageId);
      const persistenceReceipt =
        createProductionMigrationIntentPersistenceReceipt({
          planCanonical,
          intentCanonical,
          persistedCanonical,
          persistedAt: now().toISOString(),
          storageId: intentStorageId,
        });
      const intentPersistenceReceiptStorageId = `intent-persistence-${intent.value.intentId}.json`;
      await persistAndReadback(
        artifacts,
        intentPersistenceReceiptStorageId,
        persistenceReceipt.canonical,
      );
      return loadDurableRun({
        planStorageId,
        intentStorageId,
        intentPersistenceReceiptStorageId,
      });
    },

    loadDurableRun,

    async executeNext({
      activationCanonical,
      durableRun,
      receiptStorageIds,
      resumeCommandCanonical,
    }) {
      requiredAdapterDependencies(
        database,
        artifacts,
        roleAuthority,
        backupAuthority,
      );
      const durable = await loadDurableRun(durableRun);
      validateActivation({
        activationCanonical,
        planCanonical: durable.planCanonical,
      });
      if (!Array.isArray(receiptStorageIds) || receiptStorageIds.length > 10) {
        fail(
          "PRODUCTION_MIGRATION_RECEIPT_INVALID",
          "Receipt storage sequence must contain at most ten entries.",
        );
      }
      const receiptCanonicals = [];
      for (const id of receiptStorageIds) {
        receiptCanonicals.push(await artifacts.readCanonical(id));
      }
      verifyProductionMigrationReceiptSequence({
        planCanonical: durable.planCanonical,
        intentCanonical: durable.intentCanonical,
        intentPersistenceReceiptCanonical:
          durable.intentPersistenceReceiptCanonical,
        receiptCanonicals,
      });
      const liveIdentity = await database.readLiveIdentityReadOnly();
      const recovery = classifyProductionMigrationRecovery({
        planCanonical: durable.planCanonical,
        intentCanonical: durable.intentCanonical,
        intentPersistenceReceiptCanonical:
          durable.intentPersistenceReceiptCanonical,
        receiptCanonicals,
        liveIdentityCanonical: liveIdentity.canonical,
        requestedAction: "resume",
        resumeCommandCanonical,
      });
      if (!recovery.value.resumeAllowed || !recovery.value.nextStep) {
        restoreRequired(
          recovery.value.decision.startsWith("RESTORE_REQUIRED")
            ? recovery.value.decision
            : "RESTORE_REQUIRED_NOT_EXPLICITLY_RESUMABLE",
          "Read-only recovery classification does not authorize the next exact step.",
        );
      }
      let transactionEvidence;
      try {
        transactionEvidence = await database.applyExactStepTransaction({
          step: recovery.value.nextStep,
          expectedBeforeStateIndex: receiptCanonicals.length,
          planSha256:
            recovery.value.planSha256 ??
            parseCanonicalProductionMigrationArtifact(
              durable.planCanonical,
              "plan",
            ).sha256,
          intentSha256: recovery.value.intentSha256,
          intentPersistenceReceiptSha256:
            parseCanonicalProductionMigrationArtifact(
              durable.intentPersistenceReceiptCanonical,
              "intentPersistenceReceipt",
            ).sha256,
        });
      } catch (error) {
        if (error?.restoreRequired) throw error;
        throw error;
      }
      let receipt;
      try {
        receipt = createProductionMigrationStepReceipt({
          planCanonical: durable.planCanonical,
          intentCanonical: durable.intentCanonical,
          intentPersistenceReceiptCanonical:
            durable.intentPersistenceReceiptCanonical,
          priorReceiptCanonicals: receiptCanonicals,
          transactionEvidenceCanonical: transactionEvidence.canonical,
        });
      } catch (error) {
        restoreRequired(
          "RESTORE_REQUIRED_POST_COMMIT_EVIDENCE_INVALID",
          "Committed step could not produce exact receipt evidence.",
          { cause: error },
        );
      }
      const receiptStorageId = `receipt-${String(receiptCanonicals.length + 1).padStart(2, "0")}-${recovery.value.nextStep.tag}.json`;
      try {
        await persistAndReadback(
          artifacts,
          receiptStorageId,
          receipt.canonical,
        );
      } catch (error) {
        restoreRequired(
          "RESTORE_REQUIRED_UNKNOWN_COMMIT",
          "Database commit succeeded but its exclusive receipt is not durably confirmed.",
          { cause: error },
        );
      }
      return Object.freeze({
        decision: "STEP_COMMITTED_RECEIPT_DURABLE",
        receiptStorageId,
        receiptCanonical: receipt.canonical,
        receiptSha256: receipt.sha256,
        authorizesApplicationStart: false,
      });
    },

    async finalize({ activationCanonical, durableRun, receiptStorageIds }) {
      requiredAdapterDependencies(
        database,
        artifacts,
        roleAuthority,
        backupAuthority,
      );
      const durable = await loadDurableRun(durableRun);
      validateActivation({
        activationCanonical,
        planCanonical: durable.planCanonical,
      });
      if (
        typeof roleAuthority.readPostCommitEvidence !== "function" ||
        typeof roleAuthority.assertPostCommit !== "function"
      ) {
        fail(
          "PRODUCTION_MIGRATION_ROLE_POST_COMMIT_UNAVAILABLE",
          "Authoritative post-commit role evidence is unavailable.",
        );
      }
      const receiptCanonicals = [];
      for (const id of receiptStorageIds) {
        receiptCanonicals.push(await artifacts.readCanonical(id));
      }
      const finalLiveIdentity = await database.readLiveIdentityReadOnly();
      const {
        roleTransactionReceiptCanonical,
        postCommitRoleArtifactCanonical,
      } = await roleAuthority.readPostCommitEvidence();
      await roleAuthority.assertPostCommit({
        planCanonical: durable.planCanonical,
        roleTransactionReceiptCanonical,
        postCommitRoleArtifactCanonical,
      });
      await database.assertLiveRuntimeReadOnly();
      const chain = createProductionMigrationTransitionChain({
        planCanonical: durable.planCanonical,
        intentCanonical: durable.intentCanonical,
        intentPersistenceReceiptCanonical:
          durable.intentPersistenceReceiptCanonical,
        receiptCanonicals,
        finalInventory: finalLiveIdentity.value.inventory,
        finalLiveIdentityCanonical: finalLiveIdentity.canonical,
        roleTransactionReceiptCanonical,
        postCommitRoleArtifactCanonical,
        completedAt: now().toISOString(),
      });
      const storageId = `transition-chain-${chain.sha256.slice(7)}.json`;
      await persistAndReadback(artifacts, storageId, chain.canonical);
      return Object.freeze({
        storageId,
        canonical: chain.canonical,
        sha256: chain.sha256,
        authorizesApplicationStart: false,
      });
    },
  });
}

export function exactProductionOpaqueRowsForAdapterTests() {
  return PRODUCTION_OPAQUE_LEGACY_ROWS.map((row) => ({ ...row }));
}

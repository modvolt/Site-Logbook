import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  ProductionMigrationRestoreRequiredError,
  createNodeExclusiveArtifactStore,
  createPgProductionMigrationDatabase,
  createProductionMigrationAdapter,
  createProductionMigrationAdapterActivation,
  createProductionMigrationBackupAuthority,
  createProductionMigrationRoleBinding,
  createProductionMigrationRuntimeObservation,
  exactProductionOpaqueRowsForAdapterTests,
  loadProductionMigrationCatalog,
  parseProductionMigrationInventoryRows,
} from "../production-evidence/production-migration-adapter.mjs";
import { canonicalProductionExact0096BackupJson } from "../production-evidence/production-exact-0096-backup-contract.mjs";
import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_MIGRATION_STEPS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
  frozenStateSummary,
} from "../production-evidence/production-migration-contract.mjs";
import {
  createProductionMigrationIntent,
  createProductionMigrationIntentPersistenceReceipt,
  createProductionMigrationPlan,
} from "../production-evidence/production-migration-planner.mjs";
import { createProductionMigrationResumeCommand } from "../production-evidence/production-migration-verifier.mjs";
import { productionExact0096BackupSignaturePayload } from "../production-evidence/production-exact-0096-backup-signature.mjs";
import {
  fixtureIntentInput,
  fixtureInventory,
  fixturePlanInput,
} from "./production-migration-control-plane-fixtures.mjs";

const MIGRATIONS_DIRECTORY = path.resolve("lib/db/migrations");
const DATABASE_NAME = "site_logbook";
const SESSION_USER = "site_logbook_executor";
const MIGRATION_ROLE = "site_logbook_migrator";
const RUNTIME_ROLE = "site_logbook_runtime";
const DEFAULT_RUNTIME_BINDING = Object.freeze(
  JSON.parse(fixturePlanInput().backupPlanCanonical).runtimeBinding,
);

let catalog;
let roleBinding;

test.before(async () => {
  catalog = await loadProductionMigrationCatalog({
    migrationsDirectory: MIGRATIONS_DIRECTORY,
  });
  roleBinding = createProductionMigrationRoleBinding({
    databaseName: DATABASE_NAME,
    sessionUser: SESSION_USER,
    migrationRole: MIGRATION_ROLE,
    runtimeRole: RUNTIME_ROLE,
  });
});

function journalRows(stateIndex) {
  return [
    ...catalog.expected.slice(0, 97 + stateIndex).map((row) => ({
      created_at: row.when,
      hash: row.hash,
    })),
    ...exactProductionOpaqueRowsForAdapterTests().map((row) => ({
      created_at: row.createdAt,
      hash: row.hash,
    })),
  ].sort(
    (left, right) =>
      Number(left.created_at) - Number(right.created_at) ||
      (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0),
  );
}

function fakePg({
  stateIndex = 0,
  failSql = false,
  failCommit = false,
  failRollback = false,
  role = MIGRATION_ROLE,
  sessionUser = SESSION_USER,
  databaseName = DATABASE_NAME,
} = {}) {
  const state = {
    durableStateIndex: stateIndex,
    transactionStateIndex: null,
    statements: [],
    released: [],
  };
  const client = {
    async query(query, params) {
      const sql = typeof query === "string" ? query : query.text;
      state.statements.push({ sql, params });
      if (sql.startsWith("BEGIN")) {
        state.transactionStateIndex = state.durableStateIndex;
        return { rows: [] };
      }
      if (sql === "ROLLBACK") {
        if (failRollback) throw new Error("rollback transport lost");
        state.transactionStateIndex = null;
        return { rows: [] };
      }
      if (sql === "COMMIT") {
        if (failCommit) throw new Error("commit transport lost");
        state.durableStateIndex = state.transactionStateIndex;
        state.transactionStateIndex = null;
        return { rows: [] };
      }
      if (sql.startsWith("SELECT current_database()")) {
        return {
          rows: [
            {
              database_name: databaseName,
              current_user: role,
              session_user: sessionUser,
            },
          ],
        };
      }
      if (sql.startsWith("SELECT created_at")) {
        const index = state.transactionStateIndex ?? state.durableStateIndex;
        return { rows: journalRows(index) };
      }
      if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
        assert.deepEqual(params, [PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY]);
        return { rows: [{ pg_advisory_xact_lock: "" }] };
      }
      if (sql.startsWith("INSERT INTO drizzle.__drizzle_migrations")) {
        state.transactionStateIndex += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("SET LOCAL")) return { rows: [] };
      if (failSql) throw new Error("migration statement failed");
      return { rows: [] };
    },
    release(destroy) {
      state.released.push(destroy === true ? "destroy" : "release");
    },
  };
  return {
    state,
    connect: async () => client,
  };
}

function deterministicClock(start = "2026-08-12T10:01:00.000Z") {
  let value = Date.parse(start);
  return () => new Date(value++);
}

function databaseFor(
  pg,
  now = deterministicClock(),
  binding = roleBinding,
  runtimeBinding = DEFAULT_RUNTIME_BINDING,
  observeLiveRuntime = async () =>
    createProductionMigrationRuntimeObservation({
      runtimeBinding,
      observedAt: now().toISOString(),
    }).canonical,
) {
  return createPgProductionMigrationDatabase({
    connect: pg.connect,
    catalog,
    roleBindingCanonical: binding.canonical,
    expectedRuntimeBindingCanonical:
      canonicalProductionExact0096BackupJson(runtimeBinding),
    observeLiveRuntime,
    now,
    createRunId: () => "a".repeat(64),
  });
}

function memoryArtifactStore() {
  const values = new Map();
  return {
    values,
    async persistExclusive(storageId, canonical) {
      if (values.has(storageId)) {
        const error = new Error("exclusive artifact exists");
        error.code = "PRODUCTION_MIGRATION_ARTIFACT_EXISTS";
        throw error;
      }
      values.set(storageId, canonical);
      return { storageId };
    },
    async readCanonical(storageId) {
      if (!values.has(storageId)) throw new Error("artifact missing");
      return values.get(storageId);
    },
  };
}

function fixtureActivatedRun() {
  const input = fixturePlanInput();
  const plan = createProductionMigrationPlan(input);
  const intent = createProductionMigrationIntent(
    fixtureIntentInput(plan.canonical),
  );
  const precondition = JSON.parse(input.rolePreconditionCanonical);
  const fixtureRoleBinding = createProductionMigrationRoleBinding({
    databaseName: input.database.name,
    sessionUser: input.database.sessionUser,
    migrationRole: input.database.currentUser,
    runtimeRole: precondition.runtimeRole,
  });
  const runtimeBinding = JSON.parse(input.backupPlanCanonical).runtimeBinding;
  const activation = createProductionMigrationAdapterActivation({
    planCanonical: plan.canonical,
    roleBindingCanonical: fixtureRoleBinding.canonical,
    approvedAt: "2026-08-12T10:00:10.000Z",
    operator: "production-owner",
    confirmation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  });
  return {
    plan,
    intent,
    activation,
    fixtureRoleBinding,
    runtimeBinding,
    input,
  };
}

const MOCK_ROLE_AUTHORITY = Object.freeze({
  assertPrecondition() {},
});
const MOCK_BACKUP_AUTHORITY = Object.freeze({
  assertPlanSignature() {},
});

function postCommitRoleEvidence(plan) {
  const role = JSON.parse(plan.value.rolePreconditionCanonical);
  const projection = JSON.parse(role.preProjectionCanonical);
  const projectionSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(projection))
    .digest("hex");
  const receiptBody = {
    schemaVersion: "site-logbook.production-db-role-separation-receipt/v1",
    planSha256: role.rolePlanSha256,
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    executorId: "independent-role-executor",
    approvalId: "role-separation-approval",
    executedAt: "2026-08-12T11:11:10.000Z",
    statementCount: 1,
    postProjectionSha256: projectionSha256,
    postValidation: "passed",
    authorizesDeployment: false,
    postCommitVerification: "unavailable",
    postCommitVerifierArtifact: null,
  };
  const receipt = createProductionMigrationArtifact({
    ...receiptBody,
    receiptSha256: createHash("sha256")
      .update(canonicalProductionMigrationJson(receiptBody))
      .digest("hex"),
  });
  const postCommit = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-db-role-separation-postcommit/v1",
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: role.rolePlanSha256,
    transactionReceiptSha256: receipt.value.receiptSha256,
    projection,
    projectionSha256,
    verifierId: "independent-role-verifier",
    observedAt: "2026-08-12T11:11:30.000Z",
    authorizesDeployment: false,
  });
  return { receipt, postCommit };
}

test("catalog freezes 0096 through 0107 while accepting later journal suffixes", async () => {
  assert.equal(catalog.expected.length, 107);
  const activeJournal = JSON.parse(
    await readFile(
      path.join(MIGRATIONS_DIRECTORY, "meta", "_journal.json"),
      "utf8",
    ),
  );
  assert.ok(activeJournal.entries.length > catalog.expected.length);
  assert.equal(catalog.expected.at(-1)?.tag, "0107_canonical_audit_evidence");
  assert.equal(
    activeJournal.entries.at(-1)?.tag,
    "0108_invoice_source_allocations_and_advances",
  );
  assert.equal(
    catalog.expected.some((entry) => entry.idx === 100),
    false,
  );
  assert.deepEqual(
    catalog.expected.slice(97).map((entry) => ({
      idx: entry.idx,
      when: entry.when,
      tag: entry.tag,
      sqlSha256: `sha256:${entry.hash}`,
    })),
    PRODUCTION_MIGRATION_STEPS.map((step) => ({
      idx: step.idx,
      when: step.when,
      tag: step.tag,
      sqlSha256: step.sqlSha256,
    })),
  );
  for (const step of PRODUCTION_MIGRATION_STEPS) {
    const sql = catalog.sqlForStep(step);
    assert.equal(sql.includes("\r"), false);
  }

  const alteredJournal = JSON.stringify({
    entries: [
      ...catalog.expected.slice(0, 100).map((entry) => ({
        ...entry,
        breakpoints: true,
        version: "7",
      })),
      {
        idx: 100,
        when: 1_786_383_362_500,
        tag: "0100_forbidden",
        breakpoints: true,
        version: "7",
      },
      ...catalog.expected.slice(100).map((entry) => ({
        ...entry,
        breakpoints: true,
        version: "7",
      })),
    ],
  });
  await assert.rejects(
    loadProductionMigrationCatalog({
      migrationsDirectory: MIGRATIONS_DIRECTORY,
      readUtf8: async (file) =>
        file.endsWith("_journal.json")
          ? alteredJournal
          : readFile(file, "utf8"),
    }),
    { code: "PRODUCTION_MIGRATION_0100_PRESENT" },
  );
});

test("canonical inventory parser accepts only exact reviewed prefix and opaque identities", () => {
  for (let index = 0; index <= 10; index += 1) {
    const inventory = parseProductionMigrationInventoryRows(
      journalRows(index),
      catalog,
    );
    assert.deepEqual(
      frozenStateSummary(PRODUCTION_MIGRATION_PREFIX_STATES[index]),
      {
        knownAppliedMigrations: inventory.knownAppliedMigrations,
        knownAppliedRowsSha256: inventory.knownAppliedRowsSha256,
        latestKnownAppliedTag: inventory.latestKnownAppliedTag,
        opaqueLegacyRowCount: inventory.opaqueLegacyRows.length,
        opaqueLegacyRowsSha256:
          "sha256:d050765f2a0299a0c396bfa3687485aa63d05ce02c3e88ed66c2f280f3db6201",
        totalJournalRows: inventory.totalJournalRows,
        excludedMigration0100Present: inventory.excludedMigration0100Present,
      },
    );
  }
  const drift = journalRows(0);
  drift[0] = { ...drift[0], hash: "f".repeat(64) };
  assert.throws(
    () => parseProductionMigrationInventoryRows(drift, catalog),
    /PRODUCTION_MIGRATION_OPAQUE_DRIFT|PRODUCTION_MIGRATION_NON_PREFIX/,
  );
});

test("default database adapter is unavailable without injected fixed connection", () => {
  assert.throws(
    () =>
      createPgProductionMigrationDatabase({
        connect: null,
        catalog,
        roleBindingCanonical: roleBinding.canonical,
        expectedRuntimeBindingCanonical: canonicalProductionExact0096BackupJson(
          DEFAULT_RUNTIME_BINDING,
        ),
        observeLiveRuntime: null,
      }),
    { code: "PRODUCTION_MIGRATION_ADAPTER_UNAVAILABLE" },
  );
});

test("read-only inventory uses repeatable-read transaction and never obtains write lock", async () => {
  const pg = fakePg();
  const inventory = await databaseFor(pg).readInventoryReadOnly();
  assert.equal(inventory.knownAppliedMigrations, 97);
  assert.deepEqual(
    pg.state.statements.map((entry) => entry.sql),
    [
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      'SET LOCAL ROLE "site_logbook_migrator"',
      "SELECT current_database() AS database_name, current_user AS current_user, session_user AS session_user",
      "SELECT created_at, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id",
      "COMMIT",
    ],
  );
});

test("role mismatch fails before advisory lock or SQL", async () => {
  const pg = fakePg({ role: RUNTIME_ROLE });
  await assert.rejects(databaseFor(pg).readInventoryReadOnly(), {
    code: "PRODUCTION_MIGRATION_ROLE_MISMATCH",
  });
  assert.equal(
    pg.state.statements.some((entry) => entry.sql.includes("pg_advisory")),
    false,
  );
});

test("ten steps apply exact SQL in one advisory-locked transaction each", async () => {
  const pg = fakePg();
  const database = databaseFor(pg);
  for (const [index, step] of PRODUCTION_MIGRATION_STEPS.entries()) {
    const evidence = await database.applyExactStepTransaction({
      step,
      expectedBeforeStateIndex: index,
      planSha256: `sha256:${"b".repeat(64)}`,
      intentSha256: `sha256:${"c".repeat(64)}`,
      intentPersistenceReceiptSha256: `sha256:${"d".repeat(64)}`,
    });
    assert.equal(evidence.value.before.knownAppliedMigrations, 97 + index);
    assert.equal(evidence.value.after.knownAppliedMigrations, 98 + index);
    assert.equal(evidence.value.transactionCommitted, true);
    assert.match(evidence.value.liveIdentitySha256, /^sha256:[0-9a-f]{64}$/);
    assert.equal(
      JSON.parse(evidence.value.liveIdentityCanonical).database.sessionUser,
      SESSION_USER,
    );
    assert.equal(evidence.value.authorizesApplicationStart, false);
  }
  assert.equal(pg.state.durableStateIndex, 10);
  assert.equal(
    pg.state.statements.filter((entry) =>
      entry.sql.startsWith("SELECT pg_advisory_xact_lock"),
    ).length,
    10,
  );
  assert.equal(
    pg.state.statements.filter((entry) => entry.sql === "COMMIT").length,
    20,
  );
  assert.equal(
    pg.state.statements.filter((entry) =>
      entry.sql.startsWith(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      ),
    ).length,
    10,
  );
});

test("pre-state drift performs no migration SQL and rolls back", async () => {
  const pg = fakePg({ stateIndex: 1 });
  await assert.rejects(
    databaseFor(pg).applyExactStepTransaction({
      step: PRODUCTION_MIGRATION_STEPS[0],
      expectedBeforeStateIndex: 0,
      planSha256: `sha256:${"b".repeat(64)}`,
      intentSha256: `sha256:${"c".repeat(64)}`,
      intentPersistenceReceiptSha256: `sha256:${"d".repeat(64)}`,
    }),
    { code: "PRODUCTION_MIGRATION_PRESTATE_DRIFT" },
  );
  assert.equal(pg.state.durableStateIndex, 1);
  assert.equal(
    pg.state.statements.some((entry) =>
      entry.sql.startsWith("INSERT INTO drizzle.__drizzle_migrations"),
    ),
    false,
  );
  assert.equal(pg.state.statements.at(-1).sql, "ROLLBACK");
});

test("migration failure rolls back before commit and leaves durable prefix unchanged", async () => {
  const pg = fakePg({ failSql: true });
  await assert.rejects(
    databaseFor(pg).applyExactStepTransaction({
      step: PRODUCTION_MIGRATION_STEPS[0],
      expectedBeforeStateIndex: 0,
      planSha256: `sha256:${"b".repeat(64)}`,
      intentSha256: `sha256:${"c".repeat(64)}`,
      intentPersistenceReceiptSha256: `sha256:${"d".repeat(64)}`,
    }),
    /migration statement failed/,
  );
  assert.equal(pg.state.durableStateIndex, 0);
  assert.equal(pg.state.statements.at(-1).sql, "ROLLBACK");
  assert.equal(
    pg.state.statements.some((entry) => entry.sql === "COMMIT"),
    false,
  );
});

test("ambiguous commit never rolls back and requires restore", async () => {
  const pg = fakePg({ failCommit: true });
  await assert.rejects(
    databaseFor(pg).applyExactStepTransaction({
      step: PRODUCTION_MIGRATION_STEPS[0],
      expectedBeforeStateIndex: 0,
      planSha256: `sha256:${"b".repeat(64)}`,
      intentSha256: `sha256:${"c".repeat(64)}`,
      intentPersistenceReceiptSha256: `sha256:${"d".repeat(64)}`,
    }),
    (error) =>
      error instanceof ProductionMigrationRestoreRequiredError &&
      error.code === "RESTORE_REQUIRED_COMMIT_OUTCOME_UNKNOWN",
  );
  assert.equal(pg.state.statements.at(-1).sql, "COMMIT");
  assert.equal(
    pg.state.statements.some((entry) => entry.sql === "ROLLBACK"),
    false,
  );
  assert.deepEqual(pg.state.released, ["destroy"]);
});

test("ambiguous rollback destroys the tainted client exactly once", async () => {
  const pg = fakePg({ failSql: true, failRollback: true });
  await assert.rejects(
    databaseFor(pg).applyExactStepTransaction({
      step: PRODUCTION_MIGRATION_STEPS[0],
      expectedBeforeStateIndex: 0,
      planSha256: `sha256:${"b".repeat(64)}`,
      intentSha256: `sha256:${"c".repeat(64)}`,
      intentPersistenceReceiptSha256: `sha256:${"d".repeat(64)}`,
    }),
    (error) =>
      error instanceof ProductionMigrationRestoreRequiredError &&
      error.code === "RESTORE_REQUIRED_ROLLBACK_OUTCOME_UNKNOWN",
  );
  assert.deepEqual(pg.state.released, ["destroy"]);
});

test("exclusive artifact store is durable, read-back exact and no-clobber", async () => {
  if (process.platform !== "linux") {
    assert.throws(
      () => createNodeExclusiveArtifactStore({ directory: os.tmpdir() }),
      { code: "PRODUCTION_MIGRATION_ARTIFACT_STORE_UNAVAILABLE" },
    );
    return;
  }
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "prod-migration-store-"),
  );
  try {
    const store = createNodeExclusiveArtifactStore({ directory });
    const canonical = '{"authorizesApplicationStart":false}\n';
    await store.persistExclusive("receipt-01.json", canonical);
    assert.equal(await store.readCanonical("receipt-01.json"), canonical);
    await assert.rejects(store.persistExclusive("receipt-01.json", canonical), {
      code: "PRODUCTION_MIGRATION_ARTIFACT_EXISTS",
    });
    assert.equal(
      await readFile(path.join(directory, "receipt-01.json"), "utf8"),
      canonical,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable intent read-back survives process restart and explicit receipt-backed resume", async () => {
  const {
    plan,
    intent,
    activation,
    fixtureRoleBinding,
    runtimeBinding,
    input,
  } = fixtureActivatedRun();
  const pg = fakePg({
    role: input.database.currentUser,
    sessionUser: input.database.sessionUser,
    databaseName: input.database.name,
  });
  const databaseClock = deterministicClock("2026-08-12T11:02:00.000Z");
  const database = databaseFor(
    pg,
    databaseClock,
    fixtureRoleBinding,
    runtimeBinding,
  );
  const artifacts = memoryArtifactStore();
  const firstProcess = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority: MOCK_ROLE_AUTHORITY,
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: deterministicClock("2026-08-12T11:00:30.000Z"),
  });
  const durable = await firstProcess.prepareDurableRun({
    activationCanonical: activation.canonical,
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
  });
  const firstCommand = createProductionMigrationResumeCommand({
    planCanonical: durable.planCanonical,
    intentCanonical: durable.intentCanonical,
    intentPersistenceReceiptCanonical:
      durable.intentPersistenceReceiptCanonical,
    receiptCanonicals: [],
    operator: "production-owner",
    approvedAt: "2026-08-12T11:01:00.000Z",
    confirmation:
      "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
  });
  const first = await firstProcess.executeNext({
    activationCanonical: activation.canonical,
    durableRun: durable,
    receiptStorageIds: [],
    resumeCommandCanonical: firstCommand.canonical,
  });
  assert.equal(first.authorizesApplicationStart, false);
  assert.equal(pg.state.durableStateIndex, 1);

  const resumedProcess = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority: MOCK_ROLE_AUTHORITY,
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: deterministicClock("2026-08-12T11:04:00.000Z"),
  });
  const reloaded = await resumedProcess.loadDurableRun(durable);
  assert.equal(reloaded.intentCanonical, intent.canonical);
  const secondCommand = createProductionMigrationResumeCommand({
    planCanonical: reloaded.planCanonical,
    intentCanonical: reloaded.intentCanonical,
    intentPersistenceReceiptCanonical:
      reloaded.intentPersistenceReceiptCanonical,
    receiptCanonicals: [first.receiptCanonical],
    operator: "production-owner",
    approvedAt: "2026-08-12T11:03:00.000Z",
    confirmation:
      "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
  });
  const second = await resumedProcess.executeNext({
    activationCanonical: activation.canonical,
    durableRun: reloaded,
    receiptStorageIds: [first.receiptStorageId],
    resumeCommandCanonical: secondCommand.canonical,
  });
  assert.equal(second.authorizesApplicationStart, false);
  assert.equal(pg.state.durableStateIndex, 2);
});

test("authoritative runtime drift between receipt-backed steps stops before SQL", async () => {
  const {
    plan,
    intent,
    activation,
    fixtureRoleBinding,
    runtimeBinding,
    input,
  } = fixtureActivatedRun();
  const pg = fakePg({
    role: input.database.currentUser,
    sessionUser: input.database.sessionUser,
    databaseName: input.database.name,
  });
  const clock = deterministicClock("2026-08-12T11:02:00.000Z");
  let observedBinding = runtimeBinding;
  const database = databaseFor(
    pg,
    clock,
    fixtureRoleBinding,
    runtimeBinding,
    async () =>
      createProductionMigrationRuntimeObservation({
        runtimeBinding: observedBinding,
        observedAt: clock().toISOString(),
      }).canonical,
  );
  const artifacts = memoryArtifactStore();
  const adapter = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority: MOCK_ROLE_AUTHORITY,
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: deterministicClock("2026-08-12T11:00:30.000Z"),
  });
  const durable = await adapter.prepareDurableRun({
    activationCanonical: activation.canonical,
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
  });
  const firstCommand = createProductionMigrationResumeCommand({
    planCanonical: durable.planCanonical,
    intentCanonical: durable.intentCanonical,
    intentPersistenceReceiptCanonical:
      durable.intentPersistenceReceiptCanonical,
    receiptCanonicals: [],
    operator: "production-owner",
    approvedAt: "2026-08-12T11:01:00.000Z",
    confirmation:
      "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
  });
  const first = await adapter.executeNext({
    activationCanonical: activation.canonical,
    durableRun: durable,
    receiptStorageIds: [],
    resumeCommandCanonical: firstCommand.canonical,
  });
  observedBinding = {
    ...runtimeBinding,
    containerId: "f".repeat(64),
  };
  const secondCommand = createProductionMigrationResumeCommand({
    planCanonical: durable.planCanonical,
    intentCanonical: durable.intentCanonical,
    intentPersistenceReceiptCanonical:
      durable.intentPersistenceReceiptCanonical,
    receiptCanonicals: [first.receiptCanonical],
    operator: "production-owner",
    approvedAt: "2026-08-12T11:03:00.000Z",
    confirmation:
      "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
  });
  await assert.rejects(
    adapter.executeNext({
      activationCanonical: activation.canonical,
      durableRun: durable,
      receiptStorageIds: [first.receiptStorageId],
      resumeCommandCanonical: secondCommand.canonical,
    }),
    { code: "PRODUCTION_MIGRATION_RUNTIME_DRIFT" },
  );
  assert.equal(pg.state.durableStateIndex, 1);
  assert.equal(
    pg.state.statements.filter((entry) =>
      entry.sql.startsWith("INSERT INTO drizzle.__drizzle_migrations"),
    ).length,
    1,
  );
});

test("crash after known DB commit but before exclusive receipt is RESTORE_REQUIRED", async () => {
  const {
    plan,
    intent,
    activation,
    fixtureRoleBinding,
    runtimeBinding,
    input,
  } = fixtureActivatedRun();
  const pg = fakePg({
    role: input.database.currentUser,
    sessionUser: input.database.sessionUser,
    databaseName: input.database.name,
  });
  const database = databaseFor(
    pg,
    deterministicClock("2026-08-12T11:02:00.000Z"),
    fixtureRoleBinding,
    runtimeBinding,
  );
  const artifacts = memoryArtifactStore();
  const adapter = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority: MOCK_ROLE_AUTHORITY,
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: deterministicClock("2026-08-12T11:00:30.000Z"),
  });
  const durable = await adapter.prepareDurableRun({
    activationCanonical: activation.canonical,
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
  });
  const command = createProductionMigrationResumeCommand({
    planCanonical: durable.planCanonical,
    intentCanonical: durable.intentCanonical,
    intentPersistenceReceiptCanonical:
      durable.intentPersistenceReceiptCanonical,
    receiptCanonicals: [],
    operator: "production-owner",
    approvedAt: "2026-08-12T11:01:00.000Z",
    confirmation:
      "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
  });
  const persist = artifacts.persistExclusive.bind(artifacts);
  artifacts.persistExclusive = async (storageId, canonical) => {
    if (storageId.startsWith("receipt-")) throw new Error("simulated crash");
    return persist(storageId, canonical);
  };
  await assert.rejects(
    adapter.executeNext({
      activationCanonical: activation.canonical,
      durableRun: durable,
      receiptStorageIds: [],
      resumeCommandCanonical: command.canonical,
    }),
    (error) =>
      error instanceof ProductionMigrationRestoreRequiredError &&
      error.code === "RESTORE_REQUIRED_UNKNOWN_COMMIT",
  );
  assert.equal(pg.state.durableStateIndex, 1);
  assert.equal(
    [...artifacts.values.keys()].some((key) => key.startsWith("receipt-")),
    false,
  );
});

test("ten receipt-backed steps finalize only with exact live inventory and post-role evidence", async () => {
  const {
    plan,
    intent,
    activation,
    fixtureRoleBinding,
    runtimeBinding,
    input,
  } = fixtureActivatedRun();
  const pg = fakePg({
    role: input.database.currentUser,
    sessionUser: input.database.sessionUser,
    databaseName: input.database.name,
  });
  let runtimeObservedAt = Date.parse("2026-08-12T11:01:00.000Z");
  const database = databaseFor(
    pg,
    deterministicClock("2026-08-12T11:01:00.000Z"),
    fixtureRoleBinding,
    runtimeBinding,
    async () =>
      createProductionMigrationRuntimeObservation({
        runtimeBinding,
        observedAt: new Date(runtimeObservedAt++).toISOString(),
      }).canonical,
  );
  const artifacts = memoryArtifactStore();
  const roleEvidence = postCommitRoleEvidence(plan);
  const roleAuthority = {
    assertPrecondition() {},
    assertPostCommit({
      planCanonical,
      roleTransactionReceiptCanonical,
      postCommitRoleArtifactCanonical,
    }) {
      assert.equal(planCanonical, plan.canonical);
      assert.equal(
        roleTransactionReceiptCanonical,
        roleEvidence.receipt.canonical,
      );
      assert.equal(
        postCommitRoleArtifactCanonical,
        roleEvidence.postCommit.canonical,
      );
    },
    async readPostCommitEvidence() {
      return {
        roleTransactionReceiptCanonical: roleEvidence.receipt.canonical,
        postCommitRoleArtifactCanonical: roleEvidence.postCommit.canonical,
      };
    },
  };
  let adapterNow = Date.parse("2026-08-12T11:00:30.000Z");
  const adapter = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority,
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: () => new Date(adapterNow),
  });
  const durable = await adapter.prepareDurableRun({
    activationCanonical: activation.canonical,
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
  });
  const receiptStorageIds = [];
  const receiptCanonicals = [];
  for (let index = 0; index < PRODUCTION_MIGRATION_STEPS.length; index += 1) {
    const resume = createProductionMigrationResumeCommand({
      planCanonical: durable.planCanonical,
      intentCanonical: durable.intentCanonical,
      intentPersistenceReceiptCanonical:
        durable.intentPersistenceReceiptCanonical,
      receiptCanonicals,
      operator: "production-owner",
      approvedAt: `2026-08-12T11:${String(index + 2).padStart(2, "0")}:30.000Z`,
      confirmation:
        "RESUME_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_NEXT_RECEIPT_BACKED_STEP",
    });
    const applied = await adapter.executeNext({
      activationCanonical: activation.canonical,
      durableRun: durable,
      receiptStorageIds,
      resumeCommandCanonical: resume.canonical,
    });
    receiptStorageIds.push(applied.receiptStorageId);
    receiptCanonicals.push(applied.receiptCanonical);
  }
  runtimeObservedAt = Date.parse("2026-08-12T11:11:45.000Z");
  adapterNow = Date.parse("2026-08-12T11:12:00.000Z");
  const finalized = await adapter.finalize({
    activationCanonical: activation.canonical,
    durableRun: durable,
    receiptStorageIds,
  });
  assert.equal(pg.state.durableStateIndex, 10);
  assert.equal(
    JSON.parse(finalized.canonical).final.knownAppliedMigrations,
    107,
  );
  assert.equal(finalized.authorizesApplicationStart, false);
  assert.equal(
    await artifacts.readCanonical(finalized.storageId),
    finalized.canonical,
  );
});

test("runtime drift detected after role ceremony prevents final chain persistence", async () => {
  const { plan, intent, activation, fixtureRoleBinding, runtimeBinding } =
    fixtureActivatedRun();
  const artifacts = memoryArtifactStore();
  const roleEvidence = postCommitRoleEvidence(plan);
  const database = {
    async readInventoryReadOnly() {
      throw new Error("not used");
    },
    async readLiveIdentityReadOnly() {
      const baseline = JSON.parse(plan.value.baselineLiveIdentityCanonical);
      return createProductionMigrationLiveIdentity({
        sourceSha: plan.value.sourceSha,
        database: plan.value.database,
        applicationImageRef: baseline.applicationImageRef,
        postgresImageRef: baseline.postgresImageRef,
        runtimeBindingSha256: baseline.runtimeBindingSha256,
        inventory: fixtureInventory(10),
        observedAt: "2026-08-12T11:11:00.000Z",
      });
    },
    async assertLiveRuntimeReadOnly() {
      throw Object.assign(new Error("runtime drift"), {
        code: "PRODUCTION_MIGRATION_RUNTIME_DRIFT",
      });
    },
    async applyExactStepTransaction() {
      throw new Error("not used");
    },
  };
  const adapter = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority: {
      assertPrecondition() {},
      assertPostCommit({
        roleTransactionReceiptCanonical,
        postCommitRoleArtifactCanonical,
      }) {
        assert.equal(
          roleTransactionReceiptCanonical,
          roleEvidence.receipt.canonical,
        );
        assert.equal(
          postCommitRoleArtifactCanonical,
          roleEvidence.postCommit.canonical,
        );
      },
      async readPostCommitEvidence() {
        return {
          roleTransactionReceiptCanonical: roleEvidence.receipt.canonical,
          postCommitRoleArtifactCanonical: roleEvidence.postCommit.canonical,
        };
      },
    },
    backupAuthority: MOCK_BACKUP_AUTHORITY,
    now: () => new Date("2026-08-12T11:12:00.000Z"),
  });
  const persistence = createProductionMigrationIntentPersistenceReceipt({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    persistedCanonical: intent.canonical,
    persistedAt: "2026-08-12T11:00:30.000Z",
    storageId: "runtime-drift-intent.json",
  });
  const durable = {
    planStorageId: "runtime-drift-plan.json",
    intentStorageId: "runtime-drift-intent.json",
    intentPersistenceReceiptStorageId: "runtime-drift-persistence.json",
  };
  artifacts.values.set(durable.planStorageId, plan.canonical);
  artifacts.values.set(durable.intentStorageId, intent.canonical);
  artifacts.values.set(
    durable.intentPersistenceReceiptStorageId,
    persistence.canonical,
  );
  // Finalize rejects before receipt parsing/storage when the post-role runtime
  // observer detects a changed raw host binding.
  await assert.rejects(
    adapter.finalize({
      activationCanonical: activation.canonical,
      durableRun: durable,
      receiptStorageIds: [],
    }),
    { code: "PRODUCTION_MIGRATION_RUNTIME_DRIFT" },
  );
  assert.equal(
    [...artifacts.values.keys()].some((key) =>
      key.startsWith("transition-chain-"),
    ),
    false,
  );
  assert.equal(runtimeBinding.sourceSha, plan.value.sourceSha);
});

test("role binding is explicitly external, no-bootstrap and non-authorizing", () => {
  assert.equal(roleBinding.value.migrationRoleProvisionedExternally, true);
  assert.equal(roleBinding.value.bootstrapPerformedByAdapter, false);
  assert.equal(roleBinding.value.authorizesRoleBootstrap, false);
  assert.equal(roleBinding.value.authorizesApplicationStart, false);
  assert.notEqual(
    roleBinding.value.migrationRole,
    roleBinding.value.runtimeRole,
  );
  assert.notEqual(
    roleBinding.value.sessionUser,
    roleBinding.value.migrationRole,
  );
  assert.notEqual(roleBinding.value.sessionUser, roleBinding.value.runtimeRole);
  assert.equal(
    PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
    "ENABLE_REVIEWED_0096_TO_0107_PRODUCTION_MIGRATION_ADAPTER",
  );
});

test("backup authority verifies detached Ed25519 signature against exact pinned key before plan", () => {
  const input = fixturePlanInput();
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  input.backupDetachedSignatureB64 = sign(
    null,
    productionExact0096BackupSignaturePayload(
      input.backupSignatureEnvelopeCanonical,
    ),
    privateKey,
  ).toString("base64");
  const keyId = JSON.parse(input.backupSignatureEnvelopeCanonical).keyId;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  const publicKeySha256 = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const authority = createProductionMigrationBackupAuthority({
    trustedHostAttestationKeys: { [keyId]: publicKeyPem },
    expectedHostEvidencePublicKeySha256: publicKeySha256,
  });
  assert.equal(
    authority.assertInputSignature(input).publicKeySha256,
    publicKeySha256,
  );
  input.backupDetachedSignatureB64 = Buffer.alloc(64, 7).toString("base64");
  assert.throws(
    () => authority.assertInputSignature(input),
    /PRODUCTION_BACKUP_SIGNATURE_INVALID/,
  );
});

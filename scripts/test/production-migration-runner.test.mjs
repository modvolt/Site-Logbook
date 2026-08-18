import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createProductionMigrationRoleBinding,
} from "../production-evidence/production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  PRODUCTION_MIGRATION_STEPS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
} from "../production-evidence/production-migration-contract.mjs";
import {
  PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
  PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
  PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
  PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
  createProductionMigrationExecutable,
} from "../production-evidence/production-migration-runner.mjs";
import {
  PRODUCTION_MIGRATION_AUTHORITY_BINDINGS,
  createProductionMigrationAbortableConnect,
  persistProductionMigrationMode0600Exclusive,
  readProductionMigrationDetachedSignatureRaw,
  resolveProductionMigrationPinnedAuthority,
  runProductionMigrationCli,
} from "../production-evidence/run-production-migration.mjs";
import {
  fixtureInventory,
  fixturePlanInput,
} from "./production-migration-control-plane-fixtures.mjs";

function memoryArtifactStore() {
  const values = new Map();
  const writes = [];
  return {
    values,
    writes,
    async persistExclusive(storageId, canonical) {
      if (values.has(storageId)) {
        throw Object.assign(new Error("exclusive artifact exists"), {
          code: "PRODUCTION_MIGRATION_ARTIFACT_EXISTS",
        });
      }
      values.set(storageId, canonical);
      writes.push(storageId);
      return { storageId };
    },
    async readCanonical(storageId) {
      if (!values.has(storageId)) {
        throw Object.assign(new Error("artifact missing"), {
          code: "PRODUCTION_MIGRATION_ARTIFACT_READ_FAILED",
        });
      }
      return values.get(storageId);
    },
  };
}

async function cliPreflightFixture({ hangingRuntimeImport = false } = {}) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "site-logbook-migration-cli-"),
  );
  await mkdir(path.join(directory, "migrations"));
  await mkdir(path.join(directory, "artifacts"));
  const runtimeModule = hangingRuntimeImport
    ? "await new Promise(() => {}); export function observeProductionMigrationRuntime() {}\n"
    : "globalThis.__productionMigrationCliAuthorityImports = (globalThis.__productionMigrationCliAuthorityImports ?? 0) + 1; export function observeProductionMigrationRuntime() {}\n";
  const roleModule = [
    "globalThis.__productionMigrationCliAuthorityImports = (globalThis.__productionMigrationCliAuthorityImports ?? 0) + 1;",
    "export function assertProductionMigrationRolePrecondition() {}",
    "export function readProductionMigrationPostCommitEvidence() {}",
    "export function assertProductionMigrationRolePostCommit() {}",
    "",
  ].join("\n");
  await writeFile(path.join(directory, "runtime.mjs"), runtimeModule, "utf8");
  await writeFile(path.join(directory, "role.mjs"), roleModule, "utf8");
  const descriptor = {
    schemaVersion: "site-logbook.production-migration-runner-descriptor/v2",
    kind: "site-logbook-production-migration-runner-descriptor",
    executionDefault: "disabled",
    migrationsDirectory: "migrations",
    artifactDirectory: "artifacts",
    authorities: {
      runtime: {
        id: "test.runtime/v1",
        sha256: "1".repeat(64),
      },
      role: {
        id: "test.role/v1",
        sha256: "2".repeat(64),
      },
    },
    roleCeremony: {
      activation: "role-activation.json",
      transactionReceipt: "role-transaction-receipt.json",
      postCommitProjection: "role-postcommit.json",
    },
    connection: { source: "environment", reference: "TEST_DATABASE_URL" },
    inputs: {
      targetEvidence: "target.json",
      baselineLiveIdentity: "baseline.json",
      backupPlan: "backup-plan.json",
      backupExecutorTrace: "backup-trace.json",
      backupReceipt: "backup-receipt.json",
      backupSignatureEnvelope: "backup-signature.json",
      backupDetachedSignature: "backup-signature.bin",
      rolePrecondition: "role-precondition.json",
      roleBootstrapReceipt: "role-bootstrap-receipt.json",
    },
    roleBinding: {
      databaseName: "site_logbook",
      sessionUser: "site_logbook_executor",
      migrationRole: "site_logbook_backup",
      runtimeRole: "site_logbook_runtime",
    },
    intentId: "a".repeat(64),
    authorizesApplicationStart: false,
  };
  const descriptorPath = path.join(directory, "descriptor.json");
  await writeFile(descriptorPath, JSON.stringify(descriptor), "utf8");
  return {
    descriptorPath,
    authorityResolver: async (kind) => {
      globalThis.__productionMigrationCliAuthorityImports =
        (globalThis.__productionMigrationCliAuthorityImports ?? 0) + 1;
      if (kind === "runtime" && hangingRuntimeImport) {
        return new Promise(() => {});
      }
      if (kind === "runtime") {
        return { observeProductionMigrationRuntime() {} };
      }
      return {
        assertProductionMigrationRolePrecondition() {},
        assertProductionMigrationRolePostCommit() {},
        applyProductionMigrationRoleCeremony() {},
      };
    },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function postCommitRoleEvidence(planCanonical) {
  const plan = JSON.parse(planCanonical);
  const role = JSON.parse(plan.rolePreconditionCanonical);
  const projection = JSON.parse(role.preProjectionCanonical);
  const projectionSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(projection))
    .digest("hex");
  const body = {
    schemaVersion: "site-logbook.production-db-role-separation-receipt/v1",
    planSha256: role.rolePlanSha256,
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    executorId: "independent-role-executor",
    approvalId: "attended-role-separation-approval",
    executedAt: "2026-08-12T11:15:00.000Z",
    statementCount: 1,
    postProjectionSha256: projectionSha256,
    postValidation: "passed",
    authorizesDeployment: false,
    postCommitVerification: "unavailable",
    postCommitVerifierArtifact: null,
  };
  const receipt = createProductionMigrationArtifact({
    ...body,
    receiptSha256: createHash("sha256")
      .update(canonicalProductionMigrationJson(body))
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
    observedAt: "2026-08-12T11:16:00.000Z",
    authorizesDeployment: false,
  });
  return { receipt, postCommit };
}

function fakeDatabase(planInput) {
  const live = JSON.parse(planInput.baselineLiveIdentityCanonical);
  let stateIndex = 0;
  let clock = Date.parse("2026-08-12T11:01:00.000Z");
  const observations = [];
  const applied = [];
  function liveIdentity() {
    const artifact = createProductionMigrationLiveIdentity({
      sourceSha: live.sourceSha,
      database: live.database,
      applicationImageRef: live.applicationImageRef,
      postgresImageRef: live.postgresImageRef,
      runtimeBindingSha256: live.runtimeBindingSha256,
      inventory: fixtureInventory(stateIndex),
      observedAt: new Date(clock++).toISOString(),
    });
    observations.push({ kind: "live", stateIndex });
    return artifact;
  }
  return {
    observations,
    applied,
    get stateIndex() {
      return stateIndex;
    },
    async readInventoryReadOnly() {
      observations.push({ kind: "inventory", stateIndex });
      return fixtureInventory(stateIndex);
    },
    async readLiveIdentityReadOnly() {
      return liveIdentity();
    },
    async assertLiveRuntimeReadOnly() {
      observations.push({ kind: "runtime-post-role", stateIndex });
      return createProductionMigrationArtifact({
        schemaVersion: "fixture.runtime-observation/v1",
        stateIndex,
        authorizesProductionMigration: false,
      });
    },
    async applyExactStepTransaction({
      step,
      expectedBeforeStateIndex,
      planSha256,
      intentSha256,
      intentPersistenceReceiptSha256,
    }) {
      assert.equal(expectedBeforeStateIndex, stateIndex);
      assert.deepEqual(step, PRODUCTION_MIGRATION_STEPS[stateIndex]);
      const before = fixtureInventory(stateIndex);
      observations.push({ kind: "locked-before", stateIndex });
      stateIndex += 1;
      const after = fixtureInventory(stateIndex);
      observations.push({ kind: "locked-after", stateIndex });
      const transactionStartedAt = new Date(clock++).toISOString();
      const transactionCompletedAt = new Date(clock++).toISOString();
      const identity = liveIdentity();
      applied.push(step.tag);
      return createProductionMigrationArtifact({
        schemaVersion:
          "site-logbook.production-migration-transaction-evidence/v1",
        kind: "site-logbook-production-migration-transaction-evidence",
        executorRunId: String(stateIndex).padStart(64, "0"),
        planSha256,
        intentSha256,
        intentPersistenceReceiptSha256,
        migration: step,
        before,
        after,
        liveIdentityCanonical: identity.canonical,
        liveIdentitySha256: identity.sha256,
        advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
        transactionCommitted: true,
        transactionStartedAt,
        transactionCompletedAt,
        authorizesApplicationStart: false,
      });
    },
  };
}

test("attended runner completes all ten exact steps and never authorizes app start", async () => {
  const planInput = fixturePlanInput();
  const rolePrecondition = JSON.parse(planInput.rolePreconditionCanonical);
  const roleBinding = createProductionMigrationRoleBinding({
    databaseName: planInput.database.name,
    sessionUser: planInput.database.sessionUser,
    migrationRole: planInput.database.currentUser,
    runtimeRole: rolePrecondition.runtimeRole,
  });
  assert.equal(roleBinding.value.migrationRoleProvisionedExternally, true);
  assert.equal(roleBinding.value.bootstrapPerformedByAdapter, false);
  const artifacts = memoryArtifactStore();
  const database = fakeDatabase(planInput);
  let nowValue = Date.parse("2026-08-12T11:00:30.000Z");
  let postRole;
  const roleAuthority = {
    assertPrecondition() {},
    async readPostCommitEvidence() {
      return {
        roleTransactionReceiptCanonical: postRole.receipt.canonical,
        postCommitRoleArtifactCanonical: postRole.postCommit.canonical,
      };
    },
    assertPostCommit({
      roleTransactionReceiptCanonical,
      postCommitRoleArtifactCanonical,
    }) {
      assert.equal(roleTransactionReceiptCanonical, postRole.receipt.canonical);
      assert.equal(
        postCommitRoleArtifactCanonical,
        postRole.postCommit.canonical,
      );
    },
    async applyCeremony() {
      return {
        roleTransactionReceiptCanonical: postRole.receipt.canonical,
        postCommitRoleArtifactCanonical: postRole.postCommit.canonical,
        authorizesApplicationStart: false,
      };
    },
  };
  const backupAuthority = {
    assertInputSignature() {},
    assertPlanSignature() {},
  };
  const executable = createProductionMigrationExecutable({
    planInput,
    roleBindingCanonical: roleBinding.canonical,
    intentId: "b".repeat(64),
    database,
    artifacts,
    roleAuthority,
    backupAuthority,
    now: () => new Date(nowValue++),
  });
  const prepared = await executable.prepare({
    operator: "production-owner",
    approvedAt: "2026-08-12T11:00:00.000Z",
    intentConfirmation: PRODUCTION_MIGRATION_CONFIRMATION,
    activationConfirmation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  });
  assert.equal(prepared.authorizesApplicationStart, false);
  postRole = postCommitRoleEvidence(
    artifacts.values.get(
      [...artifacts.values.keys()].find((id) => id.startsWith("plan-")),
    ),
  );

  for (let index = 0; index < PRODUCTION_MIGRATION_STEPS.length; index += 1) {
    const writesBeforeInspect = artifacts.writes.length;
    const inspected = await executable.inspect({
      receiptCount: index,
      confirmation: PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
    });
    assert.equal(artifacts.writes.length, writesBeforeInspect);
    assert.equal(inspected.liveStateIndex, index);
    assert.equal(inspected.resumeAllowed, false);
    assert.equal(inspected.nextStep, null);
    assert.equal(inspected.authorizesApplicationStart, false);

    const resume = await executable.resume({
      receiptCount: index,
      operator: "production-owner",
      approvedAt: `2026-08-12T11:${String(index + 2).padStart(2, "0")}:00.000Z`,
      confirmation: PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
    });
    assert.equal(resume.nextStepTag, PRODUCTION_MIGRATION_STEPS[index].tag);
    assert.equal(resume.authorizesApplicationStart, false);

    const applied = await executable.apply({
      receiptCount: index,
      resumeStorageId: resume.storageId,
      confirmation: PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
    });
    assert.equal(applied.receiptCount, index + 1);
    assert.equal(applied.authorizesApplicationStart, false);
  }

  let ceremonyEvidence;
  const ceremony = await executable.applyRoleCeremony({
    receiptCount: 10,
    confirmation: PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
    activationCanonical: "fixture-role-activation",
    async persistEvidence(evidence) {
      ceremonyEvidence = evidence;
    },
  });
  assert.equal(ceremony.decision, "ROLE_CEREMONY_COMMITTED_EVIDENCE_DURABLE");
  assert.equal(ceremony.authorizesApplicationStart, false);
  assert.equal(
    ceremonyEvidence.roleTransactionReceiptCanonical,
    postRole.receipt.canonical,
  );

  nowValue = Date.parse("2026-08-12T11:20:00.000Z");
  const finalized = await executable.finalize({
    receiptCount: 10,
    confirmation: PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
  });
  assert.equal(database.stateIndex, 10);
  assert.deepEqual(
    database.applied,
    PRODUCTION_MIGRATION_STEPS.map((step) => step.tag),
  );
  assert.equal(finalized.receiptCount, 10);
  assert.equal(finalized.rolePostCommitProofRequired, true);
  assert.equal(finalized.authorizesApplicationStart, false);
  const chain = JSON.parse(artifacts.values.get(finalized.storageId));
  assert.equal(chain.final.knownAppliedMigrations, 107);
  assert.equal(chain.final.totalJournalRows, 109);
  assert.equal(chain.authorizesApplicationStart, false);
  assert.equal(
    database.observations.some(
      (entry) => entry.kind === "runtime-post-role" && entry.stateIndex === 10,
    ),
    true,
  );
});

test("runner is default-dark and refuses inspect, resume, apply and finalize without exact confirmations", async () => {
  const planInput = fixturePlanInput();
  const role = JSON.parse(planInput.rolePreconditionCanonical);
  const executable = createProductionMigrationExecutable({
    planInput,
    roleBindingCanonical: createProductionMigrationRoleBinding({
      databaseName: planInput.database.name,
      sessionUser: planInput.database.sessionUser,
      migrationRole: planInput.database.currentUser,
      runtimeRole: role.runtimeRole,
    }).canonical,
    intentId: "e".repeat(64),
    database: fakeDatabase(planInput),
    artifacts: memoryArtifactStore(),
    roleAuthority: {
      assertPrecondition() {},
      readPostCommitEvidence() {
        throw new Error("not reached");
      },
      assertPostCommit() {
        throw new Error("not reached");
      },
    },
    backupAuthority: {
      assertInputSignature() {},
      assertPlanSignature() {},
    },
  });
  await assert.rejects(
    executable.prepare({
      operator: "operator",
      approvedAt: "2026-08-12T11:00:00.000Z",
      intentConfirmation: "yes",
      activationConfirmation: "yes",
    }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    executable.inspect({ receiptCount: 0, confirmation: "inspect" }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    executable.resume({ receiptCount: 0, confirmation: "resume" }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    executable.apply({ receiptCount: 0, confirmation: "apply" }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    executable.finalize({ receiptCount: 10, confirmation: "finalize" }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    executable.applyRoleCeremony({
      receiptCount: 10,
      confirmation: "ceremony",
    }),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
});

test("CLI has no connection-secret argv surface and does not echo rejected values", async () => {
  const marker = "postgres://operator:never-echo-this@example.invalid/db";
  await assert.rejects(
    runProductionMigrationCli([
      "inspect",
      "--descriptor",
      "descriptor.json",
      "--database-url",
      marker,
    ]),
    (error) =>
      error.code === "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID" &&
      !error.message.includes(marker),
  );
});

test("runner accepts one stable raw 64-byte signature and rejects text aliases, wrong lengths, symlinks and drift", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "site-logbook-migration-signature-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseReal = await realpath(directory);
  const signaturePath = path.join(directory, "backup-signature.bin");
  const raw = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  await writeFile(signaturePath, raw);
  assert.equal(
    await readProductionMigrationDetachedSignatureRaw(baseReal, signaturePath),
    raw.toString("base64"),
  );

  await writeFile(signaturePath, raw.toString("base64"), "utf8");
  await assert.rejects(
    readProductionMigrationDetachedSignatureRaw(baseReal, signaturePath),
    { code: "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID" },
  );
  for (const length of [63, 65]) {
    await writeFile(signaturePath, Buffer.alloc(length, 7));
    await assert.rejects(
      readProductionMigrationDetachedSignatureRaw(baseReal, signaturePath),
      { code: "PRODUCTION_MIGRATION_RUNNER_INPUT_INVALID" },
    );
  }

  await writeFile(signaturePath, raw);
  const linkPath = path.join(directory, "backup-signature-link.bin");
  try {
    await symlink("backup-signature.bin", linkPath, "file");
    await assert.rejects(
      readProductionMigrationDetachedSignatureRaw(baseReal, linkPath),
      { code: "PRODUCTION_MIGRATION_RUNNER_PATH_INVALID" },
    );
  } catch (error) {
    if (!["EPERM", "EACCES", "ENOSYS"].includes(error?.code)) throw error;
    t.diagnostic(`symlink assertion unavailable on this host: ${error.code}`);
  }

  await writeFile(signaturePath, raw);
  await assert.rejects(
    readProductionMigrationDetachedSignatureRaw(baseReal, signaturePath, {
      afterRead: (filename) => writeFile(filename, Buffer.alloc(63, 9)),
    }),
    { code: "PRODUCTION_MIGRATION_RUNNER_INPUT_DRIFT" },
  );
});

test("CLI rejects missing or wrong confirmation before authority import or connection-secret lookup", async (t) => {
  const fixture = await cliPreflightFixture();
  t.after(fixture.cleanup);
  delete globalThis.__productionMigrationCliAuthorityImports;
  let secretReads = 0;
  const environment = new Proxy(
    {},
    {
      get() {
        secretReads += 1;
        throw new Error("connection secret must not be read");
      },
    },
  );
  await assert.rejects(
    runProductionMigrationCli(
      [
        "inspect",
        "--descriptor",
        fixture.descriptorPath,
        "--receipt-count",
        "0",
      ],
      { environment },
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID" },
  );
  await assert.rejects(
    runProductionMigrationCli(
      [
        "inspect",
        "--descriptor",
        fixture.descriptorPath,
        "--receipt-count",
        "0",
        "--confirmation",
        "yes",
      ],
      { environment },
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED" },
  );
  await assert.rejects(
    runProductionMigrationCli(
      [
        "prepare",
        "--descriptor",
        fixture.descriptorPath,
        "--operator",
        "production-owner",
        "--approved-at",
        "2026-08-12T11:00:00Z",
        "--intent-confirmation",
        PRODUCTION_MIGRATION_CONFIRMATION,
        "--activation-confirmation",
        PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
      ],
      { environment },
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_ARGUMENT_INVALID" },
  );
  assert.equal(globalThis.__productionMigrationCliAuthorityImports, undefined);
  assert.equal(secretReads, 0);
});

test("runner descriptor v2 fails closed on the pre-bootstrap-receipt v1 shape", async (t) => {
  const fixture = await cliPreflightFixture();
  t.after(fixture.cleanup);
  const descriptor = JSON.parse(await readFile(fixture.descriptorPath, "utf8"));
  descriptor.schemaVersion =
    "site-logbook.production-migration-runner-descriptor/v1";
  await writeFile(fixture.descriptorPath, JSON.stringify(descriptor), "utf8");
  await assert.rejects(
    runProductionMigrationCli(
      [
        "inspect",
        "--descriptor",
        fixture.descriptorPath,
        "--receipt-count",
        "0",
        "--confirmation",
        PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
      ],
      {
        environment: {},
        authorityResolver: fixture.authorityResolver,
      },
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_DESCRIPTOR_INVALID" },
  );
});

test("CLI overall deadline aborts a hung authority import before connection-secret lookup", async (t) => {
  const fixture = await cliPreflightFixture({ hangingRuntimeImport: true });
  t.after(fixture.cleanup);
  let secretReads = 0;
  const environment = new Proxy(
    {},
    {
      get() {
        secretReads += 1;
        throw new Error("connection secret must not be read");
      },
    },
  );
  const startedAt = Date.now();
  await assert.rejects(
    runProductionMigrationCli(
      [
        "inspect",
        "--descriptor",
        fixture.descriptorPath,
        "--receipt-count",
        "0",
        "--confirmation",
        PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
      ],
      {
        environment,
        timeoutMs: 25,
        authorityResolver: fixture.authorityResolver,
      },
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_TIMEOUT" },
  );
  assert.ok(Date.now() - startedAt < 2_000);
  assert.equal(secretReads, 0);
});

test("AbortSignal destroys a PostgreSQL client whose query never settles", async () => {
  const controller = new AbortController();
  const releases = [];
  const connect = createProductionMigrationAbortableConnect(
    {
      async connect() {
        return {
          query() {
            return new Promise(() => {});
          },
          release(destroy) {
            releases.push(destroy);
          },
        };
      },
    },
    controller.signal,
  );
  const client = await connect();
  const query = client.query("SELECT 1");
  controller.abort();
  await assert.rejects(query, {
    code: "PRODUCTION_MIGRATION_RUNNER_ABORTED",
  });
  assert.deepEqual(releases, [true]);
});

test("default source-pin resolver verifies actual authority source closures and rejects a substituted digest", async () => {
  const signal = new AbortController().signal;
  const runtime = await resolveProductionMigrationPinnedAuthority(
    "runtime",
    PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.runtime,
    signal,
  );
  assert.equal(typeof runtime.observeProductionMigrationRuntime, "function");
  const role = await resolveProductionMigrationPinnedAuthority(
    "role",
    PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.role,
    signal,
  );
  assert.equal(
    typeof role.assertProductionMigrationRolePrecondition,
    "function",
  );
  assert.equal(typeof role.assertProductionMigrationRolePostCommit, "function");
  assert.equal(typeof role.applyProductionMigrationRoleCeremony, "function");
  assert.equal(
    typeof role.normalizeProductionMigrationRoleProjection,
    "function",
  );
  assert.equal(
    path.basename(PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.role.path),
    "production-migration-role-ceremony.ts",
  );
  assert.deepEqual(
    PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.role.transitiveSources.map(
      ({ path: sourcePath }) => path.basename(sourcePath),
    ),
    [
      "production-migration-role-authority.ts",
      "production-role-separation-contract.ts",
    ],
  );
  await assert.rejects(
    resolveProductionMigrationPinnedAuthority(
      "runtime",
      {
        ...PRODUCTION_MIGRATION_AUTHORITY_BINDINGS.runtime,
        sha256: "0".repeat(64),
      },
      signal,
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_AUTHORITY_NOT_PINNED" },
  );
});

test("role evidence custody proves exact mode/readback, refuses clobber and removes an unsynced partial", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "site-logbook-role-custody-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const baseReal = await realpath(directory);
  const target = path.join(directory, "receipt.json");
  const canonical = '{"authorizesApplicationStart":false}\n';
  const firstPersistence = persistProductionMigrationMode0600Exclusive(
    baseReal,
    target,
    "test.receipt",
    canonical,
  );
  if (process.platform === "win32") {
    await assert.rejects(firstPersistence, {
      code: "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_FAILED",
    });
  } else {
    await firstPersistence;
  }
  const metadata = await lstat(target, { bigint: true });
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.nlink, 1n);
  if (process.platform !== "win32") {
    assert.equal(Number(metadata.mode) & 0o077, 0);
  }
  assert.equal(await readFile(target, "utf8"), canonical);
  await assert.rejects(
    persistProductionMigrationMode0600Exclusive(
      baseReal,
      target,
      "test.receipt",
      "different",
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_ALREADY_ATTEMPTED" },
  );
  assert.equal(await readFile(target, "utf8"), canonical);

  const partial = path.join(directory, "partial.json");
  await assert.rejects(
    persistProductionMigrationMode0600Exclusive(
      baseReal,
      partial,
      "test.partial",
      Symbol("invalid-canonical"),
    ),
    { code: "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_FAILED" },
  );
  await assert.rejects(lstat(partial), { code: "ENOENT" });
});

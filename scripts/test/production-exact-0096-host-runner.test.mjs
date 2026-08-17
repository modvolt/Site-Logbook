import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PRODUCTION_EXACT_0096_HOST_EXECUTION_CONFIRMATION,
  PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION,
  main,
  persistPreparedPlanExclusive,
  runProductionExact0096HostPreparation,
  runProductionExact0096HostExecution,
  runProductionExact0096HostPreflight,
} from "../production-evidence/run-production-exact-0096-backup.mjs";
import {
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";
import { createProductionExact0096BackupPlan } from "../production-evidence/production-exact-0096-backup-planner.mjs";
import {
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  PRODUCTION_MIGRATION_PREFIX_STATES,
} from "../production-evidence/production-migration-contract.mjs";
import { loadProductionMigrationCatalog } from "../production-evidence/production-migration-adapter.mjs";
import {
  fixtureExecutorTrace,
  fixtureExecutorDependencies,
  fixturePlanInput,
  fixtureRestoreRuntimeBinding,
  fixtureTableSnapshot,
} from "./production-exact-0096-backup-contract-fixtures.mjs";
import { runProductionExact0096BackupEvidenceExecutor } from "../production-evidence/production-exact-0096-backup-receipt.mjs";

const sourceId = "2".repeat(64);
const controlId = "c".repeat(64);

function dockerProjection(value) {
  return { stdout: JSON.stringify(value), stderr: "" };
}

async function fixturePlan() {
  const input = fixturePlanInput();
  input.executor.imageRef = `site-logbook-control-plane@${input.executor.imageRef.split("@")[1]}`;
  input.runtimeBinding.postgresImageRef = `postgres@${input.runtimeBinding.postgresImageRef.split("@")[1]}`;
  input.runtimeBinding.volumeLabelsSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson({}),
  );
  input.stoppedWritersProof.runtimeBindingSha256 =
    productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(input.runtimeBinding),
    );
  return createProductionExact0096BackupPlan(input);
}

function fixtureRestoreBindingForPlan(plan) {
  return {
    ...fixtureRestoreRuntimeBinding(),
    executorImageRef: plan.value.executor.imageRef,
  };
}

function fixturePreparationIntent(plan) {
  return {
    schemaVersion: "site-logbook.production-exact-0096-plan-prepare-intent/v1",
    operationId: plan.value.operationId,
    maintenanceWindowId: plan.value.stoppedWritersProof.maintenanceWindowId,
    liveSource: structuredClone(plan.value.liveSource),
    executor: structuredClone(plan.value.executor),
    runtimeBinding: structuredClone(plan.value.runtimeBinding),
  };
}

async function journalRows() {
  const catalog = await loadProductionMigrationCatalog({
    migrationsDirectory: resolve("lib/db/migrations"),
  });
  return [
    ...catalog.expected.slice(0, 97).map((entry) => ({
      created_at: entry.when,
      hash: entry.hash,
    })),
    ...PRODUCTION_OPAQUE_LEGACY_ROWS.map((entry) => ({
      created_at: entry.createdAt,
      hash: entry.hash,
    })),
  ].sort(
    (left, right) =>
      left.created_at - right.created_at ||
      (left.hash < right.hash ? -1 : left.hash > right.hash ? 1 : 0),
  );
}

async function createHarness(
  root,
  plan,
  { sourceSchemaFingerprint, restoreSchemaFingerprint } = {},
) {
  const hostRequestDirectory = join(root, "requests");
  const evidenceDirectory = join(root, "evidence");
  const secretEnvFile = join(root, "backup.env");
  await writeFile(
    secretEnvFile,
    [
      "DATABASE_URL=postgresql://hidden:hidden@source/site_logbook",
      "S3_ENDPOINT=https://fsn1.your-objectstorage.com",
      "S3_REGION=fsn1",
      "S3_BUCKET=modvoltdata",
      "S3_ACCESS_KEY_ID=hidden",
      "S3_SECRET_ACCESS_KEY=hidden",
      "S3_FORCE_PATH_STYLE=false",
      'BACKUP_ENCRYPTION_KEYRING={"production-backup-2026-08":"hidden"}',
      "BACKUP_ENCRYPTION_ACTIVE_KEY_ID=production-backup-2026-08",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  const config = {
    schemaVersion: "site-logbook.production-exact-0096-host-runner/v1",
    controlPlaneImageRef: plan.value.executor.imageRef,
    postgresImageRef: plan.value.runtimeBinding.postgresImageRef,
    secretEnvFile,
    hostRequestDirectory,
    evidenceDirectory,
    migrationsDirectory: resolve("lib/db/migrations"),
    timeoutMs: 30_000,
    overallTimeoutMs: 5 * 60_000,
  };
  const calls = [];
  const workerRequests = [];
  let controlCreated = false;
  let writerWindowCount = 0;
  const rows = await journalRows();
  const restoreSnapshot = fixtureTableSnapshot({
    observedAt: "2026-08-12T10:04:50.000Z",
    snapshotTokenSha256: `sha256:${"c".repeat(64)}`,
  });
  const sourceAfterSnapshot = fixtureTableSnapshot({
    observedAt: "2026-08-12T10:05:10.000Z",
    snapshotTokenSha256: `sha256:${"9".repeat(64)}`,
  });
  const sourceContainer = {
    Id: sourceId,
    Image: plan.value.runtimeBinding.postgresImageId,
    Name: "/source-postgres",
    // Coolify may have created the already-running source container from a
    // mutable compose tag. The immutable boundary is the observed image ID
    // plus the exact RepoDigest, not the historical Config.Image spelling.
    Config: { Image: "postgres:16-alpine", User: "" },
    State: { Status: "running" },
    Mounts: [
      {
        Type: "volume",
        Name: plan.value.runtimeBinding.volumeName,
        Destination: "/var/lib/postgresql/data",
        RW: true,
      },
    ],
    NetworkSettings: {
      Networks: {
        [plan.value.runtimeBinding.networkName]: {
          NetworkID: plan.value.runtimeBinding.networkId,
        },
      },
    },
    HostConfig: { Binds: null, PortBindings: {} },
  };
  const controlContainer = {
    Id: controlId,
    Image: `sha256:${"9".repeat(64)}`,
    Name: "/control",
    Config: { Image: plan.value.executor.imageRef, User: "1000:1000" },
    State: { Status: "running" },
    Mounts: [
      {
        Type: "bind",
        Source: hostRequestDirectory,
        Destination: "/run/site-logbook-production-backup",
        RW: false,
      },
    ],
    NetworkSettings: { Networks: {} },
    HostConfig: { Binds: [], PortBindings: {} },
  };
  const workerOutput = async (containerPath) => {
    const request = JSON.parse(
      await readFile(
        join(hostRequestDirectory, containerPath.split("/").at(-1)),
        "utf8",
      ),
    );
    workerRequests.push(structuredClone(request));
    if (request.operation === "observe-source") {
      return {
        observedAt: "2026-08-12T10:00:10.000Z",
        database: plan.value.sourceDatabase,
        journalRows: rows,
        schemaFingerprintSha256:
          sourceSchemaFingerprint ?? plan.value.schemaFingerprintSha256,
      };
    }
    if (request.operation === "writer-window") {
      writerWindowCount += 1;
      const after = writerWindowCount > 1;
      return {
        quiescentSince: after
          ? "2026-08-12T10:05:00.000Z"
          : "2026-08-12T10:00:15.000Z",
        observedAt: after
          ? "2026-08-12T10:06:00.000Z"
          : "2026-08-12T10:01:15.000Z",
        gracePeriodMs: 60_000,
        activeApplicationSessions: 0,
        activeWriteTransactions: 0,
        databaseWritesObserved: 0,
      };
    }
    if (request.operation === "restore-object") {
      return {
        acceptedObjectVersionId: request.backupObject.versionId,
        completedAt: "2026-08-12T10:03:40.000Z",
        pgRestoreExitCode: 0,
        plaintextBytes: 900_000,
        plaintextSha256: request.sourceDumpSha256,
      };
    }
    if (request.operation === "observe-restore") {
      return {
        observedAt: "2026-08-12T10:04:50.000Z",
        database: {
          name: request.restore.database,
          user: request.restore.user,
          serverVersionMajor: 16,
        },
        journalRows: rows,
        schemaFingerprintSha256:
          restoreSchemaFingerprint ?? plan.value.schemaFingerprintSha256,
        tableSnapshot: restoreSnapshot,
      };
    }
    if (request.operation === "observe-source-snapshot") {
      return {
        observedAt: "2026-08-12T10:05:10.000Z",
        database: plan.value.sourceDatabase,
        journalRows: rows,
        schemaFingerprintSha256:
          sourceSchemaFingerprint ?? plan.value.schemaFingerprintSha256,
        tableSnapshot: sourceAfterSnapshot,
      };
    }
    throw new Error("unexpected worker request");
  };
  const execFile = async (command, args) => {
    calls.push({ command, args: [...args] });
    assert.equal(command, "docker");
    if (args[0] === "image" && args[1] === "inspect") {
      const ref = args.at(-1);
      if (ref === plan.value.executor.imageRef) {
        return dockerProjection({
          Id: `sha256:${"9".repeat(64)}`,
          RepoDigests: [ref],
          Labels: {
            "io.modvolt.site-logbook.image-profile": "control-plane",
            "org.opencontainers.image.revision": plan.value.executor.buildSha,
          },
        });
      }
      return dockerProjection({
        Id: plan.value.runtimeBinding.postgresImageId,
        RepoDigests: [ref],
        Labels: {},
      });
    }
    if (args[0] === "container" && args[1] === "inspect") {
      return dockerProjection(
        args.at(-1) === sourceId ? sourceContainer : controlContainer,
      );
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return dockerProjection({
        Name: plan.value.runtimeBinding.volumeName,
        CreatedAt: plan.value.runtimeBinding.volumeCreatedAt,
        Labels: {},
      });
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return dockerProjection({
        Id: plan.value.runtimeBinding.networkId,
        Name: plan.value.runtimeBinding.networkName,
        Internal: false,
        Containers: controlCreated
          ? { [sourceId]: {}, [controlId]: {} }
          : { [sourceId]: {} },
      });
    }
    if (args[0] === "container" && args[1] === "create") {
      controlCreated = true;
      return { stdout: `${controlId}\n`, stderr: "" };
    }
    if (args[0] === "container" && args[1] === "exec") {
      return {
        stdout: canonicalProductionExact0096BackupJson(
          await workerOutput(args.at(-1)),
        ),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  };
  return { config, calls, execFile, workerRequests };
}

test("host runner remains default-dark before any Docker operation", async () => {
  const plan = await fixturePlan();
  let calls = 0;
  await assert.rejects(
    () =>
      runProductionExact0096HostExecution(
        {
          planCanonical: plan.canonical,
          config: {},
          confirmation: "WRONG",
          signal: new AbortController().signal,
        },
        { execFile: async () => calls++ },
      ),
    (error) => error?.code === "PRODUCTION_BACKUP_HOST_RUNNER_DARK",
  );
  assert.equal(calls, 0);
});

test("plan preparation stays default-dark and rejects mutable evidence in intent before Docker", async () => {
  const plan = await fixturePlan();
  const intent = fixturePreparationIntent(plan);
  let calls = 0;
  await assert.rejects(
    () =>
      runProductionExact0096HostPreparation(
        {
          intent,
          config: {},
          planOut: resolve("must-not-exist.json"),
          confirmation: "WRONG",
          signal: new AbortController().signal,
        },
        { execFile: async () => calls++ },
      ),
    (error) => error?.code === "PRODUCTION_BACKUP_HOST_RUNNER_DARK",
  );
  intent.schemaFingerprintSha256 = plan.value.schemaFingerprintSha256;
  await assert.rejects(
    () =>
      runProductionExact0096HostPreparation(
        {
          intent,
          config: {},
          planOut: resolve("must-not-exist.json"),
          confirmation: PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION,
          signal: new AbortController().signal,
        },
        { execFile: async () => calls++ },
      ),
    (error) => error?.code === "PRODUCTION_BACKUP_HOST_PREPARE_INTENT_INVALID",
  );
  assert.equal(calls, 0);
});

test("prepare derives and durably persists one canonical plan from read-only runtime observations", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-host-prepare-"));
  try {
    const reviewedPlan = await fixturePlan();
    const harness = await createHarness(root, reviewedPlan);
    const planOut = join(root, "prepared", "exact-0096-plan.json");
    const result = await runProductionExact0096HostPreparation(
      {
        intent: fixturePreparationIntent(reviewedPlan),
        config: harness.config,
        planOut,
        confirmation: PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION,
        signal: new AbortController().signal,
      },
      {
        execFile: harness.execFile,
        invocationId: () => "7".repeat(64),
        proofId: () => "f".repeat(64),
        hostIdentity: () => ({ uid: 1000, gid: 1000 }),
        now: () => new Date("2026-08-12T10:01:20.000Z"),
      },
    );
    assert.equal(result.productionTargetsTouched, false);
    assert.equal(result.plan.value.sourceDatabase.name, "site_logbook");
    assert.equal(
      result.plan.value.schemaFingerprintSha256,
      reviewedPlan.value.schemaFingerprintSha256,
    );
    assert.notEqual(
      result.plan.value.stoppedWritersProof.proofId,
      reviewedPlan.value.stoppedWritersProof.proofId,
    );
    assert.equal(await readFile(planOut, "utf8"), result.plan.canonical);
    assert.equal(result.persisted.sha256, result.plan.sha256);
    assert.ok(
      harness.calls.some(
        ({ args }) =>
          args[0] === "container" &&
          args[1] === "rm" &&
          args.includes("--force"),
      ),
    );
    assert.equal(
      harness.calls.some(({ args }) =>
        args.some((arg) => /restore|migration|producer\.mjs|s3/i.test(arg)),
      ),
      false,
    );
    assert.deepEqual(
      harness.workerRequests.map((request) => request.operation),
      ["observe-source", "writer-window"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepared-plan persistence is mode-0600, exact-readback and no-clobber", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-plan-persist-"));
  try {
    const target = join(root, "evidence", "plan.json");
    const canonical = canonicalProductionExact0096BackupJson({ safe: true });
    const persisted = await persistPreparedPlanExclusive(target, canonical);
    assert.equal(persisted.sha256, productionExact0096BackupSha256(canonical));
    assert.equal(await readFile(target, "utf8"), canonical);
    if (process.platform !== "win32") {
      const metadata = await import("node:fs/promises").then(({ lstat }) =>
        lstat(target),
      );
      assert.equal(metadata.mode & 0o077, 0);
    }
    await assert.rejects(
      () => persistPreparedPlanExclusive(target, canonical),
      (error) => error?.code === "EEXIST",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shipped prepare CLI creates the plan path without printing secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-prepare-cli-"));
  try {
    const reviewedPlan = await fixturePlan();
    const harness = await createHarness(root, reviewedPlan);
    const requestPath = join(root, "request.json");
    const intentPath = join(root, "intent.json");
    const planOut = join(root, "prepared", "plan.json");
    await writeFile(
      requestPath,
      canonicalProductionExact0096BackupJson(harness.config),
    );
    await writeFile(
      intentPath,
      canonicalProductionExact0096BackupJson(
        fixturePreparationIntent(reviewedPlan),
      ),
    );
    let stdout = "";
    await main(
      [
        "prepare",
        "--request",
        requestPath,
        "--intent",
        intentPath,
        "--plan-out",
        planOut,
        "--confirm",
        PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION,
      ],
      {
        execFile: harness.execFile,
        invocationId: () => "7".repeat(64),
        proofId: () => "f".repeat(64),
        hostIdentity: () => ({ uid: 1000, gid: 1000 }),
        now: () => new Date("2026-08-12T10:01:20.000Z"),
        stdout: { write: (value) => (stdout += value) },
      },
    );
    assert.equal(
      JSON.parse(await readFile(planOut, "utf8")).storageBinding.bucket,
      "modvoltdata",
    );
    assert.match(stdout, /mode=read-only-plan-preparation/);
    assert.match(stdout, /backupCreated=false/);
    assert.doesNotMatch(stdout, /hidden|DATABASE_URL|S3_SECRET/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("read-only preflight uses only image/container/network/volume inspect", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-host-preflight-"));
  try {
    const plan = await fixturePlan();
    const harness = await createHarness(root, plan);
    const result = await runProductionExact0096HostPreflight(
      { planCanonical: plan.canonical, config: harness.config },
      { execFile: harness.execFile },
    );
    assert.equal(result.ready, true);
    assert.equal(result.productionTargetsTouched, false);
    assert.ok(
      harness.calls.every(
        ({ args }) =>
          args[1] === "inspect" &&
          ["image", "container", "network", "volume"].includes(args[0]),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight source-pins exact Hetzner destination and path style before Docker", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-host-s3-preflight-"));
  try {
    const plan = await fixturePlan();
    const harness = await createHarness(root, plan);
    const original = await readFile(harness.config.secretEnvFile, "utf8");
    for (const invalid of [
      original.replace("S3_FORCE_PATH_STYLE=false\n", ""),
      original.replace("S3_FORCE_PATH_STYLE=false", "S3_FORCE_PATH_STYLE=true"),
      original.replace("S3_BUCKET=modvoltdata", "S3_BUCKET=other-bucket"),
      original.replace("S3_REGION=fsn1", "S3_REGION=nbg1"),
      original.replace(
        "S3_ENDPOINT=https://fsn1.your-objectstorage.com",
        "S3_ENDPOINT=https://nbg1.your-objectstorage.com",
      ),
    ]) {
      await writeFile(harness.config.secretEnvFile, invalid, { mode: 0o600 });
      await assert.rejects(
        () =>
          runProductionExact0096HostPreflight(
            { planCanonical: plan.canonical, config: harness.config },
            { execFile: harness.execFile },
          ),
        (error) =>
          error?.code === "PRODUCTION_BACKUP_HOST_RUNNER_SECRET_FILE_INVALID",
      );
    }
    assert.equal(harness.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("host handlers reach a real PASS receipt with fixed container lifecycle and cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "exact0096-host-execute-"));
  let lifecycleClosed = 0;
  try {
    const plan = await fixturePlan();
    const harness = await createHarness(root, plan);
    const trace = fixtureExecutorTrace(plan);
    const proofIds = ["f".repeat(64), "e".repeat(64)];
    const result = await runProductionExact0096HostExecution(
      {
        planCanonical: plan.canonical,
        config: harness.config,
        confirmation: PRODUCTION_EXACT_0096_HOST_EXECUTION_CONFIRMATION,
        signal: new AbortController().signal,
      },
      {
        execFile: harness.execFile,
        invocationId: () => "7".repeat(64),
        proofId: () => proofIds.shift(),
        hostIdentity: () => ({ uid: 1000, gid: 1000 }),
        lifecycleFactory: async () => ({
          restoreId: trace.restore.restoreId,
          startedAt: trace.restore.startedAt,
          database: trace.restore.database,
          runtimeBinding: fixtureRestoreBindingForPlan(plan),
          async close() {
            lifecycleClosed += 1;
          },
        }),
        async runComposite(input) {
          assert.equal(typeof input.hostHandlers, "function");
          const handlers = input.hostHandlers(input.signal);
          assert.deepEqual(Object.keys(handlers).sort(), [
            "observeExecutorIdentity",
            "observeImmutableProductionSourceReadOnly",
            "observeRestoredJournalSchemaAndContentReadOnly",
            "proveProductionWritersStopped",
            "reobserveProductionSourceReadOnly",
            "restoreIntoNewDisposablePostgres16",
          ]);
          return runProductionExact0096BackupEvidenceExecutor({
            planCanonical: plan.canonical,
            dependencies: {
              ...fixtureExecutorDependencies(plan),
              ...handlers,
            },
          });
        },
      },
    );
    assert.equal(result.receipt.value.decision, "PASS");
    assert.notEqual(
      result.trace.value.stoppedWritersProofBefore.proofId,
      plan.value.stoppedWritersProof.proofId,
    );
    assert.ok(
      Date.parse(result.trace.value.sourceBefore.observedAt) <=
        Date.parse(result.trace.value.stoppedWritersProofBefore.quiescentSince),
    );
    assert.equal(
      result.trace.value.sourceBefore.schemaFingerprintSha256,
      plan.value.schemaFingerprintSha256,
    );
    assert.equal(
      result.trace.value.restore.schemaFingerprintSha256,
      plan.value.schemaFingerprintSha256,
    );
    assert.equal(lifecycleClosed, 1);
    const create = harness.calls.find(
      ({ args }) => args[0] === "container" && args[1] === "create",
    );
    assert.ok(create);
    assert.equal(create.args.includes("/var/run/docker.sock"), false);
    assert.equal(create.args.includes("--env-file"), true);
    assert.equal(
      create.args.some((arg) => arg.includes("hidden")),
      false,
    );
    assert.ok(
      harness.calls.some(
        ({ args }) =>
          args[0] === "container" &&
          args[1] === "rm" &&
          args.includes("--force"),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real receipt path fails closed when measured source or restore schema drifts", async () => {
  for (const scenario of ["source", "restore"]) {
    const root = await mkdtemp(
      join(tmpdir(), `exact0096-host-${scenario}-schema-drift-`),
    );
    try {
      const plan = await fixturePlan();
      const harness = await createHarness(root, plan, {
        ...(scenario === "source"
          ? { sourceSchemaFingerprint: `sha256:${"0".repeat(64)}` }
          : { restoreSchemaFingerprint: `sha256:${"0".repeat(64)}` }),
      });
      const trace = fixtureExecutorTrace(plan);
      const proofIds = ["f".repeat(64), "e".repeat(64)];
      await assert.rejects(
        () =>
          runProductionExact0096HostExecution(
            {
              planCanonical: plan.canonical,
              config: harness.config,
              confirmation: PRODUCTION_EXACT_0096_HOST_EXECUTION_CONFIRMATION,
              signal: new AbortController().signal,
            },
            {
              execFile: harness.execFile,
              invocationId: () => "7".repeat(64),
              proofId: () => proofIds.shift(),
              hostIdentity: () => ({ uid: 1000, gid: 1000 }),
              lifecycleFactory: async () => ({
                restoreId: trace.restore.restoreId,
                startedAt: trace.restore.startedAt,
                database: trace.restore.database,
                runtimeBinding: fixtureRestoreBindingForPlan(plan),
                async close() {},
              }),
              async runComposite(input) {
                return runProductionExact0096BackupEvidenceExecutor({
                  planCanonical: plan.canonical,
                  dependencies: {
                    ...fixtureExecutorDependencies(plan),
                    ...input.hostHandlers(input.signal),
                  },
                });
              },
            },
          ),
        (error) => error?.code === "PRODUCTION_BACKUP_HOST_RUNNER_SCHEMA_DRIFT",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("frozen exact-0096 inventory remains the expected 97 plus two rows", () => {
  assert.equal(
    PRODUCTION_MIGRATION_PREFIX_STATES[0].knownAppliedMigrations,
    97,
  );
  assert.equal(PRODUCTION_MIGRATION_PREFIX_STATES[0].totalJournalRows, 99);
});

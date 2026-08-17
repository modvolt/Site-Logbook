import assert from "node:assert/strict";
import test from "node:test";
import {
  PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
  PRODUCTION_EXACT_0096_RELATION_MANIFEST,
  PRODUCTION_EXACT_0096_STORAGE_BINDING,
  canonicalProductionExact0096BackupJson,
  createProductionExact0096BackupArtifact,
  parseCanonicalProductionExact0096BackupArtifact,
  productionExact0096BackupSha256,
  validateExact0096TableSnapshot,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";
import {
  PRODUCTION_EXACT_0096_BACKUP_EXECUTOR_INTERFACE,
  createProductionExact0096BackupPlan,
  parseProductionExact0096BackupPlan,
  validateProductionExact0096BackupExecutorDependencies,
  validateProductionExact0096BackupPlan,
} from "../production-evidence/production-exact-0096-backup-planner.mjs";
import {
  createProductionExact0096BackupReceipt,
  parseProductionExact0096BackupExecutorTrace,
  parseProductionExact0096BackupReceipt,
  runProductionExact0096BackupEvidenceExecutor,
  validateProductionExact0096BackupExecutorTrace,
  validateProductionExact0096BackupReceipt,
} from "../production-evidence/production-exact-0096-backup-receipt.mjs";
import {
  fixtureExact0096Inventory,
  fixtureExecutorDependencies,
  fixtureExecutorTrace,
  fixtureExecutorTraceCanonical,
  fixtureDigest,
  fixturePlanInput,
  fixtureTableSnapshot,
} from "./production-exact-0096-backup-contract-fixtures.mjs";

async function planTraceReceipt() {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const execution = await runProductionExact0096BackupEvidenceExecutor({
    planCanonical: plan.canonical,
    dependencies: fixtureExecutorDependencies(plan),
  });
  const traceCanonical = execution.trace.canonical;
  const receipt = execution.receipt;
  return { plan, traceCanonical, receipt };
}

function traceMutation(mutate) {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const trace = fixtureExecutorTrace(plan);
  mutate(trace);
  return {
    plan,
    trace,
    canonical: canonicalProductionExact0096BackupJson(trace),
  };
}

function recomputeSnapshot(snapshot) {
  snapshot.tableMeasurementsSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(snapshot.tableMeasurements),
  );
  snapshot.dataSnapshotSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson({
      relationNamesSha256: snapshot.catalogManifest.relationNamesSha256,
      tableMeasurementsSha256: snapshot.tableMeasurementsSha256,
    }),
  );
}

test("freezes exact 97+2 journal, manifest and non-authorizing plan", () => {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  assert.equal(plan.value.baseline.knownAppliedMigrations, 97);
  assert.equal(plan.value.baseline.opaqueLegacyRowCount, 2);
  assert.equal(plan.value.baseline.totalJournalRows, 99);
  assert.equal(
    PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNames.length,
    91,
  );
  assert.equal(
    productionExact0096BackupSha256(
      JSON.stringify(PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNames),
    ),
    PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNamesSha256,
  );
  assert.equal(plan.value.authorizesProductionMigration, false);
  assert.deepEqual(
    plan.value.storageBinding,
    PRODUCTION_EXACT_0096_STORAGE_BINDING,
  );
  assert.notEqual(plan.value.liveSource.sha, plan.value.executor.buildSha);
  assert.notEqual(plan.value.liveSource.imageRef, plan.value.executor.imageRef);
  assert.equal(
    parseProductionExact0096BackupPlan(plan.canonical).sha256,
    plan.sha256,
  );
});

test("creates PASS only through the actual canonical-artifact DI executor", async () => {
  const { plan, traceCanonical, receipt } = await planTraceReceipt();
  assert.equal(receipt.value.decision, "PASS");
  assert.equal(
    receipt.value.executorTraceSha256,
    productionExact0096BackupSha256(traceCanonical),
  );
  assert.equal(receipt.value.authorizesProductionMigration, false);
  assert.equal(
    parseProductionExact0096BackupReceipt(
      receipt.canonical,
      plan.canonical,
      traceCanonical,
    ).sha256,
    receipt.sha256,
  );
  assert.throws(
    () =>
      createProductionExact0096BackupReceipt({
        planCanonical: plan.canonical,
        executorTraceCanonical: fixtureExecutorTraceCanonical(plan),
      }),
    /EXECUTOR_TRACE_REQUIRED/,
  );
});

test("DI boundary is executable-function shaped and includes streaming overflow cleanup", () => {
  const dependencies = Object.fromEntries(
    PRODUCTION_EXACT_0096_BACKUP_EXECUTOR_INTERFACE.methods.map((method) => [
      method,
      async () => undefined,
    ]),
  );
  assert.equal(
    validateProductionExact0096BackupExecutorDependencies(dependencies)
      .persistReceiptExclusive,
    dependencies.persistReceiptExclusive,
  );
  assert.match(
    PRODUCTION_EXACT_0096_BACKUP_EXECUTOR_INTERFACE.streamingCeilingCall,
    /terminateProducerOnOverflow:true/,
  );
  delete dependencies.headExactVersionedPayloadReadOnly;
  assert.throws(
    () => validateProductionExact0096BackupExecutorDependencies(dependencies),
    /EXECUTOR_INVALID/,
  );
});

test("DI executor passes the ceiling into the write and stops before HEAD on overflow", async () => {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const dependencies = fixtureExecutorDependencies(plan);
  const trace = fixtureExecutorTrace(plan);
  let writeInput;
  let headCalled = false;
  let tracePersistCalled = false;
  dependencies.encryptAndPersistVersionedPayload = async (input) => {
    writeInput = input;
    const overflow = structuredClone(trace.payloadWrite);
    overflow.status = "overflow-rejected";
    overflow.payload = null;
    overflow.guard.bytesRead =
      PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES + 1;
    overflow.guard.overflowDetected = true;
    overflow.guard.producerTerminated = true;
    overflow.guard.objectCreated = false;
    overflow.guard.partialObjectDeleted = true;
    return canonicalProductionExact0096BackupJson(overflow);
  };
  dependencies.headExactVersionedPayloadReadOnly = async () => {
    headCalled = true;
    throw new Error("must not run");
  };
  dependencies.emitCanonicalExecutorTraceExclusive = async () => {
    tracePersistCalled = true;
    throw new Error("must not run");
  };
  await assert.rejects(
    () =>
      runProductionExact0096BackupEvidenceExecutor({
        planCanonical: plan.canonical,
        dependencies,
      }),
    /STREAMING_OVERFLOW_REJECTED/,
  );
  assert.deepEqual(
    {
      dumpId: writeInput.dumpId,
      ceilingBytes: writeInput.ceilingBytes,
      enforcement: writeInput.enforcement,
      abortWriteOnOverflow: writeInput.abortWriteOnOverflow,
      terminateProducerOnOverflow: writeInput.terminateProducerOnOverflow,
      deletePartialObjectOnOverflow: writeInput.deletePartialObjectOnOverflow,
    },
    {
      dumpId: trace.dump.dumpId,
      ceilingBytes: PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
      enforcement: "streaming-before-write",
      abortWriteOnOverflow: true,
      terminateProducerOnOverflow: true,
      deletePartialObjectOnOverflow: true,
    },
  );
  assert.equal(headCalled, false);
  assert.equal(tracePersistCalled, false);
});

test("DI executor never returns a receipt without exact exclusive trace persistence", async () => {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  const dependencies = fixtureExecutorDependencies(plan);
  let receiptPersistCalled = false;
  dependencies.emitCanonicalExecutorTraceExclusive = async ({
    traceCanonical,
  }) =>
    canonicalProductionExact0096BackupJson({
      artifactSha256: productionExact0096BackupSha256(traceCanonical),
      canonicalReadbackBytes: Buffer.byteLength(traceCanonical),
      canonicalReadbackSha256: productionExact0096BackupSha256(traceCanonical),
      existingTargetObserved: false,
      persistedExclusive: false,
      storageIdentitySha256: fixtureDigest("6"),
    });
  dependencies.persistReceiptExclusive = async () => {
    receiptPersistCalled = true;
    throw new Error("must not run");
  };
  await assert.rejects(
    () =>
      runProductionExact0096BackupEvidenceExecutor({
        planCanonical: plan.canonical,
        dependencies,
      }),
    /EXCLUSIVE_PERSISTENCE_FAILED/,
  );
  assert.equal(receiptPersistCalled, false);
});

test("canonical parsers and creators share the exact 512 KiB ceiling", () => {
  const small = createProductionExact0096BackupArtifact({ note: "safe" });
  assert.equal(
    parseCanonicalProductionExact0096BackupArtifact(small.canonical, "small")
      .sha256,
    small.sha256,
  );
  assert.throws(
    () =>
      createProductionExact0096BackupArtifact({ note: "x".repeat(600_000) }),
    /ARTIFACT_INVALID/,
  );
});

test("rejects canonical artifacts containing credentials or private key material", () => {
  for (const value of [
    { networkName: "postgresql://admin:supersecret@prod/db" },
    { note: "-----BEGIN PRIVATE KEY-----" },
    { databaseUrl: "redacted" },
    { accessToken: "redacted" },
  ]) {
    assert.throws(
      () => createProductionExact0096BackupArtifact(value),
      /SECRET_REJECTED/,
    );
  }
});

test("rejects staging identities, mutable refs and non-identifiers", () => {
  for (const mutate of [
    (input) => {
      input.sourceDatabase.name = "site_logbook_staging";
    },
    (input) => {
      input.runtimeBinding.applicationImageRef =
        "ghcr.io/modvolt/site-logbook-api:latest";
    },
    (input) => {
      input.runtimeBinding.networkName = "production network with spaces";
    },
    (input) => {
      input.liveSource.sha = input.liveSource.sha.toUpperCase();
    },
    (input) => {
      input.runtimeBinding.applicationImageRef =
        input.runtimeBinding.applicationImageRef.toUpperCase();
    },
    (input) => {
      input.executor.imageRef = "ghcr.io/modvolt/control-plane:latest";
    },
  ]) {
    const input = fixturePlanInput();
    mutate(input);
    assert.throws(() => createProductionExact0096BackupPlan(input));
  }
});

test("rejects opaque drift, 0100, another prefix and unexpected rows", () => {
  for (const mutate of [
    (inventory) => {
      inventory.opaqueLegacyRows[0].hash = "f".repeat(64);
    },
    (inventory) => {
      inventory.excludedMigration0100Present = true;
    },
    (inventory) => {
      inventory.unexpectedKnownMigrationTags = ["0999_unknown"];
    },
  ]) {
    const input = fixturePlanInput();
    mutate(input.baselineInventory);
    assert.throws(
      () => createProductionExact0096BackupPlan(input),
      /BASELINE_INVALID/,
    );
  }
  const later = fixturePlanInput();
  later.baselineInventory = fixtureExact0096Inventory(1);
  assert.throws(
    () => createProductionExact0096BackupPlan(later),
    /BASELINE_INVALID/,
  );
});

test("writers proof is fresh and bound to exact source, runtime and database", () => {
  for (const mutate of [
    (input) => {
      input.createdAt = "2026-08-12T10:04:01.000Z";
    },
    (input) => {
      input.stoppedWritersProof.sourceSha = "b".repeat(40);
    },
    (input) => {
      input.stoppedWritersProof.runtimeBindingSha256 = `sha256:${"b".repeat(64)}`;
    },
    (input) => {
      input.stoppedWritersProof.databaseIdentitySha256 = `sha256:${"c".repeat(64)}`;
    },
  ]) {
    const input = fixturePlanInput();
    mutate(input);
    assert.throws(() => createProductionExact0096BackupPlan(input));
  }
});

test("execution rejects plan-proof replay and source/proof chronology drift", () => {
  for (const mutate of [
    (trace, plan) => {
      trace.stoppedWritersProofBefore = structuredClone(
        plan.value.stoppedWritersProof,
      );
    },
    (trace) => {
      trace.stoppedWritersProofBefore.quiescentSince =
        "2026-08-12T10:00:00.000Z";
    },
    (trace) => {
      trace.sourceBefore.observedAt = "2026-08-12T09:59:59.000Z";
    },
  ]) {
    const plan = createProductionExact0096BackupPlan(fixturePlanInput());
    const trace = fixtureExecutorTrace(plan);
    mutate(trace, plan);
    assert.throws(
      () =>
        validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
      /WRITERS_PROOF_INVALID/,
    );
  }
});

test("requires the exact frozen relation set and deterministic content digest per relation", () => {
  const valid = fixtureTableSnapshot();
  assert.equal(
    validateExact0096TableSnapshot(valid, "snapshot").catalogManifest
      .relationNames.length,
    91,
  );
  for (const mutate of [
    (snapshot) => {
      delete snapshot.tableMeasurements["public.users"];
    },
    (snapshot) => {
      snapshot.catalogManifest.relationNames.pop();
    },
    (snapshot) => {
      snapshot.tableMeasurements["public.users"].contentSha256 =
        `sha256:${"1".repeat(64)}`;
    },
    (snapshot) => {
      snapshot.exportedSnapshotUsed = false;
    },
  ]) {
    const snapshot = fixtureTableSnapshot();
    mutate(snapshot);
    assert.throws(() => validateExact0096TableSnapshot(snapshot, "snapshot"));
  }
});

test("binds dump to the exported snapshot token and overall data snapshot", () => {
  for (const mutate of [
    (trace) => {
      trace.dump.snapshotTokenSha256 = `sha256:${"1".repeat(64)}`;
    },
    (trace) => {
      trace.dump.sourceDataSnapshotSha256 = `sha256:${"2".repeat(64)}`;
    },
    (trace) => {
      trace.dump.plaintextBytes =
        PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES + 1;
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(() =>
      validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
    );
  }
});

test("binds live source and executor identities independently", () => {
  for (const mutate of [
    (trace) => {
      trace.producer.buildSha = trace.sourceBefore.runtimeBinding.sourceSha;
    },
    (trace) => {
      trace.producer.executorImageRef =
        trace.sourceBefore.runtimeBinding.applicationImageRef;
    },
    (trace) => {
      trace.restore.runtimeBinding.executorImageRef =
        trace.sourceBefore.runtimeBinding.applicationImageRef;
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(
      () =>
        validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
      /EXECUTOR_INVALID|RESTORE_NOT_DISPOSABLE/,
    );
  }
});

test("streaming overflow terminates producer, removes partial object and can never PASS", () => {
  const { plan, trace } = traceMutation((candidate) => {
    candidate.payloadWrite.status = "overflow-rejected";
    candidate.payloadWrite.payload = null;
    candidate.payloadWrite.guard.bytesRead =
      PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES + 1;
    candidate.payloadWrite.guard.overflowDetected = true;
    candidate.payloadWrite.guard.producerTerminated = true;
    candidate.payloadWrite.guard.objectCreated = false;
    candidate.payloadWrite.guard.partialObjectDeleted = true;
  });
  assert.throws(
    () =>
      parseProductionExact0096BackupExecutorTrace(
        canonicalProductionExact0096BackupJson(trace),
        plan.canonical,
      ),
    /STREAMING_OVERFLOW_REJECTED/,
  );
  trace.payloadWrite.guard.partialObjectDeleted = false;
  assert.throws(
    () => validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
    /STREAMING_CEILING_INVALID/,
  );
});

test("binds exact bucket, key, version, HEAD size/digest and Hetzner identity", () => {
  for (const mutate of [
    (trace) => {
      trace.payloadWrite.payload.object.bucket = "Site Logbook";
    },
    (trace) => {
      trace.payloadWrite.payload.object.bucket = "other-valid-bucket";
    },
    (trace) => {
      trace.payloadWrite.payload.object.key = "other/backup.enc";
    },
    (trace) => {
      trace.payloadWrite.payload.object.key =
        "private/production/exact-0096/../other.enc";
    },
    (trace) => {
      trace.payloadWrite.payload.object.versionId = "null";
    },
    (trace) => {
      trace.payloadWrite.payload.object.headContentLength += 1;
    },
    (trace) => {
      trace.payloadWrite.payload.object.headEtag = "not-an-etag";
    },
    (trace) => {
      trace.payloadWrite.payload.object.storageProvider.kind = "minio";
    },
    (trace) => {
      trace.payloadWrite.payload.object.storageProvider.endpointOriginSha256 = `sha256:${"0".repeat(64)}`;
    },
    (trace) => {
      trace.payloadWrite.payload.object.storageProvider.region = "nbg1";
    },
    (trace) => {
      trace.payloadWrite.payload.object.storageProvider.transport = "http";
    },
    (trace) => {
      trace.payloadWrite.payload.object.storageProvider.versioning =
        "suspended";
    },
    (trace) => {
      trace.payloadWrite.payload.envelopeKeyVersionId = "";
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(() =>
      validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
    );
  }
});

test("plan parser rejects any substituted exact storage destination", () => {
  const plan = createProductionExact0096BackupPlan(fixturePlanInput());
  for (const mutate of [
    (value) => {
      value.storageBinding.bucket = "other-valid-bucket";
    },
    (value) => {
      value.storageBinding.endpoint = "https://nbg1.your-objectstorage.com";
    },
    (value) => {
      value.storageBinding.region = "nbg1";
    },
    (value) => {
      value.storageBinding.objectPrefix = "private/other/";
    },
  ]) {
    const value = structuredClone(plan.value);
    mutate(value);
    assert.throws(
      () => validateProductionExact0096BackupPlan(value),
      /STORAGE_BINDING_INVALID/,
    );
  }
});

test("restore uses the exact object and matches every count and content digest", () => {
  for (const mutate of [
    (trace) => {
      trace.restore.backupObject.versionId = "s3-version-other";
    },
    (trace) => {
      trace.restore.tableSnapshot.tableMeasurements["public.users"].rowCount +=
        1;
      recomputeSnapshot(trace.restore.tableSnapshot);
    },
    (trace) => {
      trace.restore.tableSnapshot.tableMeasurements[
        "public.users"
      ].contentSha256 = `sha256:${"2".repeat(64)}`;
      recomputeSnapshot(trace.restore.tableSnapshot);
    },
    (trace) => {
      trace.restore.runtimeBinding.volumeName =
        trace.sourceBefore.runtimeBinding.volumeName;
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(() =>
      validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
    );
  }
});

test("source-after requires exact content re-snapshot and a distinct fresh second writer proof", () => {
  for (const mutate of [
    (trace) => {
      trace.sourceAfter.tableSnapshot.tableMeasurements[
        "public.users"
      ].contentSha256 = `sha256:${"3".repeat(64)}`;
      recomputeSnapshot(trace.sourceAfter.tableSnapshot);
    },
    (trace) => {
      trace.sourceAfter.stoppedWritersProof.proofId =
        trace.stoppedWritersProofBefore.proofId;
    },
    (trace) => {
      trace.sourceAfter.stoppedWritersProof.observedAt =
        "2026-08-12T10:10:00.000Z";
      trace.sourceAfter.observedAt = "2026-08-12T10:10:00.000Z";
    },
    (trace) => {
      trace.sourceAfter.runtimeBinding.containerId = "4".repeat(64);
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(() =>
      validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
    );
  }
});

test("ordered trace steps bind each exact raw producer artifact", () => {
  for (const mutate of [
    (trace) => {
      trace.steps[3].sequence = 5;
    },
    (trace) => {
      trace.steps[4].artifactSha256 = `sha256:${"5".repeat(64)}`;
    },
    (trace) => {
      trace.steps[5].occurredAt = "2026-08-12T09:00:00.000Z";
    },
  ]) {
    const { plan, trace } = traceMutation(mutate);
    assert.throws(
      () =>
        validateProductionExact0096BackupExecutorTrace(trace, plan.canonical),
      /EXECUTOR_TRACE_INVALID/,
    );
  }
});

test("receipt cannot substitute another plan, trace or migration authorization", async () => {
  const { plan, traceCanonical, receipt } = await planTraceReceipt();
  const forged = structuredClone(receipt.value);
  forged.authorizesProductionMigration = true;
  assert.throws(() =>
    validateProductionExact0096BackupReceipt(
      forged,
      plan.canonical,
      traceCanonical,
    ),
  );
  const otherInput = fixturePlanInput();
  otherInput.operationId = "prod-backup-op-20260813";
  const otherPlan = createProductionExact0096BackupPlan(otherInput);
  assert.throws(() =>
    parseProductionExact0096BackupReceipt(
      receipt.canonical,
      otherPlan.canonical,
      traceCanonical,
    ),
  );
  const changedTrace = JSON.parse(traceCanonical);
  changedTrace.producer.invocationId = "8".repeat(64);
  assert.throws(() =>
    validateProductionExact0096BackupReceipt(
      receipt.value,
      plan.canonical,
      canonicalProductionExact0096BackupJson(changedTrace),
    ),
  );
});

test("unreviewed fields and non-canonical trace JSON fail closed", async () => {
  const { plan, traceCanonical } = await planTraceReceipt();
  assert.throws(
    () =>
      parseProductionExact0096BackupExecutorTrace(
        JSON.stringify(JSON.parse(traceCanonical)),
        plan.canonical,
      ),
    /ARTIFACT_INVALID/,
  );
  const extra = structuredClone(plan.value);
  extra.allowWrite = false;
  assert.throws(
    () => validateProductionExact0096BackupPlan(extra),
    /SCHEMA_INVALID/,
  );
});

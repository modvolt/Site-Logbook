import {
  PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA,
  PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA,
  PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
  PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID,
  PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS,
  canonicalProductionExact0096BackupJson,
  createProductionExact0096BackupArtifact,
  exactBackupDigest,
  exactBackupHexId,
  exactBackupId,
  exactBackupImmutableImage,
  exactBackupObject,
  exactBackupPositiveInteger,
  exactBackupSourceSha,
  exactBackupString,
  exactBackupTimestamp,
  exactBackupVersionId,
  parseCanonicalProductionExact0096BackupArtifact,
  productionExact0096BackupFail,
  productionExact0096BackupSha256,
  rejectBackupStagingIdentity,
  validateExact0096ProductionInventory,
  validateExact0096TableSnapshot,
  validateProductionBackupSafety,
  validateProductionImmutableRuntimeBinding,
  validateProductionSourceDatabase,
  validateStoppedWritersProof,
} from "./production-exact-0096-backup-contract.mjs";
import {
  parseProductionExact0096BackupPlan,
  validateProductionExact0096BackupExecutorDependencies,
} from "./production-exact-0096-backup-planner.mjs";

const PRODUCER_ISSUED_TRACE_ARTIFACTS = new WeakSet();

const TRACE_FIELDS = [
  "completedAt",
  "kind",
  "operationId",
  "payloadWrite",
  "planSha256",
  "producer",
  "restore",
  "safety",
  "schemaVersion",
  "sourceAfter",
  "sourceBefore",
  "sourceSnapshot",
  "steps",
  "stoppedWritersProofBefore",
  "dump",
];
const RECEIPT_FIELDS = [
  "authorizesProductionMigration",
  "completedAt",
  "decision",
  "executorTraceSha256",
  "kind",
  "operationId",
  "payload",
  "planSha256",
  "productionTargetsTouched",
  "restore",
  "safety",
  "schemaVersion",
  "sourceAfter",
  "sourceBefore",
  "sourceSnapshot",
];
const TRACE_STEP_KINDS = Object.freeze([
  "observe-source-before",
  "prove-writers-stopped-before",
  "capture-source-snapshot",
  "create-bounded-dump",
  "encrypt-persist-and-head-version",
  "restore-and-observe-disposable",
  "reobserve-source-and-writers",
]);
const BUCKET = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const OBJECT_KEY =
  /^private\/production\/exact-0096\/[A-Za-z0-9][A-Za-z0-9._/-]{7,511}$/;
const ETAG = /^"[0-9a-f]{32,64}(?:-[1-9][0-9]*)?"$/;

function sameCanonical(left, right) {
  return (
    canonicalProductionExact0096BackupJson(left) ===
    canonicalProductionExact0096BackupJson(right)
  );
}

function canonicalDigest(value) {
  return productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(value),
  );
}

function validateProducer(value, plan) {
  const producer = exactBackupObject(
    value,
    ["buildSha", "executorImageRef", "invocationId", "kind", "schemaVersion"],
    "trace.producer",
  );
  if (
    producer.schemaVersion !== "site-logbook.production-backup-executor/v1" ||
    producer.kind !== "production-exact-0096-backup-executor" ||
    exactBackupSourceSha(producer.buildSha, "trace.producer.buildSha") !==
      plan.executor.buildSha ||
    exactBackupImmutableImage(
      producer.executorImageRef,
      "trace.producer.executorImageRef",
    ) !== plan.executor.imageRef
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_INVALID",
      "Trace producer must be the exact immutable reviewed executor build, independently of the live source build.",
    );
  }
  exactBackupHexId(producer.invocationId, "trace.producer.invocationId");
  return Object.freeze({ ...producer });
}

function validateSourceBefore(value, plan) {
  const before = exactBackupObject(
    value,
    [
      "database",
      "inventory",
      "observedAt",
      "runtimeBinding",
      "schemaFingerprintSha256",
    ],
    "trace.sourceBefore",
  );
  const database = validateProductionSourceDatabase(
    before.database,
    "trace.sourceBefore.database",
  );
  validateExact0096ProductionInventory(
    before.inventory,
    "trace.sourceBefore.inventory",
  );
  const runtime = validateProductionImmutableRuntimeBinding(
    before.runtimeBinding,
    "trace.sourceBefore.runtimeBinding",
  );
  exactBackupTimestamp(before.observedAt, "trace.sourceBefore.observedAt");
  exactBackupDigest(
    before.schemaFingerprintSha256,
    "trace.sourceBefore.schemaFingerprintSha256",
  );
  if (
    !sameCanonical(database, plan.sourceDatabase) ||
    !sameCanonical(runtime, plan.runtimeBinding) ||
    before.schemaFingerprintSha256 !== plan.schemaFingerprintSha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SOURCE_BINDING_INVALID",
      "Executor source observation must match the exact reviewed plan.",
    );
  }
  return Object.freeze({ ...before, database, runtimeBinding: runtime });
}

function validateDump(value, plan, sourceSnapshot) {
  const dump = exactBackupObject(
    value,
    [
      "backupFormat",
      "completedAt",
      "dumpId",
      "exitCode",
      "pgDumpMajor",
      "plaintextBytes",
      "plaintextSha256",
      "snapshotTokenSha256",
      "sourceDataSnapshotSha256",
    ],
    "trace.dump",
  );
  if (
    dump.backupFormat !== "pg_dump-custom" ||
    dump.pgDumpMajor !== 16 ||
    dump.exitCode !== 0 ||
    dump.snapshotTokenSha256 !== sourceSnapshot.snapshotTokenSha256 ||
    dump.sourceDataSnapshotSha256 !== sourceSnapshot.dataSnapshotSha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_DUMP_INVALID",
      "Dump must be a successful PostgreSQL 16 custom dump from the exact exported snapshot.",
    );
  }
  exactBackupId(dump.dumpId, "trace.dump.dumpId");
  exactBackupTimestamp(dump.completedAt, "trace.dump.completedAt");
  exactBackupPositiveInteger(
    dump.plaintextBytes,
    "trace.dump.plaintextBytes",
    plan.payloadCeilingBytes,
  );
  exactBackupDigest(dump.plaintextSha256, "trace.dump.plaintextSha256");
  return Object.freeze({ ...dump });
}

function validateVersionedObject(value, payload, plan) {
  const object = exactBackupObject(
    value,
    [
      "bucket",
      "headContentLength",
      "headEtag",
      "headObjectSha256Metadata",
      "headObservedAt",
      "key",
      "storageProvider",
      "versionId",
    ],
    "trace.payloadWrite.payload.object",
  );
  const bucket = rejectBackupStagingIdentity(
    object.bucket,
    "trace.payloadWrite.payload.object.bucket",
  );
  const key = exactBackupString(
    object.key,
    "trace.payloadWrite.payload.object.key",
    512,
  );
  if (
    !BUCKET.test(bucket) ||
    bucket !== plan.storageBinding.bucket ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bucket) ||
    !OBJECT_KEY.test(key) ||
    !key.startsWith(plan.storageBinding.objectPrefix) ||
    key.split("/").some((segment) => ["", ".", ".."].includes(segment)) ||
    object.headContentLength !== payload.encryptedPayloadBytes ||
    object.headObjectSha256Metadata !== payload.encryptedPayloadSha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Versioned object HEAD must bind exact bucket/key/version/size/digest and Hetzner provider identity.",
    );
  }
  exactBackupVersionId(
    object.versionId,
    "trace.payloadWrite.payload.object.versionId",
  );
  const storageProvider = exactBackupObject(
    object.storageProvider,
    [
      "endpointOriginSha256",
      "kind",
      "region",
      "encryptionBoundary",
      "transport",
      "versioning",
    ],
    "trace.payloadWrite.payload.object.storageProvider",
  );
  if (
    storageProvider.kind !== "hetzner-object-storage" ||
    storageProvider.region !== plan.storageBinding.region ||
    storageProvider.endpointOriginSha256 !==
      plan.storageBinding.endpointOriginSha256 ||
    storageProvider.encryptionBoundary !== "client-envelope-only" ||
    storageProvider.transport !== "https" ||
    storageProvider.versioning !== "enabled"
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Exact production object evidence requires the canonical HTTPS Hetzner Object Storage binding with versioning enabled.",
    );
  }
  exactBackupDigest(
    storageProvider.endpointOriginSha256,
    "trace.payloadWrite.payload.object.storageProvider.endpointOriginSha256",
  );
  exactBackupTimestamp(
    object.headObservedAt,
    "trace.payloadWrite.payload.object.headObservedAt",
  );
  if (
    !ETAG.test(
      exactBackupString(
        object.headEtag,
        "trace.payloadWrite.payload.object.headEtag",
        80,
      ),
    )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Object HEAD ETag is not exact canonical evidence.",
    );
  }
  if (
    object.headContentLength > plan.payloadCeilingBytes ||
    exactBackupTimestamp(
      object.headObservedAt,
      "trace.payloadWrite.payload.object.headObservedAt",
    ) <
      exactBackupTimestamp(
        payload.createdAt,
        "trace.payloadWrite.payload.createdAt",
      )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Object HEAD does not match payload key version or byte ceiling.",
    );
  }
  return Object.freeze({
    ...object,
    storageProvider: Object.freeze({ ...storageProvider }),
  });
}

function validatePayloadWrite(value, plan, dump, sourceSnapshot) {
  const write = exactBackupObject(
    value,
    ["guard", "payload", "status"],
    "trace.payloadWrite",
  );
  const guard = exactBackupObject(
    write.guard,
    [
      "abortWriteOnOverflow",
      "bytesRead",
      "ceilingBytes",
      "deletePartialObjectOnOverflow",
      "enforcement",
      "objectCreated",
      "overflowDetected",
      "partialObjectDeleted",
      "producerTerminated",
      "terminateProducerOnOverflow",
    ],
    "trace.payloadWrite.guard",
  );
  if (
    guard.ceilingBytes !== plan.payloadCeilingBytes ||
    guard.enforcement !== "streaming-before-write" ||
    guard.abortWriteOnOverflow !== true ||
    guard.terminateProducerOnOverflow !== true ||
    guard.deletePartialObjectOnOverflow !== true ||
    !Number.isSafeInteger(guard.bytesRead) ||
    guard.bytesRead < 1
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_STREAMING_CEILING_INVALID",
      "Streaming guard configuration or observation is invalid.",
    );
  }
  if (guard.overflowDetected === true) {
    if (
      write.status !== "overflow-rejected" ||
      write.payload !== null ||
      guard.bytesRead !== plan.payloadCeilingBytes + 1 ||
      guard.producerTerminated !== true ||
      guard.objectCreated !== false ||
      guard.partialObjectDeleted !== true
    ) {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_STREAMING_CEILING_INVALID",
        "Overflow must terminate the producer and leave no object.",
      );
    }
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_STREAMING_OVERFLOW_REJECTED",
      "Overflow trace is terminal and can never produce a PASS receipt.",
    );
  }
  if (
    write.status !== "persisted" ||
    guard.producerTerminated !== false ||
    guard.objectCreated !== true ||
    guard.partialObjectDeleted !== false ||
    !write.payload
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_STREAMING_CEILING_INVALID",
      "Successful write must be bounded and durably object-backed.",
    );
  }
  const payload = exactBackupObject(
    write.payload,
    [
      "backupFormat",
      "backupId",
      "createdAt",
      "encryptedPayloadBytes",
      "encryptedPayloadSha256",
      "encryptionAlgorithm",
      "envelopeKeyVersionId",
      "object",
      "pgDumpMajor",
      "sourceDataSnapshotSha256",
      "sourceDumpSha256",
    ],
    "trace.payloadWrite.payload",
  );
  exactBackupId(payload.backupId, "trace.payloadWrite.payload.backupId");
  exactBackupVersionId(
    payload.envelopeKeyVersionId,
    "trace.payloadWrite.payload.envelopeKeyVersionId",
  );
  exactBackupTimestamp(
    payload.createdAt,
    "trace.payloadWrite.payload.createdAt",
  );
  exactBackupPositiveInteger(
    payload.encryptedPayloadBytes,
    "trace.payloadWrite.payload.encryptedPayloadBytes",
    PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
  );
  exactBackupDigest(
    payload.encryptedPayloadSha256,
    "trace.payloadWrite.payload.encryptedPayloadSha256",
  );
  if (
    payload.backupFormat !== "pg_dump-custom" ||
    payload.pgDumpMajor !== 16 ||
    payload.encryptionAlgorithm !== "aes-256-gcm-envelope" ||
    payload.sourceDumpSha256 !== dump.plaintextSha256 ||
    payload.sourceDataSnapshotSha256 !== sourceSnapshot.dataSnapshotSha256 ||
    guard.bytesRead !== payload.encryptedPayloadBytes ||
    exactBackupTimestamp(
      payload.createdAt,
      "trace.payloadWrite.payload.createdAt",
    ) < exactBackupTimestamp(dump.completedAt, "trace.dump.completedAt")
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_PAYLOAD_INVALID",
      "Encrypted payload must bind the exact dump, snapshot and streaming byte count.",
    );
  }
  const object = validateVersionedObject(payload.object, payload, plan);
  return Object.freeze({
    ...write,
    guard: Object.freeze({ ...guard }),
    payload: Object.freeze({ ...payload, object }),
  });
}

function validateDisposableRestoreRuntime(value, plan) {
  const binding = exactBackupObject(
    value,
    [
      "containerId",
      "executorImageRef",
      "networkId",
      "networkName",
      "postgresImageId",
      "postgresImageRef",
      "resolvedConfigSha256",
      "volumeCreatedAt",
      "volumeLabelsSha256",
      "volumeName",
    ],
    "trace.restore.runtimeBinding",
  );
  exactBackupHexId(
    binding.containerId,
    "trace.restore.runtimeBinding.containerId",
  );
  exactBackupHexId(binding.networkId, "trace.restore.runtimeBinding.networkId");
  exactBackupImmutableImage(
    binding.executorImageRef,
    "trace.restore.runtimeBinding.executorImageRef",
  );
  exactBackupImmutableImage(
    binding.postgresImageRef,
    "trace.restore.runtimeBinding.postgresImageRef",
  );
  exactBackupDigest(
    binding.postgresImageId,
    "trace.restore.runtimeBinding.postgresImageId",
  );
  exactBackupDigest(
    binding.resolvedConfigSha256,
    "trace.restore.runtimeBinding.resolvedConfigSha256",
  );
  exactBackupDigest(
    binding.volumeLabelsSha256,
    "trace.restore.runtimeBinding.volumeLabelsSha256",
  );
  exactBackupId(
    rejectBackupStagingIdentity(
      binding.networkName,
      "trace.restore.runtimeBinding.networkName",
    ),
    "trace.restore.runtimeBinding.networkName",
  );
  exactBackupId(
    rejectBackupStagingIdentity(
      binding.volumeName,
      "trace.restore.runtimeBinding.volumeName",
    ),
    "trace.restore.runtimeBinding.volumeName",
  );
  exactBackupTimestamp(
    binding.volumeCreatedAt,
    "trace.restore.runtimeBinding.volumeCreatedAt",
  );
  if (
    binding.executorImageRef !== plan.executor.imageRef ||
    binding.containerId === plan.runtimeBinding.containerId ||
    binding.networkId === plan.runtimeBinding.networkId ||
    binding.volumeName === plan.runtimeBinding.volumeName
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RESTORE_NOT_DISPOSABLE",
      "Restore must use new container, network and volume identities.",
    );
  }
  return Object.freeze({ ...binding });
}

function validateRestore(value, { plan, payload, sourceSnapshot, dump }) {
  const restore = exactBackupObject(
    value,
    [
      "backupObject",
      "completedAt",
      "database",
      "destructiveRestore",
      "encryptedPayloadSha256",
      "environmentId",
      "inventory",
      "newDisposableDatabase",
      "pgRestoreExitCode",
      "productionDatabaseWrites",
      "productionSourceAttached",
      "restoreId",
      "retentionPrune",
      "runtimeBinding",
      "schemaFingerprintSha256",
      "sourceDataSnapshotSha256",
      "sourceDumpSha256",
      "startedAt",
      "tableSnapshot",
    ],
    "trace.restore",
  );
  exactBackupId(restore.restoreId, "trace.restore.restoreId");
  const startedAt = exactBackupTimestamp(
    restore.startedAt,
    "trace.restore.startedAt",
  );
  const completedAt = exactBackupTimestamp(
    restore.completedAt,
    "trace.restore.completedAt",
  );
  const database = validateProductionSourceDatabase(
    restore.database,
    "trace.restore.database",
  );
  const runtime = validateDisposableRestoreRuntime(
    restore.runtimeBinding,
    plan,
  );
  const tableSnapshot = validateExact0096TableSnapshot(
    restore.tableSnapshot,
    "trace.restore.tableSnapshot",
  );
  validateExact0096ProductionInventory(
    restore.inventory,
    "trace.restore.inventory",
  );
  exactBackupDigest(
    restore.encryptedPayloadSha256,
    "trace.restore.encryptedPayloadSha256",
  );
  exactBackupDigest(restore.sourceDumpSha256, "trace.restore.sourceDumpSha256");
  exactBackupDigest(
    restore.sourceDataSnapshotSha256,
    "trace.restore.sourceDataSnapshotSha256",
  );
  if (
    restore.environmentId !== PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID ||
    restore.newDisposableDatabase !== true ||
    restore.productionSourceAttached !== false ||
    restore.pgRestoreExitCode !== 0 ||
    restore.productionDatabaseWrites !== false ||
    restore.destructiveRestore !== false ||
    restore.retentionPrune !== false ||
    !sameCanonical(restore.backupObject, payload.object) ||
    restore.encryptedPayloadSha256 !== payload.encryptedPayloadSha256 ||
    restore.sourceDumpSha256 !== dump.plaintextSha256 ||
    restore.sourceDataSnapshotSha256 !== sourceSnapshot.dataSnapshotSha256 ||
    restore.schemaFingerprintSha256 !== plan.schemaFingerprintSha256 ||
    tableSnapshot.dataSnapshotSha256 !== sourceSnapshot.dataSnapshotSha256 ||
    !sameCanonical(
      tableSnapshot.tableMeasurements,
      sourceSnapshot.tableMeasurements,
    ) ||
    database.name === plan.sourceDatabase.name ||
    completedAt < startedAt ||
    startedAt <
      exactBackupTimestamp(
        payload.object.headObservedAt,
        "trace.payloadWrite.payload.object.headObservedAt",
      ) ||
    exactBackupTimestamp(
      tableSnapshot.observedAt,
      "trace.restore.tableSnapshot.observedAt",
    ) < startedAt ||
    exactBackupTimestamp(
      tableSnapshot.observedAt,
      "trace.restore.tableSnapshot.observedAt",
    ) > completedAt
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RESTORE_INVALID",
      "Restore must prove exact object-bound content parity in a new disposable PostgreSQL 16 target.",
    );
  }
  return Object.freeze({
    ...restore,
    database,
    runtimeBinding: runtime,
    tableSnapshot,
  });
}

function validateSourceAfter(
  value,
  { plan, sourceBefore, sourceSnapshot, restore, traceCompletedAt },
) {
  const after = exactBackupObject(
    value,
    [
      "inventory",
      "observedAt",
      "productionDatabaseWrites",
      "runtimeBinding",
      "schemaFingerprintSha256",
      "stoppedWritersProof",
      "stoppedWritersProofSha256",
      "tableSnapshot",
    ],
    "trace.sourceAfter",
  );
  validateExact0096ProductionInventory(
    after.inventory,
    "trace.sourceAfter.inventory",
  );
  const runtime = validateProductionImmutableRuntimeBinding(
    after.runtimeBinding,
    "trace.sourceAfter.runtimeBinding",
  );
  const writers = validateStoppedWritersProof(
    after.stoppedWritersProof,
    "trace.sourceAfter.stoppedWritersProof",
  );
  const snapshot = validateExact0096TableSnapshot(
    after.tableSnapshot,
    "trace.sourceAfter.tableSnapshot",
  );
  const observedAt = exactBackupTimestamp(
    after.observedAt,
    "trace.sourceAfter.observedAt",
  );
  const proofObservedAt = exactBackupTimestamp(
    writers.observedAt,
    "trace.sourceAfter.stoppedWritersProof.observedAt",
  );
  const restoreCompletedAt = exactBackupTimestamp(
    restore.completedAt,
    "trace.restore.completedAt",
  );
  if (
    after.productionDatabaseWrites !== false ||
    after.schemaFingerprintSha256 !== plan.schemaFingerprintSha256 ||
    !sameCanonical(after.inventory, sourceBefore.inventory) ||
    !sameCanonical(runtime, plan.runtimeBinding) ||
    snapshot.dataSnapshotSha256 !== sourceSnapshot.dataSnapshotSha256 ||
    !sameCanonical(
      snapshot.tableMeasurements,
      sourceSnapshot.tableMeasurements,
    ) ||
    writers.maintenanceWindowId !==
      plan.stoppedWritersProof.maintenanceWindowId ||
    writers.proofId === plan.stoppedWritersProof.proofId ||
    writers.sourceSha !== plan.liveSource.sha ||
    writers.runtimeBindingSha256 !== plan.runtimeBindingSha256 ||
    writers.databaseIdentitySha256 !== canonicalDigest(plan.sourceDatabase) ||
    after.stoppedWritersProofSha256 !== canonicalDigest(writers) ||
    observedAt !== proofObservedAt ||
    observedAt < restoreCompletedAt ||
    observedAt > traceCompletedAt ||
    traceCompletedAt - observedAt >
      PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS ||
    exactBackupTimestamp(
      snapshot.observedAt,
      "trace.sourceAfter.tableSnapshot.observedAt",
    ) < restoreCompletedAt ||
    exactBackupTimestamp(
      snapshot.observedAt,
      "trace.sourceAfter.tableSnapshot.observedAt",
    ) > observedAt
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SOURCE_AFTER_INVALID",
      "Production source must be re-snapshotted with exact content parity and a fresh second writer boundary.",
    );
  }
  return Object.freeze({
    ...after,
    runtimeBinding: runtime,
    stoppedWritersProof: writers,
    tableSnapshot: snapshot,
  });
}

function validateTraceSteps(steps, artifacts, completedAt) {
  if (!Array.isArray(steps) || steps.length !== TRACE_STEP_KINDS.length) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_TRACE_INVALID",
      "Trace must contain every ordered producer-native step.",
    );
  }
  let prior = -Infinity;
  for (let index = 0; index < steps.length; index += 1) {
    const step = exactBackupObject(
      steps[index],
      ["artifactSha256", "exitCode", "kind", "occurredAt", "sequence"],
      `trace.steps[${index}]`,
    );
    const occurredAt = exactBackupTimestamp(
      step.occurredAt,
      `trace.steps[${index}].occurredAt`,
    );
    if (
      step.sequence !== index + 1 ||
      step.kind !== TRACE_STEP_KINDS[index] ||
      step.exitCode !== 0 ||
      step.artifactSha256 !== canonicalDigest(artifacts[index]) ||
      occurredAt < prior ||
      occurredAt > completedAt
    ) {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_EXECUTOR_TRACE_INVALID",
        `Trace step ${index + 1} is not ordered or artifact-bound.`,
      );
    }
    prior = occurredAt;
  }
  return Object.freeze(steps.map((step) => Object.freeze({ ...step })));
}

export function validateProductionExact0096BackupExecutorTrace(
  value,
  planCanonical,
) {
  const planArtifact = parseProductionExact0096BackupPlan(planCanonical);
  const plan = planArtifact.value;
  const trace = exactBackupObject(value, TRACE_FIELDS, "trace");
  if (
    trace.schemaVersion !== PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA ||
    trace.kind !== "site-logbook-production-exact-0096-backup-executor-trace" ||
    trace.planSha256 !== planArtifact.sha256 ||
    trace.operationId !== plan.operationId
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_TRACE_INVALID",
      "Trace identity or plan binding is invalid.",
    );
  }
  const completedAt = exactBackupTimestamp(
    trace.completedAt,
    "trace.completedAt",
  );
  const producer = validateProducer(trace.producer, plan);
  const sourceBefore = validateSourceBefore(trace.sourceBefore, plan);
  const before = validateStoppedWritersProof(
    trace.stoppedWritersProofBefore,
    "trace.stoppedWritersProofBefore",
  );
  const sourceSnapshot = validateExact0096TableSnapshot(
    trace.sourceSnapshot,
    "trace.sourceSnapshot",
  );
  const planCreatedAt = exactBackupTimestamp(plan.createdAt, "plan.createdAt");
  const beforeObservedAt = exactBackupTimestamp(
    before.observedAt,
    "trace.stoppedWritersProofBefore.observedAt",
  );
  const sourceObservedAt = exactBackupTimestamp(
    sourceBefore.observedAt,
    "trace.sourceBefore.observedAt",
  );
  const snapshotObservedAt = exactBackupTimestamp(
    sourceSnapshot.observedAt,
    "trace.sourceSnapshot.observedAt",
  );
  const beforeQuiescentSince = exactBackupTimestamp(
    before.quiescentSince,
    "trace.stoppedWritersProofBefore.quiescentSince",
  );
  if (
    before.proofId === plan.stoppedWritersProof.proofId ||
    before.maintenanceWindowId !==
      plan.stoppedWritersProof.maintenanceWindowId ||
    before.sourceSha !== plan.liveSource.sha ||
    before.runtimeBindingSha256 !== plan.runtimeBindingSha256 ||
    before.databaseIdentitySha256 !== canonicalDigest(plan.sourceDatabase) ||
    sourceObservedAt < planCreatedAt ||
    beforeQuiescentSince < sourceObservedAt ||
    beforeObservedAt < beforeQuiescentSince ||
    beforeObservedAt - sourceObservedAt >
      PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS ||
    snapshotObservedAt < beforeObservedAt
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_WRITERS_PROOF_INVALID",
      "Trace must bind a fresh writer-free boundary measured after the live source observation.",
    );
  }
  const dump = validateDump(trace.dump, plan, sourceSnapshot);
  const payloadWrite = validatePayloadWrite(
    trace.payloadWrite,
    plan,
    dump,
    sourceSnapshot,
  );
  const restore = validateRestore(trace.restore, {
    plan,
    payload: payloadWrite.payload,
    sourceSnapshot,
    dump,
  });
  const sourceAfter = validateSourceAfter(trace.sourceAfter, {
    plan,
    sourceBefore,
    sourceSnapshot,
    restore,
    traceCompletedAt: completedAt,
  });
  validateProductionBackupSafety(trace.safety, "trace.safety");
  const steps = validateTraceSteps(
    trace.steps,
    [
      sourceBefore,
      before,
      sourceSnapshot,
      dump,
      payloadWrite,
      restore,
      sourceAfter,
    ],
    completedAt,
  );
  return Object.freeze({
    ...trace,
    producer,
    sourceBefore,
    stoppedWritersProofBefore: before,
    sourceSnapshot,
    dump,
    payloadWrite,
    restore,
    sourceAfter,
    steps,
  });
}

export function parseProductionExact0096BackupExecutorTrace(
  canonical,
  planCanonical,
) {
  const artifact = parseCanonicalProductionExact0096BackupArtifact(
    canonical,
    "executorTrace",
  );
  validateProductionExact0096BackupExecutorTrace(artifact.value, planCanonical);
  return artifact;
}

export function validateProductionExact0096BackupReceipt(
  value,
  planCanonical,
  executorTraceCanonical,
) {
  const planArtifact = parseProductionExact0096BackupPlan(planCanonical);
  const traceArtifact = parseProductionExact0096BackupExecutorTrace(
    executorTraceCanonical,
    planCanonical,
  );
  const receipt = exactBackupObject(value, RECEIPT_FIELDS, "receipt");
  if (
    receipt.schemaVersion !== PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA ||
    receipt.kind !==
      "site-logbook-production-exact-0096-backup-restore-receipt" ||
    receipt.decision !== "PASS" ||
    receipt.planSha256 !== planArtifact.sha256 ||
    receipt.executorTraceSha256 !== traceArtifact.sha256 ||
    receipt.operationId !== planArtifact.value.operationId ||
    receipt.completedAt !== traceArtifact.value.completedAt ||
    receipt.productionTargetsTouched !== true ||
    receipt.authorizesProductionMigration !== false ||
    !sameCanonical(receipt.sourceBefore, traceArtifact.value.sourceBefore) ||
    !sameCanonical(
      receipt.sourceSnapshot,
      traceArtifact.value.sourceSnapshot,
    ) ||
    !sameCanonical(receipt.payload, traceArtifact.value.payloadWrite.payload) ||
    !sameCanonical(receipt.restore, traceArtifact.value.restore) ||
    !sameCanonical(receipt.sourceAfter, traceArtifact.value.sourceAfter) ||
    !sameCanonical(receipt.safety, traceArtifact.value.safety)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RECEIPT_INVALID",
      "PASS receipt must be computed only from the exact canonical validated executor trace.",
    );
  }
  return Object.freeze({ ...receipt });
}

async function readCanonicalDependencyArtifact(dependencies, method, input) {
  const canonical = await dependencies[method](input);
  if (typeof canonical !== "string") {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_OUTPUT_INVALID",
      `${method} must return one canonical bounded raw artifact.`,
    );
  }
  return parseCanonicalProductionExact0096BackupArtifact(
    canonical,
    `executor.${method}`,
  );
}

function validateExclusivePersistenceAck(
  artifact,
  expectedArtifact,
  field,
  expectedStorageIdentitySha256,
) {
  const ack = exactBackupObject(
    artifact.value,
    [
      "artifactSha256",
      "canonicalReadbackBytes",
      "canonicalReadbackSha256",
      "existingTargetObserved",
      "persistedExclusive",
      "storageIdentitySha256",
    ],
    field,
  );
  if (
    ack.persistedExclusive !== true ||
    ack.existingTargetObserved !== false ||
    ack.artifactSha256 !== expectedArtifact.sha256 ||
    ack.canonicalReadbackSha256 !== expectedArtifact.sha256 ||
    ack.canonicalReadbackBytes !==
      Buffer.byteLength(expectedArtifact.canonical) ||
    (expectedStorageIdentitySha256 !== undefined &&
      ack.storageIdentitySha256 !== expectedStorageIdentitySha256)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXCLUSIVE_PERSISTENCE_FAILED",
      `${field} must prove no-clobber persistence and canonical readback of the exact artifact in the same store.`,
    );
  }
  exactBackupDigest(
    ack.storageIdentitySha256,
    `${field}.storageIdentitySha256`,
  );
  exactBackupDigest(
    ack.canonicalReadbackSha256,
    `${field}.canonicalReadbackSha256`,
  );
  return ack.storageIdentitySha256;
}

function executorStep(sequence, kind, occurredAt, artifact) {
  return Object.freeze({
    sequence,
    kind,
    occurredAt,
    exitCode: 0,
    artifactSha256: canonicalDigest(artifact),
  });
}

export async function runProductionExact0096BackupEvidenceExecutor({
  planCanonical,
  dependencies,
}) {
  const planArtifact = parseProductionExact0096BackupPlan(planCanonical);
  const plan = planArtifact.value;
  const executor =
    validateProductionExact0096BackupExecutorDependencies(dependencies);
  const producerArtifact = await readCanonicalDependencyArtifact(
    executor,
    "observeExecutorIdentity",
    Object.freeze({ planSha256: planArtifact.sha256 }),
  );
  const sourceBeforeArtifact = await readCanonicalDependencyArtifact(
    executor,
    "observeImmutableProductionSourceReadOnly",
    Object.freeze({ planSha256: planArtifact.sha256 }),
  );
  const stoppedBeforeArtifact = await readCanonicalDependencyArtifact(
    executor,
    "proveProductionWritersStopped",
    Object.freeze({
      boundary: "before",
      maintenanceWindowId: plan.stoppedWritersProof.maintenanceWindowId,
      sourceSha: plan.liveSource.sha,
      runtimeBindingSha256: plan.runtimeBindingSha256,
    }),
  );
  const snapshotHandleArtifact = await readCanonicalDependencyArtifact(
    executor,
    "openExportedReadOnlySnapshot",
    Object.freeze({ transactionMode: "repeatable-read-read-only" }),
  );
  const snapshotHandle = exactBackupObject(
    snapshotHandleArtifact.value,
    ["snapshotHandleId", "snapshotTokenSha256"],
    "executor.snapshotHandle",
  );
  exactBackupHexId(
    snapshotHandle.snapshotHandleId,
    "executor.snapshotHandle.snapshotHandleId",
  );
  exactBackupDigest(
    snapshotHandle.snapshotTokenSha256,
    "executor.snapshotHandle.snapshotTokenSha256",
  );
  const sourceSnapshotArtifact = await readCanonicalDependencyArtifact(
    executor,
    "readFrozenRelationManifestMeasurements",
    Object.freeze({ snapshotHandleId: snapshotHandle.snapshotHandleId }),
  );
  if (
    sourceSnapshotArtifact.value.snapshotTokenSha256 !==
    snapshotHandle.snapshotTokenSha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SNAPSHOT_INVALID",
      "Snapshot measurements must bind the opened opaque snapshot handle.",
    );
  }
  const dumpArtifact = await readCanonicalDependencyArtifact(
    executor,
    "createBoundedPgDumpCustom",
    Object.freeze({
      snapshotHandleId: snapshotHandle.snapshotHandleId,
      ceilingBytes: plan.payloadCeilingBytes,
    }),
  );
  const sourceSnapshot = validateExact0096TableSnapshot(
    sourceSnapshotArtifact.value,
    "executor.sourceSnapshot",
  );
  const dump = validateDump(dumpArtifact.value, plan, sourceSnapshot);
  const payloadWriteArtifact = await readCanonicalDependencyArtifact(
    executor,
    "encryptAndPersistVersionedPayload",
    Object.freeze({
      dumpCanonical: dumpArtifact.canonical,
      dumpId: dump.dumpId,
      ceilingBytes: plan.payloadCeilingBytes,
      enforcement: "streaming-before-write",
      abortWriteOnOverflow: true,
      terminateProducerOnOverflow: true,
      deletePartialObjectOnOverflow: true,
    }),
  );
  // Overflow validation is terminal before HEAD, restore, trace emission or receipt.
  const payloadWrite = validatePayloadWrite(
    payloadWriteArtifact.value,
    plan,
    dump,
    sourceSnapshot,
  );
  const objectHeadArtifact = await readCanonicalDependencyArtifact(
    executor,
    "headExactVersionedPayloadReadOnly",
    Object.freeze({
      bucket: payloadWrite.payload.object.bucket,
      key: payloadWrite.payload.object.key,
      versionId: payloadWrite.payload.object.versionId,
    }),
  );
  if (!sameCanonical(objectHeadArtifact.value, payloadWrite.payload.object)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Independent exact-version HEAD output must equal the persisted object binding.",
    );
  }
  const restoreAckArtifact = await readCanonicalDependencyArtifact(
    executor,
    "restoreIntoNewDisposablePostgres16",
    Object.freeze({
      backupObjectCanonical: objectHeadArtifact.canonical,
      encryptedPayloadSha256: payloadWrite.payload.encryptedPayloadSha256,
      sourceDumpSha256: dump.plaintextSha256,
    }),
  );
  const restoreAck = exactBackupObject(
    restoreAckArtifact.value,
    ["acceptedObjectVersionId", "restoreId"],
    "executor.restoreAck",
  );
  exactBackupId(restoreAck.restoreId, "executor.restoreAck.restoreId");
  exactBackupVersionId(
    restoreAck.acceptedObjectVersionId,
    "executor.restoreAck.acceptedObjectVersionId",
  );
  if (
    restoreAck.acceptedObjectVersionId !== payloadWrite.payload.object.versionId
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_OBJECT_BINDING_INVALID",
      "Disposable restore did not accept the exact stored object version.",
    );
  }
  const restoreArtifact = await readCanonicalDependencyArtifact(
    executor,
    "observeRestoredJournalSchemaAndContentReadOnly",
    Object.freeze({ restoreId: restoreAck.restoreId }),
  );
  if (restoreArtifact.value.restoreId !== restoreAck.restoreId) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RESTORE_INVALID",
      "Restore observation is not bound to the started disposable restore.",
    );
  }
  const sourceAfterArtifact = await readCanonicalDependencyArtifact(
    executor,
    "reobserveProductionSourceReadOnly",
    Object.freeze({
      boundary: "after",
      maintenanceWindowId: plan.stoppedWritersProof.maintenanceWindowId,
    }),
  );
  const trace = {
    schemaVersion: PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA,
    kind: "site-logbook-production-exact-0096-backup-executor-trace",
    operationId: plan.operationId,
    planSha256: planArtifact.sha256,
    producer: producerArtifact.value,
    sourceBefore: sourceBeforeArtifact.value,
    stoppedWritersProofBefore: stoppedBeforeArtifact.value,
    sourceSnapshot: sourceSnapshotArtifact.value,
    dump: dumpArtifact.value,
    payloadWrite: payloadWriteArtifact.value,
    restore: restoreArtifact.value,
    sourceAfter: sourceAfterArtifact.value,
    steps: [
      executorStep(
        1,
        "observe-source-before",
        sourceBeforeArtifact.value.observedAt,
        sourceBeforeArtifact.value,
      ),
      executorStep(
        2,
        "prove-writers-stopped-before",
        stoppedBeforeArtifact.value.observedAt,
        stoppedBeforeArtifact.value,
      ),
      executorStep(
        3,
        "capture-source-snapshot",
        sourceSnapshotArtifact.value.observedAt,
        sourceSnapshotArtifact.value,
      ),
      executorStep(
        4,
        "create-bounded-dump",
        dumpArtifact.value.completedAt,
        dumpArtifact.value,
      ),
      executorStep(
        5,
        "encrypt-persist-and-head-version",
        objectHeadArtifact.value.headObservedAt,
        payloadWriteArtifact.value,
      ),
      executorStep(
        6,
        "restore-and-observe-disposable",
        restoreArtifact.value.completedAt,
        restoreArtifact.value,
      ),
      executorStep(
        7,
        "reobserve-source-and-writers",
        sourceAfterArtifact.value.observedAt,
        sourceAfterArtifact.value,
      ),
    ],
    completedAt: sourceAfterArtifact.value.observedAt,
    safety: Object.freeze({
      productionDatabaseWrites: false,
      productionRestore: false,
      destructiveRestore: false,
      retentionPrune: false,
      migrationExecution: false,
    }),
  };
  validateProductionExact0096BackupExecutorTrace(trace, planCanonical);
  const traceArtifact = createProductionExact0096BackupArtifact(trace);
  const tracePersistAck = await readCanonicalDependencyArtifact(
    executor,
    "emitCanonicalExecutorTraceExclusive",
    Object.freeze({ traceCanonical: traceArtifact.canonical }),
  );
  const evidenceStorageIdentitySha256 = validateExclusivePersistenceAck(
    tracePersistAck,
    traceArtifact,
    "executor.tracePersistAck",
  );
  PRODUCER_ISSUED_TRACE_ARTIFACTS.add(traceArtifact);
  const receipt = createProductionExact0096BackupReceipt({
    planCanonical,
    executorTraceArtifact: traceArtifact,
  });
  const receiptPersistAck = await readCanonicalDependencyArtifact(
    executor,
    "persistReceiptExclusive",
    Object.freeze({ receiptCanonical: receipt.canonical }),
  );
  validateExclusivePersistenceAck(
    receiptPersistAck,
    receipt,
    "executor.receiptPersistAck",
    evidenceStorageIdentitySha256,
  );
  return Object.freeze({ trace: traceArtifact, receipt });
}

export function createProductionExact0096BackupReceipt({
  planCanonical,
  executorTraceArtifact,
}) {
  if (
    typeof planCanonical !== "string" ||
    !executorTraceArtifact ||
    !PRODUCER_ISSUED_TRACE_ARTIFACTS.has(executorTraceArtifact)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_TRACE_REQUIRED",
      "Receipt creation accepts only an executor-issued and exclusively persisted trace artifact from this DI run.",
    );
  }
  const planArtifact = parseProductionExact0096BackupPlan(planCanonical);
  const traceArtifact = parseProductionExact0096BackupExecutorTrace(
    executorTraceArtifact.canonical,
    planCanonical,
  );
  const trace = traceArtifact.value;
  const receipt = {
    schemaVersion: PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA,
    kind: "site-logbook-production-exact-0096-backup-restore-receipt",
    decision: "PASS",
    planSha256: planArtifact.sha256,
    executorTraceSha256: traceArtifact.sha256,
    operationId: planArtifact.value.operationId,
    completedAt: trace.completedAt,
    sourceBefore: trace.sourceBefore,
    sourceSnapshot: trace.sourceSnapshot,
    payload: trace.payloadWrite.payload,
    restore: trace.restore,
    sourceAfter: trace.sourceAfter,
    safety: trace.safety,
    productionTargetsTouched: true,
    authorizesProductionMigration: false,
  };
  validateProductionExact0096BackupReceipt(
    receipt,
    planCanonical,
    executorTraceArtifact.canonical,
  );
  return createProductionExact0096BackupArtifact(receipt);
}

export function parseProductionExact0096BackupReceipt(
  canonical,
  planCanonical,
  executorTraceCanonical,
) {
  const artifact = parseCanonicalProductionExact0096BackupArtifact(
    canonical,
    "receipt",
  );
  validateProductionExact0096BackupReceipt(
    artifact.value,
    planCanonical,
    executorTraceCanonical,
  );
  return artifact;
}

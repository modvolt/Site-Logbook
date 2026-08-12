import {
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_OPAQUE_LEGACY_ROWS,
} from "../production-evidence/production-migration-contract.mjs";
import {
  PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION,
  PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA,
  PRODUCTION_EXACT_0096_RELATION_MANIFEST,
  PRODUCTION_EXACT_0096_TABLE_SNAPSHOT_SCHEMA,
  PRODUCTION_EXACT_0096_WRITERS_PROOF_SCHEMA,
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
} from "../production-evidence/production-exact-0096-backup-contract.mjs";

export const fixtureDigest = (character) => `sha256:${character.repeat(64)}`;
export const fixtureSourceSha = "a".repeat(40);

const artifactDigest = (value) =>
  productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(value),
  );

export function fixtureExact0096Inventory(stateIndex = 0) {
  const state = PRODUCTION_MIGRATION_PREFIX_STATES[stateIndex];
  return structuredClone({
    knownAppliedMigrations: state.knownAppliedMigrations,
    knownAppliedRowsSha256: state.knownAppliedRowsSha256,
    latestKnownAppliedTag: state.latestKnownAppliedTag,
    missingKnownMigrationTags: state.missingKnownMigrationTags,
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: PRODUCTION_OPAQUE_LEGACY_ROWS,
    excludedMigration0100Present: false,
    totalJournalRows: state.totalJournalRows,
  });
}

export function fixtureProductionDatabase() {
  return {
    name: "site_logbook",
    user: "site_logbook_backup",
    serverVersionMajor: 16,
  };
}

export function fixtureProductionRuntimeBinding() {
  return {
    sourceSha: fixtureSourceSha,
    applicationImageRef: `ghcr.io/modvolt/site-logbook-api@${fixtureDigest("1")}`,
    containerId: "2".repeat(64),
    postgresImageRef: `docker.io/library/postgres@${fixtureDigest("3")}`,
    postgresImageId: fixtureDigest("4"),
    volumeName: "site_logbook_postgres_data",
    volumeCreatedAt: "2026-08-01T08:00:00.000Z",
    volumeLabelsSha256: fixtureDigest("5"),
    networkName: "site_logbook_production",
    networkId: "6".repeat(64),
    resolvedConfigSha256: fixtureDigest("7"),
    deploymentConfigSha256: fixtureDigest("8"),
  };
}

export function fixtureStoppedWritersProof({
  proofId = "9".repeat(64),
  quiescentSince = "2026-08-12T09:58:00.000Z",
  observedAt = "2026-08-12T09:59:00.000Z",
  runtimeBinding = fixtureProductionRuntimeBinding(),
  database = fixtureProductionDatabase(),
} = {}) {
  return {
    schemaVersion: PRODUCTION_EXACT_0096_WRITERS_PROOF_SCHEMA,
    mode: "production-maintenance-stopped-writers",
    proofId,
    maintenanceWindowId: "prod-maintenance-20260812",
    sourceSha: fixtureSourceSha,
    runtimeBindingSha256: artifactDigest(runtimeBinding),
    databaseIdentitySha256: artifactDigest(database),
    quiescentSince,
    observedAt,
    gracePeriodMs: 60_000,
    runningWriterContainerIds: [],
    activeApplicationSessions: 0,
    activeWriteTransactions: 0,
    databaseWritesObserved: 0,
  };
}

export function fixturePlanInput() {
  const sourceDatabase = fixtureProductionDatabase();
  const runtimeBinding = fixtureProductionRuntimeBinding();
  return {
    operationId: "prod-backup-op-20260812",
    createdAt: "2026-08-12T10:00:00.000Z",
    sourceSha: fixtureSourceSha,
    sourceDatabase,
    runtimeBinding,
    stoppedWritersProof: fixtureStoppedWritersProof({
      runtimeBinding,
      database: sourceDatabase,
    }),
    baselineInventory: fixtureExact0096Inventory(),
    schemaFingerprintSha256: fixtureDigest("a"),
    confirmation: PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION,
  };
}

export function fixtureTableSnapshot({
  observedAt = "2026-08-12T10:00:10.000Z",
  snapshotTokenSha256 = fixtureDigest("b"),
} = {}) {
  const tableMeasurements = Object.fromEntries(
    PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNames.map((name, index) => [
      name,
      {
        rowCount: name === "drizzle.__drizzle_migrations" ? 99 : index + 1,
        contentSha256: productionExact0096BackupSha256(
          `deterministic-canonical-row-stream/v1\0${name}`,
        ),
      },
    ]),
  );
  const tableMeasurementsSha256 = artifactDigest(tableMeasurements);
  return {
    schemaVersion: PRODUCTION_EXACT_0096_TABLE_SNAPSHOT_SCHEMA,
    observedAt,
    transactionMode: "repeatable-read-read-only",
    exportedSnapshotUsed: true,
    exportedSnapshotIdPersisted: false,
    snapshotTokenSha256,
    catalogManifest: structuredClone(PRODUCTION_EXACT_0096_RELATION_MANIFEST),
    tableMeasurements,
    tableMeasurementsSha256,
    dataSnapshotSha256: artifactDigest({
      relationNamesSha256:
        PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNamesSha256,
      tableMeasurementsSha256,
    }),
    unsupportedRelations: [],
  };
}

export function fixtureRestoreRuntimeBinding() {
  return {
    executorImageRef: `ghcr.io/modvolt/site-logbook-api@${fixtureDigest("1")}`,
    containerId: "b".repeat(64),
    postgresImageRef: `docker.io/library/postgres@${fixtureDigest("3")}`,
    postgresImageId: fixtureDigest("4"),
    volumeName: "site_logbook_restore_drill_20260812",
    volumeCreatedAt: "2026-08-12T10:02:00.000Z",
    volumeLabelsSha256: fixtureDigest("c"),
    networkName: "site_logbook_restore_drill_20260812",
    networkId: "d".repeat(64),
    resolvedConfigSha256: fixtureDigest("e"),
  };
}

function step(sequence, kind, occurredAt, artifact) {
  return {
    sequence,
    kind,
    occurredAt,
    exitCode: 0,
    artifactSha256: artifactDigest(artifact),
  };
}

export function fixtureExecutorTrace(plan) {
  const sourceBefore = {
    observedAt: "2026-08-12T09:58:30.000Z",
    database: fixtureProductionDatabase(),
    inventory: fixtureExact0096Inventory(),
    runtimeBinding: fixtureProductionRuntimeBinding(),
    schemaFingerprintSha256: fixtureDigest("a"),
  };
  const stoppedWritersProofBefore = structuredClone(
    plan.value.stoppedWritersProof,
  );
  const sourceSnapshot = fixtureTableSnapshot();
  const dump = {
    dumpId: "prod-dump-20260812-0001",
    backupFormat: "pg_dump-custom",
    pgDumpMajor: 16,
    exitCode: 0,
    completedAt: "2026-08-12T10:01:00.000Z",
    snapshotTokenSha256: sourceSnapshot.snapshotTokenSha256,
    sourceDataSnapshotSha256: sourceSnapshot.dataSnapshotSha256,
    plaintextBytes: 900_000,
    plaintextSha256: fixtureDigest("d"),
  };
  const object = {
    bucket: "site-logbook-production-backups",
    key: "production/exact-0096/prod-backup-20260812-0001.dump.enc",
    versionId: "s3-version-00000001",
    headObservedAt: "2026-08-12T10:01:20.000Z",
    headContentLength: 1024 * 1024,
    headEtag: `"${"f".repeat(32)}"`,
    headObjectSha256Metadata: fixtureDigest("f"),
    storageProvider: {
      kind: "hetzner-object-storage",
      endpointOriginSha256: fixtureDigest("e"),
      region: "fsn1",
      transport: "https",
      versioning: "enabled",
    },
  };
  const payload = {
    backupId: "prod-backup-20260812-0001",
    backupFormat: "pg_dump-custom",
    pgDumpMajor: 16,
    encryptionAlgorithm: "aes-256-gcm-envelope",
    envelopeKeyVersionId: "backup-key-version-2026-08",
    encryptedPayloadBytes: object.headContentLength,
    encryptedPayloadSha256: object.headObjectSha256Metadata,
    sourceDumpSha256: dump.plaintextSha256,
    sourceDataSnapshotSha256: sourceSnapshot.dataSnapshotSha256,
    createdAt: "2026-08-12T10:01:10.000Z",
    object,
  };
  const payloadWrite = {
    status: "persisted",
    guard: {
      ceilingBytes: 256 * 1024 * 1024,
      enforcement: "streaming-before-write",
      abortWriteOnOverflow: true,
      terminateProducerOnOverflow: true,
      deletePartialObjectOnOverflow: true,
      bytesRead: payload.encryptedPayloadBytes,
      overflowDetected: false,
      producerTerminated: false,
      objectCreated: true,
      partialObjectDeleted: false,
    },
    payload,
  };
  const restoreSnapshot = fixtureTableSnapshot({
    observedAt: "2026-08-12T10:03:50.000Z",
    snapshotTokenSha256: fixtureDigest("c"),
  });
  const restore = {
    restoreId: "prod-restore-drill-20260812-0001",
    environmentId: "site-logbook-production-backup-restore-drill",
    startedAt: "2026-08-12T10:02:00.000Z",
    completedAt: "2026-08-12T10:04:00.000Z",
    database: {
      name: "site_logbook_restore_20260812",
      user: "site_logbook_restore",
      serverVersionMajor: 16,
    },
    runtimeBinding: fixtureRestoreRuntimeBinding(),
    newDisposableDatabase: true,
    productionSourceAttached: false,
    pgRestoreExitCode: 0,
    backupObject: structuredClone(object),
    encryptedPayloadSha256: payload.encryptedPayloadSha256,
    sourceDumpSha256: dump.plaintextSha256,
    sourceDataSnapshotSha256: sourceSnapshot.dataSnapshotSha256,
    tableSnapshot: restoreSnapshot,
    inventory: fixtureExact0096Inventory(),
    schemaFingerprintSha256: fixtureDigest("a"),
    productionDatabaseWrites: false,
    destructiveRestore: false,
    retentionPrune: false,
  };
  const afterProof = fixtureStoppedWritersProof({
    proofId: "e".repeat(64),
    quiescentSince: "2026-08-12T10:04:00.000Z",
    observedAt: "2026-08-12T10:05:00.000Z",
  });
  const sourceAfter = {
    observedAt: afterProof.observedAt,
    inventory: fixtureExact0096Inventory(),
    runtimeBinding: fixtureProductionRuntimeBinding(),
    stoppedWritersProof: afterProof,
    stoppedWritersProofSha256: artifactDigest(afterProof),
    schemaFingerprintSha256: fixtureDigest("a"),
    tableSnapshot: fixtureTableSnapshot({
      observedAt: "2026-08-12T10:04:10.000Z",
      snapshotTokenSha256: fixtureDigest("9"),
    }),
    productionDatabaseWrites: false,
  };
  return {
    schemaVersion: PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA,
    kind: "site-logbook-production-exact-0096-backup-executor-trace",
    operationId: plan.value.operationId,
    planSha256: plan.sha256,
    producer: {
      schemaVersion: "site-logbook.production-backup-executor/v1",
      kind: "production-exact-0096-backup-executor",
      buildSha: fixtureSourceSha,
      executorImageRef: plan.value.runtimeBinding.applicationImageRef,
      invocationId: "7".repeat(64),
    },
    sourceBefore,
    stoppedWritersProofBefore,
    sourceSnapshot,
    dump,
    payloadWrite,
    restore,
    sourceAfter,
    steps: [
      step(1, "observe-source-before", sourceBefore.observedAt, sourceBefore),
      step(
        2,
        "prove-writers-stopped-before",
        stoppedWritersProofBefore.observedAt,
        stoppedWritersProofBefore,
      ),
      step(
        3,
        "capture-source-snapshot",
        sourceSnapshot.observedAt,
        sourceSnapshot,
      ),
      step(4, "create-bounded-dump", dump.completedAt, dump),
      step(
        5,
        "encrypt-persist-and-head-version",
        object.headObservedAt,
        payloadWrite,
      ),
      step(6, "restore-and-observe-disposable", restore.completedAt, restore),
      step(
        7,
        "reobserve-source-and-writers",
        sourceAfter.observedAt,
        sourceAfter,
      ),
    ],
    completedAt: "2026-08-12T10:06:00.000Z",
    safety: {
      productionDatabaseWrites: false,
      productionRestore: false,
      destructiveRestore: false,
      retentionPrune: false,
      migrationExecution: false,
    },
  };
}

export function fixtureExecutorTraceCanonical(plan) {
  return canonicalProductionExact0096BackupJson(fixtureExecutorTrace(plan));
}

export function fixtureExecutorDependencies(plan) {
  const trace = fixtureExecutorTrace(plan);
  const canonical = (value) => canonicalProductionExact0096BackupJson(value);
  return {
    observeExecutorIdentity: async () => canonical(trace.producer),
    observeImmutableProductionSourceReadOnly: async () =>
      canonical(trace.sourceBefore),
    proveProductionWritersStopped: async () =>
      canonical(trace.stoppedWritersProofBefore),
    openExportedReadOnlySnapshot: async () =>
      canonical({
        snapshotHandleId: "8".repeat(64),
        snapshotTokenSha256: trace.sourceSnapshot.snapshotTokenSha256,
      }),
    readFrozenRelationManifestMeasurements: async () =>
      canonical(trace.sourceSnapshot),
    createBoundedPgDumpCustom: async () => canonical(trace.dump),
    encryptAndPersistVersionedPayload: async () =>
      canonical(trace.payloadWrite),
    headExactVersionedPayloadReadOnly: async () =>
      canonical(trace.payloadWrite.payload.object),
    restoreIntoNewDisposablePostgres16: async () =>
      canonical({
        restoreId: trace.restore.restoreId,
        acceptedObjectVersionId: trace.payloadWrite.payload.object.versionId,
      }),
    observeRestoredJournalSchemaAndContentReadOnly: async () =>
      canonical(trace.restore),
    reobserveProductionSourceReadOnly: async () => canonical(trace.sourceAfter),
    emitCanonicalExecutorTraceExclusive: async ({ traceCanonical }) =>
      canonical({
        artifactSha256: productionExact0096BackupSha256(traceCanonical),
        canonicalReadbackBytes: Buffer.byteLength(traceCanonical),
        canonicalReadbackSha256:
          productionExact0096BackupSha256(traceCanonical),
        existingTargetObserved: false,
        persistedExclusive: true,
        storageIdentitySha256: fixtureDigest("6"),
      }),
    persistReceiptExclusive: async ({ receiptCanonical }) =>
      canonical({
        artifactSha256: productionExact0096BackupSha256(receiptCanonical),
        canonicalReadbackBytes: Buffer.byteLength(receiptCanonical),
        canonicalReadbackSha256:
          productionExact0096BackupSha256(receiptCanonical),
        existingTargetObserved: false,
        persistedExclusive: true,
        storageIdentitySha256: fixtureDigest("6"),
      }),
  };
}

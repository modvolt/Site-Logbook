import {
  PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION,
  PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA,
  PRODUCTION_EXACT_0096_BASELINE,
  PRODUCTION_EXACT_0096_ENVIRONMENT_ID,
  PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
  PRODUCTION_EXACT_0096_RELATION_MANIFEST,
  PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID,
  PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS,
  canonicalProductionExact0096BackupJson,
  createProductionExact0096BackupArtifact,
  exactBackupDigest,
  exactBackupId,
  exactBackupObject,
  exactBackupSourceSha,
  exactBackupTimestamp,
  parseCanonicalProductionExact0096BackupArtifact,
  productionExact0096BackupFail,
  productionExact0096BackupSha256,
  validateExact0096ProductionInventory,
  validateProductionBackupSafety,
  validateProductionImmutableRuntimeBinding,
  validateProductionSourceDatabase,
  validateStoppedWritersProof,
} from "./production-exact-0096-backup-contract.mjs";

const PLAN_FIELDS = [
  "authorizesProductionMigration",
  "baseline",
  "confirmation",
  "createdAt",
  "environmentId",
  "kind",
  "operationId",
  "payloadCeilingBytes",
  "productionTargetsTouched",
  "requiredBackupFormat",
  "requiredEncryption",
  "restoreContract",
  "runtimeBinding",
  "runtimeBindingSha256",
  "safety",
  "schemaFingerprintSha256",
  "schemaVersion",
  "snapshotContract",
  "sourceDatabase",
  "sourceSha",
  "stoppedWritersProof",
  "stoppedWritersProofSha256",
];

function exactFrozenBaseline(value, field) {
  if (
    canonicalProductionExact0096BackupJson(value) !==
    canonicalProductionExact0096BackupJson(PRODUCTION_EXACT_0096_BASELINE)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_BASELINE_INVALID",
      `${field} must be the frozen exact-0096 production baseline.`,
    );
  }
  return value;
}

function validateRequiredEncryption(value, field) {
  const encryption = exactBackupObject(
    value,
    ["algorithm", "atRest", "keyVersionIdRequired", "objectVersionIdRequired"],
    field,
  );
  if (
    encryption.algorithm !== "aes-256-gcm-envelope" ||
    encryption.atRest !== true ||
    encryption.keyVersionIdRequired !== true ||
    encryption.objectVersionIdRequired !== true
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ENCRYPTION_INVALID",
      `${field} must require envelope encryption and durable key/object versions.`,
    );
  }
  return encryption;
}

function validateSnapshotContract(value, field) {
  const contract = exactBackupObject(
    value,
    [
      "allSupportedPersistentBaseTables",
      "relationManifestSha256",
      "exportedSnapshotIdPersisted",
      "exportedSnapshotRequired",
      "transactionMode",
      "unsupportedRelationsAllowed",
    ],
    field,
  );
  if (
    contract.allSupportedPersistentBaseTables !== true ||
    contract.relationManifestSha256 !==
      PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNamesSha256 ||
    contract.exportedSnapshotRequired !== true ||
    contract.exportedSnapshotIdPersisted !== false ||
    contract.transactionMode !== "repeatable-read-read-only" ||
    contract.unsupportedRelationsAllowed !== false
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SNAPSHOT_INVALID",
      `${field} must require one read-only exported snapshot and full supported-table coverage.`,
    );
  }
  return contract;
}

function validateRestoreContract(value, field) {
  const contract = exactBackupObject(
    value,
    [
      "destructiveRestoreAllowed",
      "newDisposableDatabaseRequired",
      "postgresMajor",
      "productionSourceAttachAllowed",
      "restoreEnvironmentId",
      "sourceVsRestoredParityRequired",
    ],
    field,
  );
  if (
    contract.restoreEnvironmentId !==
      PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID ||
    contract.postgresMajor !== 16 ||
    contract.newDisposableDatabaseRequired !== true ||
    contract.productionSourceAttachAllowed !== false ||
    contract.destructiveRestoreAllowed !== false ||
    contract.sourceVsRestoredParityRequired !== true
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RESTORE_CONTRACT_INVALID",
      `${field} must require non-destructive parity restore into new disposable PostgreSQL 16.`,
    );
  }
  return contract;
}

export function validateProductionExact0096BackupPlan(value) {
  const plan = exactBackupObject(value, PLAN_FIELDS, "plan");
  if (
    plan.schemaVersion !== PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA ||
    plan.kind !== "site-logbook-production-exact-0096-backup-plan" ||
    plan.environmentId !== PRODUCTION_EXACT_0096_ENVIRONMENT_ID ||
    plan.confirmation !== PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION ||
    plan.payloadCeilingBytes !==
      PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES ||
    plan.requiredBackupFormat !== "pg_dump-custom" ||
    plan.productionTargetsTouched !== true ||
    plan.authorizesProductionMigration !== false
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_PLAN_INVALID",
      "Plan identity, format, boundary or authorization fields are invalid.",
    );
  }
  exactBackupId(plan.operationId, "plan.operationId");
  const createdAt = exactBackupTimestamp(plan.createdAt, "plan.createdAt");
  const sourceSha = exactBackupSourceSha(plan.sourceSha, "plan.sourceSha");
  const database = validateProductionSourceDatabase(
    plan.sourceDatabase,
    "plan.sourceDatabase",
  );
  const runtime = validateProductionImmutableRuntimeBinding(
    plan.runtimeBinding,
    "plan.runtimeBinding",
  );
  if (
    runtime.sourceSha !== sourceSha ||
    plan.runtimeBindingSha256 !==
      productionExact0096BackupSha256(
        canonicalProductionExact0096BackupJson(runtime),
      )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RUNTIME_BINDING_INVALID",
      "Plan runtime binding must preserve the exact source SHA and canonical digest.",
    );
  }
  const runtimeBindingSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(runtime),
  );
  const databaseIdentitySha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(database),
  );
  const writers = validateStoppedWritersProof(
    plan.stoppedWritersProof,
    "plan.stoppedWritersProof",
  );
  if (
    exactBackupTimestamp(
      writers.observedAt,
      "plan.stoppedWritersProof.observedAt",
    ) > createdAt ||
    createdAt -
      exactBackupTimestamp(
        writers.observedAt,
        "plan.stoppedWritersProof.observedAt",
      ) >
      PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS ||
    writers.sourceSha !== sourceSha ||
    writers.runtimeBindingSha256 !== runtimeBindingSha256 ||
    writers.databaseIdentitySha256 !== databaseIdentitySha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_TIME_INVALID",
      "Plan cannot predate its stopped-writers proof.",
    );
  }
  if (
    plan.stoppedWritersProofSha256 !==
    productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(writers),
    )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_WRITERS_PROOF_INVALID",
      "Plan stopped-writers proof digest is not canonical.",
    );
  }
  exactFrozenBaseline(plan.baseline, "plan.baseline");
  exactBackupDigest(
    plan.schemaFingerprintSha256,
    "plan.schemaFingerprintSha256",
  );
  validateRequiredEncryption(
    plan.requiredEncryption,
    "plan.requiredEncryption",
  );
  validateSnapshotContract(plan.snapshotContract, "plan.snapshotContract");
  validateRestoreContract(plan.restoreContract, "plan.restoreContract");
  validateProductionBackupSafety(plan.safety, "plan.safety");
  return Object.freeze({ ...plan, sourceDatabase: database });
}

export function createProductionExact0096BackupPlan({
  operationId,
  createdAt,
  sourceSha,
  sourceDatabase,
  runtimeBinding,
  stoppedWritersProof,
  baselineInventory,
  schemaFingerprintSha256,
  confirmation,
}) {
  if (confirmation !== PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_CONFIRMATION_INVALID",
      "The exact non-migrating production backup confirmation is required.",
    );
  }
  const runtime = validateProductionImmutableRuntimeBinding(
    runtimeBinding,
    "runtimeBinding",
  );
  const writers = validateStoppedWritersProof(
    stoppedWritersProof,
    "stoppedWritersProof",
  );
  validateExact0096ProductionInventory(baselineInventory, "baselineInventory");
  const plan = {
    schemaVersion: PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA,
    kind: "site-logbook-production-exact-0096-backup-plan",
    operationId: exactBackupId(operationId, "operationId"),
    createdAt: new Date(
      exactBackupTimestamp(createdAt, "createdAt"),
    ).toISOString(),
    environmentId: PRODUCTION_EXACT_0096_ENVIRONMENT_ID,
    sourceSha: exactBackupSourceSha(sourceSha),
    sourceDatabase: validateProductionSourceDatabase(
      sourceDatabase,
      "sourceDatabase",
    ),
    runtimeBinding: runtime,
    runtimeBindingSha256: productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(runtime),
    ),
    stoppedWritersProof: writers,
    stoppedWritersProofSha256: productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(writers),
    ),
    baseline: PRODUCTION_EXACT_0096_BASELINE,
    schemaFingerprintSha256: exactBackupDigest(
      schemaFingerprintSha256,
      "schemaFingerprintSha256",
    ),
    payloadCeilingBytes: PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES,
    requiredBackupFormat: "pg_dump-custom",
    requiredEncryption: Object.freeze({
      algorithm: "aes-256-gcm-envelope",
      atRest: true,
      keyVersionIdRequired: true,
      objectVersionIdRequired: true,
    }),
    snapshotContract: Object.freeze({
      allSupportedPersistentBaseTables: true,
      relationManifestSha256:
        PRODUCTION_EXACT_0096_RELATION_MANIFEST.relationNamesSha256,
      exportedSnapshotRequired: true,
      exportedSnapshotIdPersisted: false,
      transactionMode: "repeatable-read-read-only",
      unsupportedRelationsAllowed: false,
    }),
    restoreContract: Object.freeze({
      restoreEnvironmentId: PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID,
      postgresMajor: 16,
      newDisposableDatabaseRequired: true,
      productionSourceAttachAllowed: false,
      destructiveRestoreAllowed: false,
      sourceVsRestoredParityRequired: true,
    }),
    safety: Object.freeze({
      productionDatabaseWrites: false,
      productionRestore: false,
      destructiveRestore: false,
      retentionPrune: false,
      migrationExecution: false,
    }),
    confirmation,
    productionTargetsTouched: true,
    authorizesProductionMigration: false,
  };
  validateProductionExact0096BackupPlan(plan);
  return createProductionExact0096BackupArtifact(plan);
}

export function parseProductionExact0096BackupPlan(canonical) {
  const artifact = parseCanonicalProductionExact0096BackupArtifact(
    canonical,
    "plan",
  );
  validateProductionExact0096BackupPlan(artifact.value);
  return artifact;
}

const EXECUTOR_METHODS = Object.freeze([
  "observeExecutorIdentity",
  "observeImmutableProductionSourceReadOnly",
  "proveProductionWritersStopped",
  "openExportedReadOnlySnapshot",
  "readFrozenRelationManifestMeasurements",
  "createBoundedPgDumpCustom",
  "encryptAndPersistVersionedPayload",
  "headExactVersionedPayloadReadOnly",
  "restoreIntoNewDisposablePostgres16",
  "observeRestoredJournalSchemaAndContentReadOnly",
  "reobserveProductionSourceReadOnly",
  "emitCanonicalExecutorTraceExclusive",
  "persistReceiptExclusive",
]);

export function validateProductionExact0096BackupExecutorDependencies(
  dependencies,
) {
  if (
    !dependencies ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_INVALID",
      "Executor dependencies must be an exact object.",
    );
  }
  const keys = Object.keys(dependencies).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...EXECUTOR_METHODS].sort())) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_EXECUTOR_INVALID",
      "Executor dependencies must contain every and only reviewed operation.",
    );
  }
  for (const method of EXECUTOR_METHODS) {
    if (typeof dependencies[method] !== "function") {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_EXECUTOR_INVALID",
        `${method} must be a function.`,
      );
    }
  }
  return Object.freeze({ ...dependencies });
}

export const PRODUCTION_EXACT_0096_BACKUP_EXECUTOR_INTERFACE = Object.freeze({
  version: "site-logbook.production-exact-0096-backup-executor-di/v1",
  methods: EXECUTOR_METHODS,
  streamingCeilingCall:
    "encryptAndPersistVersionedPayload(stream,{ceilingBytes,enforcement:'streaming-before-write',abortWriteOnOverflow:true,terminateProducerOnOverflow:true,deletePartialObjectOnOverflow:true})",
  constraints: Object.freeze([
    "no-production-database-writes",
    "no-production-restore",
    "no-destructive-restore",
    "no-retention-prune",
    "no-migration-execution",
    "no-mutable-image-ref",
    "no-staging-identity",
    "no-exported-snapshot-id-persistence",
    "no-secret-or-private-key-in-evidence",
    "no-production-migration-authorization",
  ]),
});

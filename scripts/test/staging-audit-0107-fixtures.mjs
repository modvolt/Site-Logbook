import crypto from "node:crypto";
import { createStagingAudit0107Binding } from "../check-staging-audit-0107-binding.mjs";
import { canonicalJson } from "../check-staging-provisioning.mjs";
import {
  AUDIT_0107,
  AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS,
} from "../staging-audit-0107-contract.mjs";

export const SHA = "a".repeat(40);
export const API_IMAGE = `ghcr.io/modvolt/site-logbook-staging-api@sha256:${"3".repeat(64)}`;
export const POSTGRES_IMAGE =
  "postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777";
export const POSTGRES_CONTAINER_ID = "6".repeat(64);

export function artifact(value, name) {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256, checksum: `${sha256}  ${name}\n`, value };
}

export function inspectInputs() {
  return {
    schemaVersion: 1,
    sourceSha: SHA,
    imageManifestSha256: "b".repeat(64),
    provisioningManifestSha256: "c".repeat(64),
    environmentId: "site-logbook-staging",
    coolifyEnvironmentId: "staging-environment",
    composeProjectName: "site-logbook-staging",
    publicAppUrl: "https://stage-site-logbook.cz",
    nginxServerName: "stage-site-logbook.cz",
    operationalAlertReceiverUrl:
      "https://stage-alert-site-logbook.cz/v1/operational-alerts",
    operationalAlertReceiverHost: "stage-alert-site-logbook.cz",
    s3Endpoint: "https://fsn1.your-objectstorage.com",
    s3Region: "fsn1",
    s3Bucket: "site-logbook-staging-r1",
    s3ForcePathStyle: false,
    externalAccountsEnabled: false,
    schemaAction: "inspect",
    images: {
      preflight: `ghcr.io/modvolt/site-logbook-staging-preflight@sha256:${"1".repeat(64)}`,
      mailpit: `ghcr.io/modvolt/site-logbook-staging-mailpit@sha256:${"2".repeat(64)}`,
      api: API_IMAGE,
      web: `ghcr.io/modvolt/site-logbook-staging-web@sha256:${"4".repeat(64)}`,
      alertReceiver: `ghcr.io/modvolt/site-logbook-staging-alert-receiver@sha256:${"5".repeat(64)}`,
    },
    backupEvidenceId: 81,
    backupRestoreMaxAgeHours: 24,
  };
}

export function lineageConfig(mode = "clean") {
  const rows = mode === "clean" ? [] : AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS;
  const rowsJson = JSON.stringify(rows);
  return {
    mode,
    rows,
    rowsJson,
    rowsSha256: `sha256:${crypto.createHash("sha256").update(rowsJson).digest("hex")}`,
  };
}

export function lineageSummary(applied, mode = "clean") {
  const config = lineageConfig(mode);
  return {
    decision: applied === 106 ? "READY_0106" : "ALREADY_0107",
    knownAppliedRowsSha256:
      applied === 106
        ? AUDIT_0107.predecessorKnownRowsSha256
        : AUDIT_0107.targetKnownRowsSha256,
    mode,
    knownExpectedMigrations: 107,
    knownAppliedMigrations: applied,
    latestKnownAppliedTag:
      applied === 106 ? AUDIT_0107.predecessorTag : AUDIT_0107.targetTag,
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: config.rows.length,
    opaqueLegacyRowsSha256: config.rowsSha256,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  };
}

export function schemaSummary(targetPresent) {
  return {
    targetTag: AUDIT_0107.targetTag,
    targetSqlSha256: `sha256:${AUDIT_0107.migrationSha256}`,
    targetSnapshotSha256: `sha256:${AUDIT_0107.targetSnapshotSha256}`,
    auditEventRows: 0,
    auditOutboxRows: 0,
    auditHeadRows: targetPresent ? 1 : 0,
  };
}

export function backupGate(mode = "clean", overrides = {}) {
  return {
    kind: "audit-schema-exact-0106-backup",
    schemaVersion: "site-logbook.audit-schema-exact-0106-backup/v1",
    decision: "CREATED_AND_RESTORE_VERIFIED",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineageSummary(106, mode),
    expectedMigrations: 106,
    latestExpectedTag: AUDIT_0107.predecessorTag,
    previousBackupId: 81,
    backupId: 82,
    createdAt: "2026-08-12T10:01:00.000Z",
    restoreTestedAt: "2026-08-12T10:02:00.000Z",
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    sizeBytes: 4096,
    maxPayloadBytes: AUDIT_0107.maxPayloadBytes,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    retentionPruned: false,
    destructiveRestorePerformed: false,
    nextGate: "audit-0107-transition-binding-required",
    authorizes0107: false,
    authorizesApplicationStart: false,
    ...overrides,
  };
}

export function backupExecution(
  inspectSha256,
  mode = "clean",
  gateOverrides = {},
) {
  const lineage = lineageConfig(mode);
  const inputs = inspectInputs();
  const livePostgresTarget = {
    containerId: POSTGRES_CONTAINER_ID,
    image: POSTGRES_IMAGE,
    imageId: `sha256:${"7".repeat(64)}`,
    volumeName: `${inputs.composeProjectName}_staging_pgdata`,
    networkName: `${inputs.composeProjectName}_default`,
    networkId: "8".repeat(64),
  };
  const projectionSha256 = crypto
    .createHash("sha256")
    .update(canonicalJson(livePostgresTarget))
    .digest("hex");
  return {
    schemaVersion: 1,
    kind: "site-logbook-staging-exact-0106-audit-backup-execution",
    decision: "PASS",
    productionTargetsTouched: false,
    startedAt: "2026-08-12T10:00:00.000Z",
    completedAt: "2026-08-12T10:03:00.000Z",
    sourceSha: SHA,
    inspectDeploymentInputsSha256: `sha256:${inspectSha256}`,
    runtimeBinding: {
      resolvedComposeSha256: `sha256:${"9".repeat(64)}`,
      deploymentConfigSha256: `sha256:${"0".repeat(64)}`,
      livePostgresTarget: {
        ...livePostgresTarget,
        projectionSha256: `sha256:${projectionSha256}`,
      },
    },
    lineage: {
      mode,
      opaqueLegacyRows: lineage.rows,
      opaqueLegacyRowsSha256: lineage.rowsSha256,
    },
    gate: backupGate(mode, gateOverrides),
    runtimeIsolation: {
      onlyPostgresRunningAtEveryBoundary: true,
      samePostgresContainerAtEveryBoundary: true,
      apiStarted: false,
      webStarted: false,
      auditSchema0107GateStarted: false,
    },
    nextGate: "audit-0107-transition-binding-required",
    authorizes0107: false,
    authorizesApplicationStart: false,
  };
}

export function createArtifacts(mode = "clean") {
  const originalInspect = artifact(
    inspectInputs(),
    "staging-deployment-inspect.json",
  );
  const backup = artifact(
    backupExecution(originalInspect.sha256, mode),
    "staging-exact-0106-audit-backup-execution.json",
  );
  const lineage = lineageConfig(mode);
  const binding = createStagingAudit0107Binding({
    expectedSourceSha: SHA,
    lineageMode: mode,
    opaqueLegacyRowsJson: lineage.rowsJson,
    originalInspectBytes: originalInspect.bytes,
    originalInspectChecksumText: originalInspect.checksum,
    expectedOriginalInspectSha256: originalInspect.sha256,
    backupExecutionBytes: backup.bytes,
    backupExecutionChecksumText: backup.checksum,
    expectedBackupExecutionSha256: backup.sha256,
  });
  return {
    binding,
    backup,
    originalInspect,
    inspect: artifact(
      binding.derivedInspect,
      "staging-audit-0107-inspect.json",
    ),
    transition: artifact(
      binding.transition,
      "staging-audit-0107-transition.json",
    ),
    lineage,
  };
}

function preflightEnvironment(inputs, inspectSha256) {
  return {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: inspectSha256,
    STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
    STAGING_SCHEMA_ACTION: inputs.schemaAction,
    STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
    STAGING_PROVISIONING_MANIFEST_SHA256: inputs.provisioningManifestSha256,
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_API_IMAGE: inputs.images.api,
    STAGING_S3_ENDPOINT: inputs.s3Endpoint,
    STAGING_S3_REGION: inputs.s3Region,
    STAGING_S3_BUCKET: inputs.s3Bucket,
    STAGING_S3_FORCE_PATH_STYLE: String(inputs.s3ForcePathStyle),
  };
}

function postgresService() {
  return {
    image: POSTGRES_IMAGE,
    command: null,
    entrypoint: null,
    restart: "unless-stopped",
    pull_policy: "always",
    depends_on: {
      "staging-preflight": {
        condition: "service_completed_successfully",
        required: true,
      },
    },
    expose: ["5432"],
    healthcheck: {
      test: [
        "CMD-SHELL",
        "pg_isready -U site_logbook_staging -d site_logbook_staging",
      ],
      timeout: "5s",
      interval: "10s",
      retries: 10,
    },
    logging: {
      driver: "json-file",
      options: { "max-file": "3", "max-size": "10m" },
    },
    volumes: [
      {
        type: "volume",
        source: "staging_pgdata",
        target: "/var/lib/postgresql/data",
        volume: {},
      },
    ],
    networks: { default: null },
    cpus: 0.5,
    mem_limit: "805306368",
    mem_reservation: "536870912",
    environment: {
      POSTGRES_USER: "site_logbook_staging",
      POSTGRES_PASSWORD: "test",
      POSTGRES_DB: "site_logbook_staging",
    },
  };
}

function oneShotBase(inputs, command, profiles, backup) {
  return {
    image: inputs.images.api,
    command: ["node", command],
    entrypoint: null,
    restart: "no",
    read_only: true,
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    pull_policy: "always",
    profiles,
    healthcheck: { disable: true },
    logging: {
      driver: "json-file",
      options: { "max-file": "3", "max-size": "10m" },
    },
    networks: { default: null },
    cpus: backup ? 0.5 : 0.25,
    mem_limit: backup ? "1610612736" : "402653184",
    mem_reservation: backup ? "402653184" : "201326592",
    ...(backup ? { tmpfs: ["/tmp:size=536870912,mode=1777"] } : {}),
  };
}

function commonTargetEnvironment(inputs, inspectSha256) {
  return {
    STAGING_ENVIRONMENT_ID: inputs.environmentId,
    STAGING_BUILD_SHA: inputs.sourceSha,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: inputs.sourceSha,
    STAGING_DEPLOYMENT_INPUTS_SHA256: inspectSha256,
    STAGING_COMPOSE_PROJECT_NAME: inputs.composeProjectName,
    STAGING_SCHEMA_ACTION: inputs.schemaAction,
    STAGING_IMAGE_MANIFEST_SHA256: inputs.imageManifestSha256,
    STAGING_PROVISIONING_MANIFEST_SHA256: inputs.provisioningManifestSha256,
    STAGING_DATABASE_HOST: "postgres",
    STAGING_DATABASE_NAME: "site_logbook_staging",
    STAGING_DATABASE_USER: "site_logbook_staging",
    STAGING_BACKUP_EVIDENCE_ID: String(inputs.backupEvidenceId),
    STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(
      inputs.backupRestoreMaxAgeHours,
    ),
    STAGING_EXTERNAL_ACCOUNTS_ENABLED: "false",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    EXTERNAL_ACCOUNTS_ENABLED: "false",
    DATABASE_URL:
      "postgres://site_logbook_staging:test@postgres:5432/site_logbook_staging",
  };
}

export function resolvedCompose(artifacts, target) {
  const inputs =
    target === "backup" ? inspectInputs() : artifacts.binding.derivedInspect;
  const inspectSha256 =
    target === "backup"
      ? artifacts.originalInspect.sha256
      : artifacts.inspect.sha256;
  const common = commonTargetEnvironment(inputs, inspectSha256);
  const targetService =
    target === "backup"
      ? {
          ...oneShotBase(
            inputs,
            "dist/audit-schema-exact-0106-backup.mjs",
            ["exact-0106-audit-backup"],
            true,
          ),
          environment: {
            ...common,
            ACCOUNTING_SCHEMA_PREFLIGHT_CONFIRMATION: "",
            AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: "",
            STAGING_AUDIT_SCHEMA_ACTION: "inspect",
            AUDIT_SCHEMA_LINEAGE_MODE: artifacts.lineage.mode,
            AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON: artifacts.lineage.rowsJson,
            STAGING_EXACT_0106_BACKUP_ACTION: "",
            STAGING_EXACT_0106_BACKUP_CONFIRMATION: "",
            S3_ENDPOINT: inputs.s3Endpoint,
            S3_REGION: inputs.s3Region,
            S3_BUCKET: inputs.s3Bucket,
            S3_ACCESS_KEY_ID: "key",
            S3_SECRET_ACCESS_KEY: "secret",
            S3_FORCE_PATH_STYLE: String(inputs.s3ForcePathStyle),
            S3_PRIVATE_PREFIX: "private",
            BACKUP_ENCRYPTION_KEYRING: '{"test":"key"}',
            BACKUP_ENCRYPTION_ACTIVE_KEY_ID: "test",
            BACKUP_ENABLED: "true",
          },
        }
      : {
          ...oneShotBase(
            inputs,
            "dist/audit-schema-gate.mjs",
            ["audit-0107-transition"],
            false,
          ),
          environment: {
            ...common,
            STAGING_API_IMAGE: inputs.images.api,
            AUDIT_SCHEMA_PREFLIGHT_CONFIRMATION: "",
            AUDIT_SCHEMA_LINEAGE_MODE: artifacts.lineage.mode,
            AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON: artifacts.lineage.rowsJson,
            STAGING_AUDIT_SCHEMA_ACTION: "steady-0107",
            STAGING_AUDIT_DEPLOYMENT_INPUTS_SHA256: artifacts.transition.sha256,
            STAGING_EXACT_0106_BACKUP_EXECUTION_SHA256: artifacts.backup.sha256,
            STAGING_EXACT_0106_BACKUP_MAX_PAYLOAD_BYTES: String(
              AUDIT_0107.maxPayloadBytes,
            ),
            STAGING_EXACT_0106_BACKUP_SIZE_BYTES: "4096",
          },
        };
  return {
    name: inputs.composeProjectName,
    services: {
      "staging-preflight": {
        environment: preflightEnvironment(inputs, inspectSha256),
      },
      postgres: postgresService(),
      [target === "backup" ? "exact-0106-audit-backup" : "audit-schema-gate"]:
        targetService,
    },
    volumes: {
      staging_alert_receipts: {
        name: `${inputs.composeProjectName}_staging_alert_receipts`,
      },
      staging_mailca: { name: `${inputs.composeProjectName}_staging_mailca` },
      staging_mailtls: { name: `${inputs.composeProjectName}_staging_mailtls` },
      staging_pgdata: {
        name: `${inputs.composeProjectName}_staging_pgdata`,
      },
    },
    networks: {
      default: { name: `${inputs.composeProjectName}_default`, ipam: {} },
    },
  };
}

export function postgresInspect(inputs = inspectInputs()) {
  const networkName = `${inputs.composeProjectName}_default`;
  return {
    id: POSTGRES_CONTAINER_ID,
    running: true,
    configImage: POSTGRES_IMAGE,
    imageId: `sha256:${"7".repeat(64)}`,
    projectLabel: inputs.composeProjectName,
    serviceLabel: "postgres",
    path: "docker-entrypoint.sh",
    args: ["postgres"],
    mounts: [
      {
        Type: "volume",
        Name: `${inputs.composeProjectName}_staging_pgdata`,
        Source: `/var/lib/docker/volumes/${inputs.composeProjectName}_staging_pgdata/_data`,
        Destination: "/var/lib/postgresql/data",
        Driver: "local",
        Mode: "rw",
        RW: true,
        Propagation: "",
      },
    ],
    networks: { [networkName]: { NetworkID: "8".repeat(64) } },
    portBindings: {},
    networkPorts: { "5432/tcp": null },
  };
}

export function inventory(decision = "READY_0106", mode = "clean") {
  const already = decision === "ALREADY_0107";
  return {
    kind: "audit-schema-inventory",
    schemaVersion: "site-logbook.audit-schema-inventory/v1",
    decision,
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineageSummary(already ? 107 : 106, mode),
    schema: schemaSummary(already),
    backupEvidenceId: 82,
    backupRestoreAgeHours: 0.017,
    authorizesApplicationStart: false,
  };
}

export function richBackup(backupExecutionSha256) {
  return {
    id: 82,
    sizeBytes: 4096,
    encryptedBackupSha256: `sha256:${"d".repeat(64)}`,
    encryptionFormat: "mve1",
    encryptionKeyIdFingerprint: `sha256:${"e".repeat(64)}`,
    objectPathFingerprint: `sha256:${"f".repeat(64)}`,
    createdAt: "2026-08-12T10:01:00.000Z",
    restoreTestedAt: "2026-08-12T10:02:00.000Z",
    checkedAt: "2026-08-12T10:04:00.000Z",
    restoreAgeHours: 0.033,
    restoreDurationMs: 60_000,
    verifiedTableCount: 5,
    verifiedTablesSha256: `sha256:${"1".repeat(64)}`,
    destructiveRestorePerformed: false,
  };
}

export function steadySummary(artifacts) {
  return {
    kind: "audit-schema-steady-state",
    schemaVersion: "site-logbook.audit-schema-steady-state/v1",
    decision: "ALREADY_0107",
    environmentId: "site-logbook-staging",
    databaseName: "site_logbook_staging",
    databaseUser: "site_logbook_staging",
    buildSha: SHA,
    lineage: lineageSummary(107, artifacts.lineage.mode),
    schema: schemaSummary(true),
    authorizesApplicationStart: true,
  };
}

export function gateEvidence(artifacts, operation = "APPLIED") {
  return {
    kind: "audit-schema-gate",
    schemaVersion: "site-logbook.audit-schema-gate/v1",
    mode: operation,
    decision: "ALREADY_0107",
    before: {
      decision: operation === "APPLIED" ? "READY_0106" : "ALREADY_0107",
      knownAppliedMigrations: operation === "APPLIED" ? 106 : 107,
      knownAppliedRowsSha256:
        operation === "APPLIED"
          ? AUDIT_0107.predecessorKnownRowsSha256
          : AUDIT_0107.targetKnownRowsSha256,
      opaqueLegacyRowCount: artifacts.lineage.rows.length,
      opaqueLegacyRowsSha256: artifacts.lineage.rowsSha256,
    },
    after: steadySummary(artifacts),
    newlyApplied: operation === "APPLIED" ? 1 : 0,
    migration: {
      idx: AUDIT_0107.targetIdx,
      when: AUDIT_0107.targetWhen,
      tag: AUDIT_0107.targetTag,
      sha256: `sha256:${AUDIT_0107.migrationSha256}`,
    },
    transition: {
      inputSha256: `sha256:${artifacts.transition.sha256}`,
      sourceBackupExecutionSha256: `sha256:${artifacts.backup.sha256}`,
      backupEvidenceId: 82,
      backupRestoreAgeHours: 0.033,
      backupRestoreMaxAgeHours: 24,
      backupMaxPayloadBytes: AUDIT_0107.maxPayloadBytes,
      backupSizeBytes: 4096,
      backupEvidence: richBackup(artifacts.backup.sha256),
    },
    authorizesApplicationStart: true,
  };
}

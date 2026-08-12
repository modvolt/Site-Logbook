import { createHash } from "node:crypto";
import {
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  frozenStateSummary,
  validateProductionMigrationInventory,
} from "./production-migration-contract.mjs";

export const PRODUCTION_EXACT_0096_BACKUP_PLAN_SCHEMA =
  "site-logbook.production-exact-0096-backup-plan/v3";
export const PRODUCTION_EXACT_0096_BACKUP_RECEIPT_SCHEMA =
  "site-logbook.production-exact-0096-backup-restore-receipt/v3";
export const PRODUCTION_EXACT_0096_EXECUTOR_TRACE_SCHEMA =
  "site-logbook.production-exact-0096-backup-executor-trace/v2";
export const PRODUCTION_EXACT_0096_TABLE_SNAPSHOT_SCHEMA =
  "site-logbook.production-exact-0096-table-snapshot/v2";
export const PRODUCTION_EXACT_0096_WRITERS_PROOF_SCHEMA =
  "site-logbook.production-stopped-writers-proof/v2";
export const PRODUCTION_EXACT_0096_RELATION_MANIFEST_SCHEMA =
  "site-logbook.production-exact-0096-relation-manifest/v1";

export const PRODUCTION_EXACT_0096_ENVIRONMENT_ID = "site-logbook-production";
export const PRODUCTION_EXACT_0096_RESTORE_ENVIRONMENT_ID =
  "site-logbook-production-backup-restore-drill";
export const PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION =
  "CREATE_ENCRYPTED_EXACT_0096_PRODUCTION_BACKUP_RESTORE_DRILL_NO_MIGRATION";
export const PRODUCTION_EXACT_0096_MAX_ENCRYPTED_PAYLOAD_BYTES =
  256 * 1024 * 1024;
export const PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES = 512 * 1024;
export const PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS = 5 * 60 * 1000;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const HEX_ID = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,255}$/;
const DATABASE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;
const CANONICAL_TABLE = /^[a-z_][a-z0-9_$]*\.[a-z_][a-z0-9_$]*$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /(?:^|[?&;\s])(?:password|passwd|pwd|secret|access[_-]?token|api[_-]?key)=\S+/i,
];

// Frozen from lib/db/migrations/meta/0096_snapshot.json (snapshot id below),
// plus Drizzle's journal relation. A live catalog must reproduce this exact set.
export const PRODUCTION_EXACT_0096_SUPPORTED_RELATIONS = Object.freeze([
  "drizzle.__drizzle_migrations",
  "public.activities",
  "public.activity_attachments",
  "public.activity_extra_works",
  "public.activity_materials",
  "public.activity_visits",
  "public.attachments",
  "public.audit_log",
  "public.backup_log",
  "public.backup_settings",
  "public.billing_document_files",
  "public.billing_document_lines",
  "public.billing_document_merge_members",
  "public.billing_document_merges",
  "public.billing_document_references",
  "public.billing_documents",
  "public.billing_settings",
  "public.client_errors",
  "public.customer_contacts",
  "public.customer_site_attachments",
  "public.customer_sites",
  "public.customers",
  "public.device_credentials",
  "public.document_linking_settings",
  "public.email_import_accounts",
  "public.email_import_attachments",
  "public.email_import_log",
  "public.email_import_messages",
  "public.email_import_settings",
  "public.email_settings",
  "public.employee_leaves",
  "public.extraction_jobs",
  "public.health_log",
  "public.invoice_lines",
  "public.invoice_reminders",
  "public.invoice_source_links",
  "public.invoices",
  "public.job_assignees",
  "public.job_groups",
  "public.job_visits",
  "public.jobs",
  "public.leave_settings",
  "public.machines",
  "public.material_markup_rules",
  "public.materials",
  "public.openai_settings",
  "public.people",
  "public.person_hourly_rates",
  "public.ppe_assignments",
  "public.ppe_handover_documents",
  "public.ppe_handover_events",
  "public.ppe_items",
  "public.quote_invoice_links",
  "public.quote_items",
  "public.quotes",
  "public.recurring_invoice_generations",
  "public.recurring_invoice_templates",
  "public.security_questions",
  "public.supplier_parser_profiles",
  "public.switchboard_assignees",
  "public.switchboard_checklist_instances",
  "public.switchboard_checklist_responses",
  "public.switchboard_checklist_template_versions",
  "public.switchboard_checklist_templates",
  "public.switchboard_defects",
  "public.switchboard_documents",
  "public.switchboard_events",
  "public.switchboard_extracted_fields",
  "public.switchboard_field_registry",
  "public.switchboard_label_versions",
  "public.switchboard_measurements",
  "public.switchboard_photos",
  "public.switchboard_processing_jobs",
  "public.switchboard_protocol_versions",
  "public.switchboard_qr_access_logs",
  "public.switchboard_service_records",
  "public.switchboards",
  "public.tasks",
  "public.time_entries",
  "public.user_permission_overrides",
  "public.user_preferences",
  "public.user_sessions",
  "public.users",
  "public.warehouse_items",
  "public.warehouse_movements",
  "public.warehouse_price_history",
  "public.webauthn_credentials",
  "public.work_session_billing_links",
  "public.work_session_breaks",
  "public.work_session_events",
  "public.work_sessions",
]);
export const PRODUCTION_EXACT_0096_RELATION_MANIFEST = Object.freeze({
  schemaVersion: PRODUCTION_EXACT_0096_RELATION_MANIFEST_SCHEMA,
  source: "lib/db/migrations/meta/0096_snapshot.json#tables+drizzle-journal",
  sourceSnapshotId: "1c804503-6c96-4453-8bae-5f20d854810c",
  sourceFileLfSha256:
    "sha256:75ec78bc67dc60211d1c63560952347a2c11d3f92bb5f86f22d75e33fd94402e",
  contentDigestAlgorithm:
    "sha256-canonical-jsonl-column-order-pk-or-all-column-sort-v1",
  relationNames: PRODUCTION_EXACT_0096_SUPPORTED_RELATIONS,
  relationNamesSha256:
    "sha256:e33cf78623be6c405f46eb0bf044d95e4519a98ed4cec8e46d252469c72bedf3",
});

export const PRODUCTION_EXACT_0096_BASELINE = Object.freeze(
  frozenStateSummary(PRODUCTION_MIGRATION_PREFIX_STATES[0]),
);

export class ProductionExact0096BackupContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096BackupContractError";
    this.code = code;
  }
}

export function productionExact0096BackupFail(code, message) {
  throw new ProductionExact0096BackupContractError(code, message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalProductionExact0096BackupJson(value) {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

export function productionExact0096BackupSha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function rejectProductionExact0096BackupSecrets(
  value,
  field = "artifact",
) {
  const visit = (entry, path) => {
    if (typeof entry === "string") {
      if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(entry))) {
        productionExact0096BackupFail(
          "PRODUCTION_BACKUP_SECRET_REJECTED",
          `${path} resembles secret or credential material.`,
        );
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (entry && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        if (
          /^(?:password|passwd|privateKey|secretKey|clientSecret|credential|databaseUrl|connectionString|snapshotToken|accessToken|authToken|apiKey)$/i.test(
            key,
          )
        ) {
          productionExact0096BackupFail(
            "PRODUCTION_BACKUP_SECRET_REJECTED",
            `${path}.${key} is a forbidden evidence field.`,
          );
        }
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(value, field);
  return value;
}

export function createProductionExact0096BackupArtifact(value) {
  rejectProductionExact0096BackupSecrets(value);
  const canonical = canonicalProductionExact0096BackupJson(value);
  const size = Buffer.byteLength(canonical);
  if (size === 0 || size > PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ARTIFACT_INVALID",
      "Created artifact is empty or exceeds the canonical 512 KiB limit.",
    );
  }
  return Object.freeze({
    value: Object.freeze(value),
    canonical,
    sha256: productionExact0096BackupSha256(canonical),
  });
}

export function exactBackupObject(value, keys, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SCHEMA_INVALID",
      `${field} must be an object.`,
    );
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SCHEMA_INVALID",
      `${field} must contain only the reviewed fields.`,
    );
  }
  return value;
}

export function exactBackupString(value, field, maximumLength = 4096) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim()
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SCHEMA_INVALID",
      `${field} must be exact bounded non-empty text.`,
    );
  }
  rejectProductionExact0096BackupSecrets(value, field);
  return value;
}

export function exactBackupDigest(value, field) {
  const digest = exactBackupString(value, field, 71).toLowerCase();
  if (!DIGEST.test(digest) || /^sha256:0{64}$/.test(digest)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_DIGEST_INVALID",
      `${field} must be a non-zero SHA-256 digest.`,
    );
  }
  return digest;
}

export function exactBackupTimestamp(value, field) {
  const timestamp = exactBackupString(value, field, 24);
  const parsed = new Date(timestamp);
  if (!timestamp.endsWith("Z") || parsed.toISOString() !== timestamp) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_TIME_INVALID",
      `${field} must be canonical UTC.`,
    );
  }
  return parsed.getTime();
}

export function parseCanonicalProductionExact0096BackupArtifact(
  canonical,
  field,
  maximumBytes = PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
) {
  if (
    typeof canonical !== "string" ||
    Buffer.byteLength(canonical) === 0 ||
    Buffer.byteLength(canonical) > maximumBytes
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ARTIFACT_INVALID",
      `${field} is empty or too large.`,
    );
  }
  let value;
  try {
    value = JSON.parse(canonical);
  } catch {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ARTIFACT_INVALID",
      `${field} must be strict JSON.`,
    );
  }
  if (canonicalProductionExact0096BackupJson(value) !== canonical) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ARTIFACT_INVALID",
      `${field} must be canonical JSON with one trailing LF.`,
    );
  }
  rejectProductionExact0096BackupSecrets(value, field);
  return Object.freeze({
    value,
    canonical,
    sha256: productionExact0096BackupSha256(canonical),
  });
}

export function rejectBackupStagingIdentity(value, field) {
  const identity = exactBackupString(value, field, 128);
  if (identity.toLowerCase().includes("staging")) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_STAGING_IDENTITY_REJECTED",
      `${field} must not identify staging.`,
    );
  }
  return identity;
}

export function exactBackupSourceSha(value, field = "sourceSha") {
  const sourceSha = exactBackupString(value, field, 40);
  if (sourceSha !== sourceSha.toLowerCase()) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SOURCE_INVALID",
      `${field} must already be exact lowercase bytes.`,
    );
  }
  if (!GIT_SHA.test(sourceSha) || /^0{40}$/.test(sourceSha)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SOURCE_INVALID",
      `${field} must be an exact non-zero Git SHA.`,
    );
  }
  return sourceSha;
}

export function exactBackupId(value, field) {
  const id = exactBackupString(value, field, 128);
  if (!BOUNDED_ID.test(id)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ID_INVALID",
      `${field} must be an exact bounded identifier.`,
    );
  }
  return id;
}

export function exactBackupVersionId(value, field) {
  const id = exactBackupString(value, field, 256);
  if (
    !VERSION_ID.test(id) ||
    ["null", "none", "undefined"].includes(id.toLowerCase())
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_VERSION_ID_MISSING",
      `${field} must be the durable object or key version identifier.`,
    );
  }
  return id;
}

export function exactBackupPositiveInteger(value, field, ceiling) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (ceiling !== undefined && value > ceiling)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_INTEGER_INVALID",
      `${field} must be a positive bounded safe integer.`,
    );
  }
  return value;
}

export function exactBackupHexId(value, field) {
  const id = exactBackupString(value, field, 64);
  if (id !== id.toLowerCase()) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ID_INVALID",
      `${field} must already be exact lowercase bytes.`,
    );
  }
  if (!HEX_ID.test(id) || /^0{64}$/.test(id)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_ID_INVALID",
      `${field} must be a non-zero 64-character hexadecimal identity.`,
    );
  }
  return id;
}

export function exactBackupImmutableImage(value, field) {
  const image = exactBackupString(value, field, 512);
  if (image !== image.toLowerCase()) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_MUTABLE_REF_REJECTED",
      `${field} must already be exact lowercase bytes.`,
    );
  }
  if (!IMMUTABLE_IMAGE.test(image)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_MUTABLE_REF_REJECTED",
      `${field} must be an immutable registry digest reference.`,
    );
  }
  return image;
}

export function validateExact0096ProductionInventory(inventory, field) {
  let state;
  try {
    state = validateProductionMigrationInventory(inventory);
  } catch {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_BASELINE_INVALID",
      `${field} must preserve exact 97-known plus the two frozen opaque rows.`,
    );
  }
  if (state.stateIndex !== 0) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_BASELINE_INVALID",
      `${field} must be exact 0096, not another reviewed prefix.`,
    );
  }
  return Object.freeze({
    ...PRODUCTION_EXACT_0096_BASELINE,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  });
}

export function validateProductionSourceDatabase(value, field) {
  const database = exactBackupObject(
    value,
    ["name", "serverVersionMajor", "user"],
    field,
  );
  for (const key of ["name", "user"]) {
    const identity = rejectBackupStagingIdentity(
      database[key],
      `${field}.${key}`,
    );
    if (!DATABASE_IDENTIFIER.test(identity)) {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_DATABASE_INVALID",
        `${field}.${key} is not a bounded PostgreSQL identity.`,
      );
    }
  }
  if (database.serverVersionMajor !== 16) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_POSTGRES_VERSION_INVALID",
      `${field} must identify PostgreSQL 16.`,
    );
  }
  return Object.freeze({ ...database });
}

export function validateProductionImmutableRuntimeBinding(value, field) {
  const binding = exactBackupObject(
    value,
    [
      "applicationImageRef",
      "containerId",
      "deploymentConfigSha256",
      "networkId",
      "networkName",
      "postgresImageId",
      "postgresImageRef",
      "resolvedConfigSha256",
      "sourceSha",
      "volumeCreatedAt",
      "volumeLabelsSha256",
      "volumeName",
    ],
    field,
  );
  exactBackupSourceSha(binding.sourceSha, `${field}.sourceSha`);
  exactBackupImmutableImage(
    binding.applicationImageRef,
    `${field}.applicationImageRef`,
  );
  exactBackupImmutableImage(
    binding.postgresImageRef,
    `${field}.postgresImageRef`,
  );
  exactBackupDigest(binding.postgresImageId, `${field}.postgresImageId`);
  exactBackupHexId(binding.containerId, `${field}.containerId`);
  exactBackupHexId(binding.networkId, `${field}.networkId`);
  exactBackupId(
    rejectBackupStagingIdentity(binding.networkName, `${field}.networkName`),
    `${field}.networkName`,
  );
  exactBackupId(
    rejectBackupStagingIdentity(binding.volumeName, `${field}.volumeName`),
    `${field}.volumeName`,
  );
  exactBackupTimestamp(binding.volumeCreatedAt, `${field}.volumeCreatedAt`);
  exactBackupDigest(binding.volumeLabelsSha256, `${field}.volumeLabelsSha256`);
  exactBackupDigest(
    binding.resolvedConfigSha256,
    `${field}.resolvedConfigSha256`,
  );
  exactBackupDigest(
    binding.deploymentConfigSha256,
    `${field}.deploymentConfigSha256`,
  );
  return Object.freeze({ ...binding });
}

export function validateStoppedWritersProof(value, field) {
  const proof = exactBackupObject(
    value,
    [
      "activeApplicationSessions",
      "activeWriteTransactions",
      "databaseIdentitySha256",
      "databaseWritesObserved",
      "gracePeriodMs",
      "maintenanceWindowId",
      "mode",
      "observedAt",
      "proofId",
      "quiescentSince",
      "runningWriterContainerIds",
      "runtimeBindingSha256",
      "schemaVersion",
      "sourceSha",
    ],
    field,
  );
  if (
    proof.schemaVersion !== PRODUCTION_EXACT_0096_WRITERS_PROOF_SCHEMA ||
    proof.mode !== "production-maintenance-stopped-writers" ||
    proof.activeApplicationSessions !== 0 ||
    proof.activeWriteTransactions !== 0 ||
    proof.databaseWritesObserved !== 0 ||
    !Array.isArray(proof.runningWriterContainerIds) ||
    proof.runningWriterContainerIds.length !== 0
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_WRITERS_NOT_STOPPED",
      `${field} must prove an empty writer set and zero observed writes.`,
    );
  }
  exactBackupHexId(proof.proofId, `${field}.proofId`);
  exactBackupId(proof.maintenanceWindowId, `${field}.maintenanceWindowId`);
  exactBackupSourceSha(proof.sourceSha, `${field}.sourceSha`);
  exactBackupDigest(
    proof.runtimeBindingSha256,
    `${field}.runtimeBindingSha256`,
  );
  exactBackupDigest(
    proof.databaseIdentitySha256,
    `${field}.databaseIdentitySha256`,
  );
  const quiescentSince = exactBackupTimestamp(
    proof.quiescentSince,
    `${field}.quiescentSince`,
  );
  const observedAt = exactBackupTimestamp(
    proof.observedAt,
    `${field}.observedAt`,
  );
  exactBackupPositiveInteger(
    proof.gracePeriodMs,
    `${field}.gracePeriodMs`,
    900_000,
  );
  if (
    proof.gracePeriodMs < 60_000 ||
    observedAt - quiescentSince < proof.gracePeriodMs
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_WRITERS_NOT_STOPPED",
      `${field} must cover at least one complete 60-second quiescence window.`,
    );
  }
  return Object.freeze({ ...proof });
}

export function validateExact0096RelationManifest(value, field) {
  const manifest = exactBackupObject(
    value,
    [
      "contentDigestAlgorithm",
      "relationNames",
      "relationNamesSha256",
      "schemaVersion",
      "source",
      "sourceFileLfSha256",
      "sourceSnapshotId",
    ],
    field,
  );
  if (
    manifest.schemaVersion !== PRODUCTION_EXACT_0096_RELATION_MANIFEST_SCHEMA ||
    canonicalProductionExact0096BackupJson(manifest) !==
      canonicalProductionExact0096BackupJson(
        PRODUCTION_EXACT_0096_RELATION_MANIFEST,
      )
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_RELATION_MANIFEST_INVALID",
      `${field} must reproduce the frozen exact-0096 schema/catalog relation manifest.`,
    );
  }
  return PRODUCTION_EXACT_0096_RELATION_MANIFEST;
}

export function validateExact0096TableSnapshot(value, field) {
  const snapshot = exactBackupObject(
    value,
    [
      "catalogManifest",
      "dataSnapshotSha256",
      "exportedSnapshotIdPersisted",
      "exportedSnapshotUsed",
      "observedAt",
      "schemaVersion",
      "snapshotTokenSha256",
      "tableMeasurements",
      "tableMeasurementsSha256",
      "transactionMode",
      "unsupportedRelations",
    ],
    field,
  );
  const manifest = validateExact0096RelationManifest(
    snapshot.catalogManifest,
    `${field}.catalogManifest`,
  );
  if (
    snapshot.schemaVersion !== PRODUCTION_EXACT_0096_TABLE_SNAPSHOT_SCHEMA ||
    snapshot.exportedSnapshotUsed !== true ||
    snapshot.exportedSnapshotIdPersisted !== false ||
    snapshot.transactionMode !== "repeatable-read-read-only" ||
    !Array.isArray(snapshot.unsupportedRelations) ||
    snapshot.unsupportedRelations.length !== 0 ||
    !snapshot.tableMeasurements ||
    typeof snapshot.tableMeasurements !== "object" ||
    Array.isArray(snapshot.tableMeasurements)
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_SNAPSHOT_INVALID",
      `${field} must cover the frozen relation manifest from one exported read-only snapshot.`,
    );
  }
  exactBackupDigest(
    snapshot.snapshotTokenSha256,
    `${field}.snapshotTokenSha256`,
  );
  exactBackupTimestamp(snapshot.observedAt, `${field}.observedAt`);
  const names = Object.keys(snapshot.tableMeasurements).sort();
  if (JSON.stringify(names) !== JSON.stringify(manifest.relationNames)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_TABLE_COUNTS_INVALID",
      `${field} must measure every and only frozen exact-0096 relation.`,
    );
  }
  const normalized = {};
  for (const name of names) {
    if (!CANONICAL_TABLE.test(name)) {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_TABLE_COUNTS_INVALID",
        `${field}.${name} is not canonical.`,
      );
    }
    const measurement = exactBackupObject(
      snapshot.tableMeasurements[name],
      ["contentSha256", "rowCount"],
      `${field}.tableMeasurements.${name}`,
    );
    if (
      !Number.isSafeInteger(measurement.rowCount) ||
      measurement.rowCount < 0
    ) {
      productionExact0096BackupFail(
        "PRODUCTION_BACKUP_TABLE_COUNTS_INVALID",
        `${field}.${name}.rowCount is invalid.`,
      );
    }
    exactBackupDigest(
      measurement.contentSha256,
      `${field}.${name}.contentSha256`,
    );
    normalized[name] = Object.freeze({ ...measurement });
  }
  if (normalized["drizzle.__drizzle_migrations"].rowCount !== 99) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_TABLE_COUNTS_INVALID",
      `${field} must preserve 99 exact journal rows.`,
    );
  }
  const measurementsSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(normalized),
  );
  const dataSnapshotSha256 = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson({
      relationNamesSha256: manifest.relationNamesSha256,
      tableMeasurementsSha256: measurementsSha256,
    }),
  );
  if (
    snapshot.tableMeasurementsSha256 !== measurementsSha256 ||
    snapshot.dataSnapshotSha256 !== dataSnapshotSha256
  ) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_TABLE_CONTENT_INVALID",
      `${field} count/content digests are not canonically bound.`,
    );
  }
  return Object.freeze({
    ...snapshot,
    catalogManifest: manifest,
    tableMeasurements: Object.freeze(normalized),
  });
}

export function validateProductionBackupSafety(value, field) {
  const safety = exactBackupObject(
    value,
    [
      "destructiveRestore",
      "migrationExecution",
      "productionDatabaseWrites",
      "productionRestore",
      "retentionPrune",
    ],
    field,
  );
  if (Object.values(safety).some((entry) => entry !== false)) {
    productionExact0096BackupFail(
      "PRODUCTION_BACKUP_UNSAFE_ACTION_REJECTED",
      `${field} must deny production writes, migrations, pruning and destructive restore.`,
    );
  }
  return Object.freeze({ ...safety });
}

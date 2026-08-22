import {
  PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA,
  PRODUCTION_INVOICE_0108_PRE_STATE,
  parseProductionInvoice0108BackupReference,
} from "./production-invoice-0108-contract.mjs";
import {
  createProductionMigrationArtifact,
  exactDigest,
  exactObject,
  exactSourceSha,
  exactString,
  exactTimestamp,
  parseCanonicalProductionMigrationArtifact,
} from "./production-migration-contract.mjs";

export const PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA =
  "site-logbook.production-exact-0107-backup-restore-receipt/v1";

const STORAGE_ID = /^[a-z0-9][a-z0-9._/-]{0,255}$/;

function fail(code, message, options) {
  const error = new Error(`PRODUCTION_EXACT_0107_${code}: ${message}`, options);
  error.code = `PRODUCTION_EXACT_0107_${code}`;
  throw error;
}

function storageId(value, field) {
  const exact = exactString(value, field, 256);
  if (!STORAGE_ID.test(exact) || exact.includes("..")) {
    fail("BACKUP_RECEIPT_INVALID", `${field} is not a safe storage id.`);
  }
  return exact;
}

export function parseProductionExact0107BackupRestoreReceipt(canonical) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "exact0107BackupRestoreReceipt",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "decision",
      "receiptStorageId",
      "sourceSha",
      "sourceInventorySha256",
      "backupArtifactStorageId",
      "backupArtifactSha256",
      "backupArtifactBytes",
      "backupEncryptionFormat",
      "backupCompletedAt",
      "restoreVerifiedAt",
      "restoreInventorySha256",
      "sourceTableCountsSha256",
      "restoreTableCountsSha256",
      "restoreDatabaseIsDisposable",
      "runtimeRole",
      "writersStoppedBeforeAt",
      "writersStoppedAfterAt",
      "productionRestorePerformed",
      "authorizesProductionMigration",
    ],
    "exact0107BackupRestoreReceipt",
  );
  if (
    value.schemaVersion !==
      PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA ||
    value.kind !==
      "site-logbook-production-exact-0107-backup-restore-receipt" ||
    value.decision !== "PASS" ||
    value.backupEncryptionFormat !== "mve1" ||
    value.restoreDatabaseIsDisposable !== true ||
    value.productionRestorePerformed !== false ||
    value.authorizesProductionMigration !== false
  ) {
    fail(
      "BACKUP_RECEIPT_INVALID",
      "Receipt must prove a PASS disposable restore without authorizing migration.",
    );
  }
  storageId(value.receiptStorageId, "receipt.receiptStorageId");
  storageId(value.backupArtifactStorageId, "receipt.backupArtifactStorageId");
  exactSourceSha(value.sourceSha, "receipt.sourceSha");
  exactDigest(value.sourceInventorySha256, "receipt.sourceInventorySha256");
  exactDigest(value.backupArtifactSha256, "receipt.backupArtifactSha256");
  exactDigest(value.restoreInventorySha256, "receipt.restoreInventorySha256");
  exactDigest(value.sourceTableCountsSha256, "receipt.sourceTableCountsSha256");
  exactDigest(
    value.restoreTableCountsSha256,
    "receipt.restoreTableCountsSha256",
  );
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/.test(
      exactString(value.runtimeRole, "receipt.runtimeRole", 63),
    )
  ) {
    fail("BACKUP_RECEIPT_INVALID", "Receipt runtime role is invalid.");
  }
  if (
    !Number.isSafeInteger(value.backupArtifactBytes) ||
    value.backupArtifactBytes <= 0
  ) {
    fail(
      "BACKUP_RECEIPT_INVALID",
      "Receipt backup byte length must be a positive safe integer.",
    );
  }
  const backupCompletedAt = exactTimestamp(
    value.backupCompletedAt,
    "receipt.backupCompletedAt",
  );
  const restoreVerifiedAt = exactTimestamp(
    value.restoreVerifiedAt,
    "receipt.restoreVerifiedAt",
  );
  const writersStoppedBeforeAt = exactTimestamp(
    value.writersStoppedBeforeAt,
    "receipt.writersStoppedBeforeAt",
  );
  const writersStoppedAfterAt = exactTimestamp(
    value.writersStoppedAfterAt,
    "receipt.writersStoppedAfterAt",
  );
  if (
    backupCompletedAt < writersStoppedBeforeAt ||
    restoreVerifiedAt < backupCompletedAt ||
    writersStoppedAfterAt < restoreVerifiedAt ||
    value.sourceInventorySha256 !==
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256 ||
    value.restoreInventorySha256 !== value.sourceInventorySha256 ||
    value.restoreTableCountsSha256 !== value.sourceTableCountsSha256
  ) {
    fail(
      "BACKUP_RECEIPT_INVALID",
      "Receipt does not bind one exact-0107 source and restored inventory.",
    );
  }
  return Object.freeze({ artifact, value: Object.freeze({ ...value }) });
}

export function createProductionExact0107BackupRestoreReference({
  receiptStorageId,
  receiptCanonical,
}) {
  const receipt =
    parseProductionExact0107BackupRestoreReceipt(receiptCanonical);
  const id = storageId(receiptStorageId, "receiptStorageId");
  if (receipt.value.receiptStorageId !== id) {
    fail(
      "BACKUP_REFERENCE_INVALID",
      "Receipt storage identity differs from the durable receipt.",
    );
  }
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_INVOICE_0108_BACKUP_REFERENCE_SCHEMA,
    kind: "site-logbook-production-exact-0107-backup-restore-reference",
    receiptStorageId: id,
    receiptSha256: receipt.artifact.sha256,
    sourceSha: receipt.value.sourceSha,
    sourceInventorySha256: receipt.value.sourceInventorySha256,
    backupCompletedAt: receipt.value.backupCompletedAt,
    restoreVerifiedAt: receipt.value.restoreVerifiedAt,
    decision: "PASS",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
}

export function createProductionInvoice0108BackupAuthority({
  loadReceiptCanonical,
  expectedRuntimeRole,
}) {
  if (
    typeof loadReceiptCanonical !== "function" ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(String(expectedRuntimeRole))
  ) {
    fail(
      "BACKUP_AUTHORITY_UNAVAILABLE",
      "A durable exact-0107 receipt loader is required.",
    );
  }
  return Object.freeze({
    async assertFreshExact0107BackupRestoreReceipt({
      referenceCanonical,
      at,
      expectedInventorySha256,
    }) {
      const reference = parseProductionInvoice0108BackupReference(
        referenceCanonical,
        { at },
      );
      if (
        reference.value.sourceInventorySha256 !== expectedInventorySha256 ||
        expectedInventorySha256 !==
          PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256
      ) {
        fail(
          "BACKUP_REFERENCE_INVALID",
          "Reference is not bound to the exact-0107 source inventory.",
        );
      }
      let receiptCanonical;
      try {
        receiptCanonical = await loadReceiptCanonical(
          reference.value.receiptStorageId,
        );
      } catch (error) {
        fail(
          "BACKUP_RECEIPT_UNAVAILABLE",
          "The referenced durable backup receipt is unavailable.",
          { cause: error },
        );
      }
      const receipt =
        parseProductionExact0107BackupRestoreReceipt(receiptCanonical);
      if (receipt.value.runtimeRole !== expectedRuntimeRole) {
        fail(
          "BACKUP_REFERENCE_INVALID",
          "Receipt runtime role differs from the migration descriptor.",
        );
      }
      for (const [field, actual, expected] of [
        [
          "receiptSha256",
          receipt.artifact.sha256,
          reference.value.receiptSha256,
        ],
        [
          "receiptStorageId",
          receipt.value.receiptStorageId,
          reference.value.receiptStorageId,
        ],
        ["sourceSha", receipt.value.sourceSha, reference.value.sourceSha],
        [
          "sourceInventorySha256",
          receipt.value.sourceInventorySha256,
          reference.value.sourceInventorySha256,
        ],
        [
          "backupCompletedAt",
          receipt.value.backupCompletedAt,
          reference.value.backupCompletedAt,
        ],
        [
          "restoreVerifiedAt",
          receipt.value.restoreVerifiedAt,
          reference.value.restoreVerifiedAt,
        ],
      ]) {
        if (actual !== expected) {
          fail(
            "BACKUP_REFERENCE_INVALID",
            `${field} differs from the durable exact-0107 receipt.`,
          );
        }
      }
      return receipt;
    },
  });
}

import assert from "node:assert/strict";
import test from "node:test";

import {
  PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA,
  createProductionExact0107BackupRestoreReference,
  createProductionInvoice0108BackupAuthority,
  parseProductionExact0107BackupRestoreReceipt,
} from "../production-evidence/production-exact-0107-backup-authority.mjs";
import { PRODUCTION_INVOICE_0108_PRE_STATE } from "../production-evidence/production-invoice-0108-contract.mjs";
import { createProductionMigrationArtifact } from "../production-evidence/production-migration-contract.mjs";

const SOURCE_SHA = "1".repeat(40);
const RECEIPT_ID = "exact-0107/backup-restore-receipt.json";
const BACKUP_AT = "2026-08-23T10:00:00.000Z";
const RESTORE_AT = "2026-08-23T10:05:00.000Z";

function receipt(overrides = {}) {
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_EXACT_0107_BACKUP_RESTORE_RECEIPT_SCHEMA,
    kind: "site-logbook-production-exact-0107-backup-restore-receipt",
    decision: "PASS",
    receiptStorageId: RECEIPT_ID,
    sourceSha: SOURCE_SHA,
    sourceInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    backupArtifactStorageId: "exact-0107/database.dump",
    backupArtifactSha256: `sha256:${"2".repeat(64)}`,
    backupArtifactBytes: 4096,
    backupCompletedAt: BACKUP_AT,
    restoreVerifiedAt: RESTORE_AT,
    restoreInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    restoreDatabaseIsDisposable: true,
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
    ...overrides,
  });
}

test("creates a non-authorizing exact-0107 reference and revalidates its durable receipt", async () => {
  const durableReceipt = receipt();
  const reference = createProductionExact0107BackupRestoreReference({
    receiptStorageId: RECEIPT_ID,
    receiptCanonical: durableReceipt.canonical,
  });
  const authority = createProductionInvoice0108BackupAuthority({
    loadReceiptCanonical: async (storageId) => {
      assert.equal(storageId, RECEIPT_ID);
      return durableReceipt.canonical;
    },
  });
  const verified = await authority.assertFreshExact0107BackupRestoreReceipt({
    referenceCanonical: reference.canonical,
    at: "2026-08-23T10:30:00.000Z",
    expectedInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
  });
  assert.equal(verified.artifact.sha256, durableReceipt.sha256);
  assert.equal(reference.value.authorizesProductionMigration, false);
  assert.equal(reference.value.productionRestorePerformed, false);
});

test("rejects a restored inventory that differs from the exact-0107 source", () => {
  const drifted = receipt({
    restoreInventorySha256: `sha256:${"f".repeat(64)}`,
  });
  assert.throws(
    () => parseProductionExact0107BackupRestoreReceipt(drifted.canonical),
    /PRODUCTION_EXACT_0107_BACKUP_RECEIPT_INVALID/,
  );
});

test("rejects a reference when durable receipt bytes were substituted", async () => {
  const durableReceipt = receipt();
  const reference = createProductionExact0107BackupRestoreReference({
    receiptStorageId: RECEIPT_ID,
    receiptCanonical: durableReceipt.canonical,
  });
  const substituted = receipt({ backupArtifactBytes: 8192 });
  const authority = createProductionInvoice0108BackupAuthority({
    loadReceiptCanonical: async () => substituted.canonical,
  });
  await assert.rejects(
    authority.assertFreshExact0107BackupRestoreReceipt({
      referenceCanonical: reference.canonical,
      at: "2026-08-23T10:30:00.000Z",
      expectedInventorySha256:
        PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    }),
    /PRODUCTION_EXACT_0107_BACKUP_REFERENCE_INVALID/,
  );
});

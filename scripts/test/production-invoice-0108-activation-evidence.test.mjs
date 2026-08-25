import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
  PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
  parseProductionActivation0108Approval,
  parseProductionActivation0108Readiness,
} from "../../artifacts/api-server/src/lib/production-activation-0108-contract.ts";
import { canonicalProductionActivationJson } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import {
  PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA,
  PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION,
  PRODUCTION_INVOICE_0108_READINESS_CONFIRMATION,
  executeProductionInvoice0108ActivationEvidence,
} from "../production-evidence/run-production-invoice-0108-activation-evidence.mjs";
import {
  PRODUCTION_INVOICE_0108_CONFIRMATION,
  PRODUCTION_INVOICE_0108_MIGRATION,
  PRODUCTION_INVOICE_0108_POST_STATE,
  PRODUCTION_INVOICE_0108_PRE_STATE,
  createProductionInvoice0108Intent,
  createProductionInvoice0108Plan,
  createProductionInvoice0108Receipt,
} from "../production-evidence/production-invoice-0108-contract.mjs";
import {
  PRODUCTION_OPAQUE_LEGACY_ROWS,
  PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  createProductionMigrationArtifact,
} from "../production-evidence/production-migration-contract.mjs";

const SOURCE_SHA = "1".repeat(40);
const SCHEMA_FINGERPRINT = `sha256:${"2".repeat(64)}`;
const PROJECTION = `sha256:${"3".repeat(64)}`;

function liveReadiness() {
  return {
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256: SCHEMA_FINGERPRINT,
    invoiceSchemaProjectionSha256: PROJECTION,
    latestKnownAppliedTag:
      PRODUCTION_INVOICE_0108_POST_STATE.latestKnownAppliedTag,
    knownExpectedMigrations: 108,
    knownAppliedMigrations: 108,
    knownAppliedRowsSha256:
      PRODUCTION_INVOICE_0108_POST_STATE.knownAppliedRowsSha256,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    excludedMigration0100Present: false,
    externalAuditRowCount: 0,
    auditSchemaReady: true,
    integrityValid: true,
    postMigrationIntegrityValid: true,
    trustedAuditGenesis: true,
    invoice0108Ready: true,
    roleDeltaReady: true,
  };
}

function inventory(state) {
  const expected =
    state === "pre"
      ? PRODUCTION_INVOICE_0108_PRE_STATE
      : PRODUCTION_INVOICE_0108_POST_STATE;
  return {
    knownAppliedMigrations: expected.knownAppliedMigrations,
    knownAppliedRowsSha256: expected.knownAppliedRowsSha256,
    latestKnownAppliedTag: expected.latestKnownAppliedTag,
    missingKnownMigrationTags: [...expected.missingKnownMigrationTags],
    unexpectedKnownMigrationTags: [],
    opaqueLegacyRows: PRODUCTION_OPAQUE_LEGACY_ROWS.map((row) => ({ ...row })),
    excludedMigration0100Present: false,
    totalJournalRows: expected.totalJournalRows,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "invoice-0108-evidence-"));
  const migrations = path.join(root, "migrations");
  const inputs = path.join(root, "inputs");
  const outputs = path.join(root, "outputs");
  await Promise.all([mkdir(migrations), mkdir(inputs), mkdir(outputs)]);
  const backup = createProductionMigrationArtifact({
    schemaVersion:
      "site-logbook.production-exact-0107-backup-restore-reference/v1",
    kind: "site-logbook-production-exact-0107-backup-restore-reference",
    receiptStorageId: "exact-0107/receipt.json",
    receiptSha256: `sha256:${"4".repeat(64)}`,
    sourceSha: PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
    sourceInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    backupCompletedAt: "2026-08-23T09:00:00.000Z",
    restoreVerifiedAt: "2026-08-23T09:01:00.000Z",
    decision: "PASS",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
  const plan = createProductionInvoice0108Plan({
    sourceSha: PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
    backupRestoreReferenceCanonical: backup.canonical,
    createdAt: "2026-08-23T09:10:00.000Z",
  });
  const intent = createProductionInvoice0108Intent({
    planCanonical: plan.canonical,
    intentId: "5".repeat(64),
    operator: "modvolt-release-owner",
    createdAt: "2026-08-23T09:10:00.000Z",
    confirmation: PRODUCTION_INVOICE_0108_CONFIRMATION,
  });
  const migrationReceipt = createProductionInvoice0108Receipt({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    before: inventory("pre"),
    after: inventory("post"),
    transactionStartedAt: "2026-08-23T09:20:00.000Z",
    transactionCompletedAt: "2026-08-23T09:21:00.000Z",
  });
  const roleReceipt = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-invoice-0108-role-delta-receipt/v1",
    kind: "site-logbook-production-invoice-0108-role-delta-receipt",
    decision: "PASS",
    migration: PRODUCTION_INVOICE_0108_MIGRATION.tag,
    migrationSha256: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
    migrationReceiptSha256: migrationReceipt.sha256,
    base0107PlanSha256: `sha256:${"6".repeat(64)}`,
    deltaPlanSha256: `sha256:${"7".repeat(64)}`,
    preProjectionSha256: `sha256:${"8".repeat(64)}`,
    postProjectionSha256: `sha256:${"9".repeat(64)}`,
    authoritySourceSha256: `sha256:${"a".repeat(64)}`,
    transactionCommitted: true,
    completedAt: "2026-08-23T09:22:00.000Z",
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  });
  const predecessorEvidence = {
    activationApproval: { predecessor: true },
    apiImageProvenance: { predecessor: true },
    exact0096Backup: { predecessor: true },
    finalObservations: { predecessor: true },
    migration0096To0107: { predecessor: true },
    runtimeDatabaseCredentialCutover: { predecessor: true },
  };
  const challenge = {
    kind: "site-logbook-production-activation-challenge-v3",
    sourceSha: SOURCE_SHA,
    apiImage: `ghcr.io/modvolt/site-logbook-api@sha256:${"b".repeat(64)}`,
    containerId: "c".repeat(64),
    nonce: "d".repeat(64),
  };
  const files = {
    predecessorEvidence: "inputs/predecessor.json",
    backupRestoreReference: "inputs/backup.json",
    plan: "inputs/plan.json",
    intent: "inputs/intent.json",
    migrationReceipt: "inputs/migration-receipt.json",
    roleReceipt: "inputs/role-receipt.json",
    challenge: "inputs/challenge.json",
  };
  await Promise.all([
    writeFile(
      path.join(root, files.predecessorEvidence),
      canonicalProductionActivationJson(predecessorEvidence),
    ),
    writeFile(path.join(root, files.backupRestoreReference), backup.canonical),
    writeFile(path.join(root, files.plan), plan.canonical),
    writeFile(path.join(root, files.intent), intent.canonical),
    writeFile(
      path.join(root, files.migrationReceipt),
      migrationReceipt.canonical,
    ),
    writeFile(path.join(root, files.roleReceipt), roleReceipt.canonical),
    writeFile(
      path.join(root, files.challenge),
      canonicalProductionActivationJson(challenge),
    ),
  ]);
  const descriptorFile = path.join(root, "descriptor.json");
  const descriptor = {
    schemaVersion:
      PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA,
    kind: "site-logbook-production-invoice-0108-activation-evidence",
    executionDefault: "disabled",
    sourceSha: SOURCE_SHA,
    migrationsDirectory: "migrations",
    outputDirectory: "outputs",
    connection: {
      environmentVariable: "PRODUCTION_INVOICE_0108_RUNTIME_DATABASE_URL",
      databaseName: "site_logbook",
      databaseUser: "site_logbook_runtime",
      expectedSchemaFingerprintSha256: SCHEMA_FINGERPRINT,
    },
    inputs: files,
    authorizesApplicationStart: false,
  };
  await writeFile(
    descriptorFile,
    canonicalProductionActivationJson(descriptor),
  );
  return { root, descriptorFile, outputs, migrationReceipt, roleReceipt };
}

test("creates readiness, attended approval and exact v3 evidence without publishing or starting", async () => {
  const files = await fixture();
  const environment = {
    BUILD_SHA: SOURCE_SHA,
    PRODUCTION_INVOICE_0108_RUNTIME_DATABASE_URL:
      "postgres://runtime:redacted@db/site_logbook",
  };
  try {
    const readinessResult =
      await executeProductionInvoice0108ActivationEvidence(
        [
          "readiness",
          "--descriptor",
          files.descriptorFile,
          "--checked-at",
          "2026-08-23T09:23:00.000Z",
          "--confirmation",
          PRODUCTION_INVOICE_0108_READINESS_CONFIRMATION,
        ],
        {
          environment,
          verifyReadiness: async () => liveReadiness(),
        },
      );
    assert.equal(readinessResult.authorizesApplicationStart, false);
    const readinessCanonical = await readFile(
      path.join(files.outputs, "invoice-0108-schema-readiness.json"),
      "utf8",
    );
    assert.equal(
      parseProductionActivation0108Readiness(readinessCanonical).lineage
        .decision,
      "ALREADY_0108",
    );

    const approvalResult = await executeProductionInvoice0108ActivationEvidence(
      [
        "approve",
        "--descriptor",
        files.descriptorFile,
        "--operator",
        "modvolt-release-owner",
        "--approved-at",
        "2026-08-23T09:24:00.000Z",
        "--confirmation",
        PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
      ],
      { environment },
    );
    assert.equal(approvalResult.authorizesDeployment, false);
    const approvalCanonical = await readFile(
      path.join(files.outputs, "invoice-0108-activation-approval.json"),
      "utf8",
    );
    assert.equal(
      parseProductionActivation0108Approval(approvalCanonical).decision,
      "APPROVE",
    );

    const assembled = await executeProductionInvoice0108ActivationEvidence(
      [
        "assemble",
        "--descriptor",
        files.descriptorFile,
        "--confirmation",
        PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION,
      ],
      { environment },
    );
    assert.equal(assembled.authorizesPublication, false);
    const evidence = JSON.parse(
      await readFile(
        path.join(files.outputs, "activation-evidence-v3.json"),
        "utf8",
      ),
    );
    assert.match(
      evidence.migration0107To0108.schemaReadiness.sha256,
      /^[0-9a-f]{64}$/u,
    );
    assert.equal(
      evidence.migration0107To0108.migrationReceipt.payload.decision,
      "PASS",
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

test("readiness output is no-clobber", async () => {
  const files = await fixture();
  try {
    await writeFile(
      path.join(files.outputs, "invoice-0108-schema-readiness.json"),
      "operator-owned\n",
    );
    await assert.rejects(
      executeProductionInvoice0108ActivationEvidence(
        [
          "readiness",
          "--descriptor",
          files.descriptorFile,
          "--checked-at",
          "2026-08-23T09:23:00.000Z",
          "--confirmation",
          PRODUCTION_INVOICE_0108_READINESS_CONFIRMATION,
        ],
        {
          environment: {
            BUILD_SHA: SOURCE_SHA,
            PRODUCTION_INVOICE_0108_RUNTIME_DATABASE_URL: "redacted",
          },
          verifyReadiness: async () => liveReadiness(),
        },
      ),
      { code: "EEXIST" },
    );
  } finally {
    await rm(files.root, { recursive: true, force: true });
  }
});

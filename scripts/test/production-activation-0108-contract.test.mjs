import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
  PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
  PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
  PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA,
  PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
  createProductionActivation0108ContractTestVerifier,
} from "../../artifacts/api-server/src/lib/production-activation-0108-contract.ts";
import { canonicalProductionActivationJson } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import { validateProductionActivationBundleTransport } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import {
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

const sourceSha = "32fb8ec737e513421ec359da63cc870c8e078c7f";
const apiImage = `ghcr.io/modvolt/site-logbook-production-api@sha256:${"a".repeat(64)}`;
const nonce = "b".repeat(64);
const containerId = "c".repeat(64);
const schemaFingerprintSha256 = `sha256:${"d".repeat(64)}`;
const invoiceSchemaProjectionSha256 = `sha256:${"e".repeat(64)}`;

function wrap(value) {
  const canonical = canonicalProductionActivationJson(value);
  return {
    kind: "site-logbook-canonical-json",
    payload: value,
    sha256: createHash("sha256").update(canonical).digest("hex"),
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

function fixture({
  migrationSourceSha = PRODUCTION_INVOICE_0108_MIGRATION_EXECUTION_SOURCE_SHA,
} = {}) {
  const backup = createProductionMigrationArtifact({
    schemaVersion:
      "site-logbook.production-exact-0107-backup-restore-reference/v1",
    kind: "site-logbook-production-exact-0107-backup-restore-reference",
    receiptStorageId: "fixture-exact-0107-backup.json",
    receiptSha256: `sha256:${"1".repeat(64)}`,
    sourceSha: migrationSourceSha,
    sourceInventorySha256:
      PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
    backupCompletedAt: "2026-08-23T09:00:00.000Z",
    restoreVerifiedAt: "2026-08-23T09:01:00.000Z",
    decision: "PASS",
    productionRestorePerformed: false,
    authorizesProductionMigration: false,
  });
  const plan = createProductionInvoice0108Plan({
    sourceSha: migrationSourceSha,
    backupRestoreReferenceCanonical: backup.canonical,
    createdAt: "2026-08-23T09:10:00.000Z",
  });
  const intent = createProductionInvoice0108Intent({
    planCanonical: plan.canonical,
    intentId: "2".repeat(64),
    operator: "activation-0108-test",
    createdAt: "2026-08-23T09:10:00.000Z",
    confirmation:
      "APPLY_EXACT_0108_INVOICE_UPGRADE_TO_EXACT_0107_MODVOLT_PRODUCTION",
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
    base0107PlanSha256: `sha256:${"3".repeat(64)}`,
    deltaPlanSha256: `sha256:${"4".repeat(64)}`,
    preProjectionSha256: `sha256:${"5".repeat(64)}`,
    postProjectionSha256: `sha256:${"6".repeat(64)}`,
    authoritySourceSha256: `sha256:${"7".repeat(64)}`,
    transactionCommitted: true,
    completedAt: "2026-08-23T09:22:00.000Z",
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  });
  const lineage = {
    decision: "ALREADY_0108",
    mode: "production-copy-restricted",
    knownExpectedMigrations: 108,
    knownAppliedMigrations: 108,
    knownAppliedRowsSha256:
      PRODUCTION_INVOICE_0108_POST_STATE.knownAppliedRowsSha256,
    latestKnownAppliedTag:
      PRODUCTION_INVOICE_0108_POST_STATE.latestKnownAppliedTag,
    missingKnownToPredecessor: 0,
    opaqueLegacyRowCount: 2,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    opaqueLegacyMeaningInferred: false,
    excludedMigration0100Present: false,
  };
  const readinessValue = {
    schemaVersion: PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA,
    kind: "site-logbook-production-invoice-0108-activation-readiness",
    decision: "PASS",
    sourceSha,
    databaseName: "site_logbook",
    databaseUser: "site_logbook_runtime",
    schemaFingerprintSha256,
    invoiceSchemaProjectionSha256,
    migrationReceiptSha256: migrationReceipt.sha256,
    roleReceiptSha256: roleReceipt.sha256,
    lineage,
    checkedAt: "2026-08-23T09:23:00.000Z",
    authorizesApplicationStart: false,
  };
  const readiness = wrap(readinessValue);
  const approvalValue = {
    schemaVersion: PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
    kind: "site-logbook-production-invoice-0108-activation-approval",
    decision: "APPROVE",
    confirmation: PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
    sourceSha,
    apiImage,
    nonce,
    containerId,
    schemaReadinessSha256: `sha256:${readiness.sha256}`,
    migrationReceiptSha256: migrationReceipt.sha256,
    roleReceiptSha256: roleReceipt.sha256,
    invoiceSchemaProjectionSha256,
    approvedAt: "2026-08-23T09:27:00.000Z",
    operator: "activation-0108-test",
    authorizesApplicationStart: true,
    authorizesDeployment: false,
  };
  const overlay = {
    activationApproval: wrap(approvalValue),
    backupRestoreReference: wrap(backup.value),
    intent: wrap(intent.value),
    migrationReceipt: wrap(migrationReceipt.value),
    plan: wrap(plan.value),
    roleReceipt: wrap(roleReceipt.value),
    schemaReadiness: readiness,
  };
  const observed = (at) => wrap({ observedAt: at });
  const simple = (kind, extra = {}) => wrap({ kind, ...extra });
  const evidence = {
    activationApproval: wrap({ predecessor: true }),
    apiImageProvenance: {
      canonical: "{}\n",
      signatureB64: Buffer.alloc(64, 8).toString("base64"),
    },
    exact0096Backup: {
      plan: simple("backup-plan"),
      trace: simple("backup-trace"),
      passReceipt: simple("backup-pass-receipt"),
      signature: simple("backup-signature"),
      detachedSignature: simple("backup-detached-signature"),
    },
    migration0096To0107: {
      plan: simple("migration-plan"),
      intent: simple("migration-intent"),
      persistence: simple("migration-persistence"),
      receipts: Array.from({ length: 10 }, (_, index) =>
        simple("migration-receipt", { index }),
      ),
      finalLive: simple("migration-final-live"),
      role: simple("migration-role"),
      postcommit: simple("migration-postcommit"),
      transitionPass: simple("migration-transition-pass"),
    },
    runtimeDatabaseCredentialCutover: {
      request: simple("runtime-credential-request"),
      passReceipt: simple("runtime-credential-pass-receipt"),
    },
    finalObservations: {
      coolify: observed("2026-08-23T09:24:00.000Z"),
      docker: observed("2026-08-23T09:25:00.000Z"),
      postgres: observed("2026-08-23T09:26:00.000Z"),
    },
    migration0107To0108: overlay,
  };
  return {
    bundle: {
      activation: {
        schemaVersion: 3,
        kind: "site-logbook-production-activation-bundle-v3",
        sourceSha,
        apiImage,
        nonce,
        containerId,
        evidence,
        issuedAt: "2026-08-23T09:28:00.000Z",
      },
      activationSignature: {},
      hostAttestation: {
        schemaVersion: 3,
        kind: "site-logbook-production-host-attestation-v3",
      },
      hostAttestationSignature: {},
    },
    evidence,
  };
}

const predecessorSummary = Object.freeze({
  sourceSha,
  apiImage,
  apiImageDigest: `sha256:${"a".repeat(64)}`,
  publicationReceiptSha256: `sha256:${"8".repeat(64)}`,
  reviewedImageSetSha256: `sha256:${"9".repeat(64)}`,
  apiRunnableManifestDigest: `sha256:${"a".repeat(64)}`,
  apiOciProvenanceSha256: `sha256:${"b".repeat(64)}`,
  postgresImage: `postgres@sha256:${"c".repeat(64)}`,
  targetEvidenceSha256: `sha256:${"d".repeat(64)}`,
  releaseEvidenceSha256: `sha256:${"e".repeat(64)}`,
  resolvedComposeSha256: `sha256:${"f".repeat(64)}`,
  deployedConfigSha256: `sha256:${"1".repeat(64)}`,
  desiredConfigSha256: `sha256:${"1".repeat(64)}`,
  livePostgresTargetSha256: `sha256:${"2".repeat(64)}`,
  databaseName: "site_logbook",
  databaseUser: "site_logbook_runtime",
  schemaFingerprintSha256,
  preMigrationBackupEvidenceSha256: `sha256:${"3".repeat(64)}`,
  backupIntegritySha256: `sha256:${"4".repeat(64)}`,
  transitionChainSha256: `sha256:${"5".repeat(64)}`,
  activationApprovalSha256: `sha256:${"6".repeat(64)}`,
  lineage: { decision: "ALREADY_0107" },
});

test("v3 semantic contract binds exact 0108 receipts, readiness and attended approval", async () => {
  const { bundle } = fixture();
  const verify = createProductionActivation0108ContractTestVerifier(
    PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
  );
  const result = await verify(bundle, async (predecessor) => {
    assert.equal(predecessor.activation.schemaVersion, 2);
    assert.equal(
      Object.hasOwn(predecessor.activation.evidence, "migration0107To0108"),
      false,
    );
    return predecessorSummary;
  });
  assert.equal(result.lineage.decision, "ALREADY_0108");
  assert.equal(
    result.invoiceSchemaProjectionSha256,
    invoiceSchemaProjectionSha256,
  );
  assert.match(
    result.invoice0108MigrationReceiptSha256,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.match(result.invoice0108RoleReceiptSha256, /^sha256:[0-9a-f]{64}$/u);
});

test("one exact v3 bundle passes both signed transport and 0108 semantics", async () => {
  const { bundle: partial } = fixture();
  const publisher = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  const root = await mkdtemp(path.join(os.tmpdir(), "activation-0108-e2e-"));
  const publisherFile = path.join(root, "publisher.pem");
  const hostFile = path.join(root, "host.pem");
  try {
    await Promise.all([
      writeFile(
        publisherFile,
        publisher.publicKey.export({ type: "spki", format: "pem" }),
      ),
      writeFile(
        hostFile,
        host.publicKey.export({ type: "spki", format: "pem" }),
      ),
    ]);
    const rawSha = (value) => createHash("sha256").update(value).digest("hex");
    const keyId = (key) =>
      `sha256:${rawSha(key.export({ type: "spki", format: "der" }))}`;
    const desiredConfigSha256 = "1".repeat(64);
    const resolvedComposeSha256 = "2".repeat(64);
    const evidence = partial.activation.evidence;
    const hostAttestation = {
      schemaVersion: 3,
      kind: "site-logbook-production-host-attestation-v3",
      sourceSha,
      apiImage,
      desiredConfigSha256,
      deployedConfigSha256: desiredConfigSha256,
      resolvedComposeSha256,
      containerId,
      nonce,
      activationEvidenceSha256: rawSha(
        canonicalProductionActivationJson(evidence),
      ),
      observedAt: "2026-08-23T09:26:00.000Z",
    };
    const activation = {
      schemaVersion: 3,
      kind: "site-logbook-production-activation-bundle-v3",
      sourceSha,
      apiImage,
      desiredConfigSha256,
      deployedConfigSha256: desiredConfigSha256,
      resolvedComposeSha256,
      containerId,
      nonce,
      evidence,
      hostAttestationSha256: rawSha(
        canonicalProductionActivationJson(hostAttestation),
      ),
      issuedAt: "2026-08-23T09:28:00.000Z",
      expiresAt: "2026-08-23T09:33:00.000Z",
    };
    const activationCanonical = canonicalProductionActivationJson(activation);
    const hostCanonical = canonicalProductionActivationJson(hostAttestation);
    const transportBundle = {
      activation,
      activationSignature: {
        algorithm: "Ed25519",
        keyId: keyId(publisher.publicKey),
        signatureBase64: sign(
          null,
          Buffer.from(activationCanonical),
          publisher.privateKey,
        ).toString("base64"),
      },
      hostAttestation,
      hostAttestationSignature: {
        algorithm: "Ed25519",
        keyId: keyId(host.publicKey),
        signatureBase64: sign(
          null,
          Buffer.from(hostCanonical),
          host.privateKey,
        ).toString("base64"),
      },
    };
    const parsed = await validateProductionActivationBundleTransport(
      Buffer.from(canonicalProductionActivationJson(transportBundle)),
      { sourceSha, apiImage, containerId, nonce },
      publisherFile,
      keyId(publisher.publicKey),
      hostFile,
      keyId(host.publicKey),
      Date.parse("2026-08-23T09:29:00.000Z"),
      3,
    );
    const verify = createProductionActivation0108ContractTestVerifier(
      PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
    );
    const result = await verify(parsed, async () => predecessorSummary);
    assert.equal(result.lineage.decision, "ALREADY_0108");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 semantic contract rejects a receipt/readiness cross-binding mismatch", async () => {
  const { bundle, evidence } = fixture();
  const tampered = structuredClone(bundle);
  const approval = structuredClone(
    evidence.migration0107To0108.activationApproval.payload,
  );
  approval.roleReceiptSha256 = `sha256:${"f".repeat(64)}`;
  tampered.activation.evidence.migration0107To0108.activationApproval =
    wrap(approval);
  const verify = createProductionActivation0108ContractTestVerifier(
    PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
  );
  await assert.rejects(
    verify(tampered, async () => predecessorSummary),
    /PRODUCTION_ACTIVATION_0108_BINDING_INVALID/u,
  );
});

test("v3 semantic contract rejects a different internally consistent migration execution source", async () => {
  const { bundle } = fixture({ migrationSourceSha: "f".repeat(40) });
  const verify = createProductionActivation0108ContractTestVerifier(
    PRODUCTION_ACTIVATION_0108_CONTRACT_TEST_CONFIRMATION,
  );
  await assert.rejects(
    verify(bundle, async () => predecessorSummary),
    /PRODUCTION_ACTIVATION_0108_BINDING_INVALID/u,
  );
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalProductionActivationJson } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import {
  PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
  PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
  PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA,
} from "../../artifacts/api-server/src/lib/production-activation-0108-contract.ts";
import {
  PRODUCTION_ACTIVATION_PREDECESSOR_V2_ASSEMBLY_CONFIRMATION,
  PRODUCTION_ACTIVATION_PREDECESSOR_V2_DESCRIPTOR_SCHEMA,
  ProductionActivationPredecessorV2EvidenceError,
  executeProductionActivationPredecessorV2EvidenceWithTestAuthority,
} from "../production-evidence/run-production-activation-predecessor-v2-evidence.mjs";
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
import {
  PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA,
  PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION,
  executeProductionInvoice0108ActivationEvidence,
} from "../production-evidence/run-production-invoice-0108-activation-evidence.mjs";

const SOURCE_SHA = "7e3e50ca10e3877d2f4ee3a098380a44565623c5";
const API_IMAGE = `ghcr.io/modvolt/site-logbook-production-api@sha256:${"a".repeat(64)}`;
const NONCE = "b".repeat(64);
const CONTAINER_ID = "c".repeat(64);
const SCHEMA = `sha256:${"d".repeat(64)}`;
const DESIRED = `sha256:${"e".repeat(64)}`;
const RESOLVED = `sha256:${"f".repeat(64)}`;
const APPROVED_AT = "2026-08-24T18:00:00.000Z";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(kind, payload) {
  const canonical = canonicalProductionActivationJson(payload);
  return {
    kind,
    payload,
    sha256: digest(Buffer.from(canonical, "utf8")),
  };
}

async function canonicalFile(file, value) {
  await writeFile(file, canonicalProductionActivationJson(value), "utf8");
}

function simple(kind, extra = {}) {
  return artifact(kind, { decision: "PASS", kind, ...extra });
}

function invoiceInventory(state) {
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
  const root = await mkdtemp(
    path.join(os.tmpdir(), "activation-predecessor-v2-"),
  );
  const inputs = path.join(root, "inputs");
  const output = path.join(root, "output");
  await mkdir(inputs);
  await mkdir(output);

  const challenge = {
    apiImage: API_IMAGE,
    containerId: CONTAINER_ID,
    kind: "site-logbook-production-activation-challenge-v3",
    nonce: NONCE,
    sourceSha: SOURCE_SHA,
  };
  const observationRequest = {
    composeProject: "site_logbook",
    databaseName: "admin",
    databaseUser: "site_logbook_runtime",
    expectedApiImage: API_IMAGE,
    expectedNetworkServices: ["api", "postgres", "web"],
    postgresService: "postgres",
    postgresVolumeDestination: "/var/lib/postgresql/data",
    schemaFingerprintSha256: SCHEMA,
    schemaVersion: "site-logbook.production-host-observation-request/v1",
    sourceSha: SOURCE_SHA,
  };
  const provenance = {
    buildProfile: "production",
    keyId: "ed25519:production-publisher-2026-08",
    mutatingEntrypointsPresent: false,
    ociProvenanceSha256: `sha256:${"1".repeat(64)}`,
    publicationReceiptSha256: `sha256:${"2".repeat(64)}`,
    reviewedImageSetSha256: `sha256:${"3".repeat(64)}`,
    schemaVersion: "site-logbook.production-api-image-provenance/v2",
    sourceSha: SOURCE_SHA,
    subjectDigest: `sha256:${"a".repeat(64)}`,
    subjectImage: API_IMAGE,
    subjectRunnableManifestDigest: `sha256:${"4".repeat(64)}`,
  };
  const observations = {
    coolify: {
      observedAt: "2026-08-24T17:58:00.000Z",
      schemaVersion: "site-logbook.production-host-coolify-export/v1",
    },
    docker: {
      observedAt: "2026-08-24T17:58:30.000Z",
      schemaVersion: "site-logbook.production-host-docker-export/v1",
    },
    postgres: {
      observedAt: "2026-08-24T17:59:00.000Z",
      schemaVersion: "site-logbook.production-host-postgres-export/v2",
    },
  };
  const exact0096Backup = {
    detachedSignature: simple("exact-0096-detached-signature"),
    passReceipt: simple("exact-0096-pass-receipt"),
    plan: simple("exact-0096-plan"),
    signature: simple("exact-0096-signature"),
    trace: simple("exact-0096-trace"),
  };
  const transitionPass = simple("migration-transition-pass", {
    finalLiveIdentitySha256: `sha256:${"5".repeat(64)}`,
  });
  const migration0096To0107 = {
    finalLive: simple("migration-final-live"),
    intent: simple("migration-intent"),
    persistence: simple("migration-persistence"),
    plan: simple("migration-plan"),
    postcommit: simple("migration-postcommit"),
    receipts: Array.from({ length: 10 }, (_, index) =>
      simple(`migration-receipt-${index + 1}`, { index }),
    ),
    role: simple("migration-role"),
    transitionPass,
  };
  const credential = {
    passReceipt: simple("runtime-credential-pass-receipt"),
    request: simple("runtime-credential-request"),
  };
  const files = {
    apiImageProvenance: "inputs/api-image-provenance.json",
    apiImageProvenanceSignature: "inputs/api-image-provenance.sig",
    challenge: "inputs/challenge.json",
    coolifyObservation: "inputs/coolify.json",
    dockerObservation: "inputs/docker.json",
    exact0096Backup: "inputs/exact-0096.json",
    migration0096To0107: "inputs/migration-0096-0107.json",
    observationRequest: "inputs/observation-request.json",
    postgresObservation: "inputs/postgres.json",
    runtimeDatabaseCredentialCutover: "inputs/runtime-credential.json",
  };
  await Promise.all([
    canonicalFile(path.join(root, files.apiImageProvenance), provenance),
    writeFile(
      path.join(root, files.apiImageProvenanceSignature),
      Buffer.alloc(64, 7),
    ),
    canonicalFile(path.join(root, files.challenge), challenge),
    canonicalFile(
      path.join(root, files.coolifyObservation),
      observations.coolify,
    ),
    canonicalFile(
      path.join(root, files.dockerObservation),
      observations.docker,
    ),
    canonicalFile(path.join(root, files.exact0096Backup), exact0096Backup),
    canonicalFile(
      path.join(root, files.migration0096To0107),
      migration0096To0107,
    ),
    canonicalFile(
      path.join(root, files.observationRequest),
      observationRequest,
    ),
    canonicalFile(
      path.join(root, files.postgresObservation),
      observations.postgres,
    ),
    canonicalFile(
      path.join(root, files.runtimeDatabaseCredentialCutover),
      credential,
    ),
  ]);
  const descriptor = {
    authorizesApplicationStart: false,
    executionDefault: "disabled",
    inputs: files,
    kind: "site-logbook-production-activation-predecessor-v2-evidence",
    outputDirectory: "output",
    schemaVersion: PRODUCTION_ACTIVATION_PREDECESSOR_V2_DESCRIPTOR_SCHEMA,
    sourceSha: SOURCE_SHA,
  };
  const descriptorFile = path.join(root, "descriptor.json");
  await canonicalFile(descriptorFile, descriptor);
  return {
    root,
    output,
    descriptorFile,
    challenge,
    observationRequest,
    observations,
    transitionPass,
    credential,
  };
}

function argv(descriptorFile, overrides = {}) {
  return [
    "assemble",
    "--descriptor",
    descriptorFile,
    "--operator",
    overrides.operator ?? "release-reviewer",
    "--approved-at",
    overrides.approvedAt ?? APPROVED_AT,
    "--confirmation",
    overrides.confirmation ??
      PRODUCTION_ACTIVATION_PREDECESSOR_V2_ASSEMBLY_CONFIRMATION,
  ];
}

function authority(fixtureValue, hooks = {}) {
  return {
    now: () => Date.parse("2026-08-24T18:00:30.000Z"),
    verifyProvenance: (input) => {
      assert.equal(input.sourceSha, SOURCE_SHA);
      assert.equal(input.expectedApiImage, API_IMAGE);
      assert.equal(input.signature.length, 64);
      return {
        sourceSha: SOURCE_SHA,
        subjectImage: API_IMAGE,
        publicationReceiptSha256: `sha256:${"2".repeat(64)}`,
        reviewedImageSetSha256: `sha256:${"3".repeat(64)}`,
        subjectRunnableManifestDigest: `sha256:${"4".repeat(64)}`,
        ociProvenanceSha256: `sha256:${"1".repeat(64)}`,
      };
    },
    verifyObservations: (input) => {
      assert.deepEqual(input.request, fixtureValue.observationRequest);
      assert.equal(input.activationIssuedAt, APPROVED_AT);
      return {
        sourceSha: SOURCE_SHA,
        apiImage: API_IMAGE,
        databaseName: "admin",
        databaseUser: "site_logbook_runtime",
        schemaFingerprintSha256: SCHEMA,
        capturedAt: "2026-08-24T17:59:00.000Z",
        desiredConfigSha256: DESIRED,
        deployedConfigSha256: DESIRED,
        resolvedComposeSha256: RESOLVED,
      };
    },
    verifyContract: async (bundle) => {
      hooks.verifyContract?.(bundle);
      return {
        sourceSha: SOURCE_SHA,
        apiImage: API_IMAGE,
        databaseUser: "site_logbook_runtime",
        schemaFingerprintSha256: SCHEMA,
      };
    },
  };
}

test("assembles canonical predecessor v2 evidence and validates its exact bindings", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  let verified = false;
  try {
    const result =
      await executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile),
        authority(value, {
          verifyContract(bundle) {
            verified = true;
            assert.equal(bundle.activation.schemaVersion, 2);
            assert.equal(
              bundle.activation.kind,
              "site-logbook-production-activation-bundle-v2",
            );
            assert.equal(bundle.activation.sourceSha, SOURCE_SHA);
            assert.equal(bundle.activation.apiImage, API_IMAGE);
            assert.equal(bundle.activation.nonce, NONCE);
            assert.equal(bundle.activation.containerId, CONTAINER_ID);
            assert.equal(
              bundle.hostAttestation.observedAt,
              "2026-08-24T17:59:00.000Z",
            );
          },
        }),
      );
    assert.equal(verified, true);
    assert.equal(result.semanticContractVerified, true);
    assert.equal(result.authorizesDeployment, false);
    assert.match(result.sha256, /^sha256:[0-9a-f]{64}$/);

    const raw = await readFile(result.output, "utf8");
    const evidence = JSON.parse(raw);
    assert.equal(canonicalProductionActivationJson(evidence), raw);
    assert.deepEqual(Object.keys(evidence).sort(), [
      "activationApproval",
      "apiImageProvenance",
      "exact0096Backup",
      "finalObservations",
      "migration0096To0107",
      "runtimeDatabaseCredentialCutover",
    ]);
    const approval = evidence.activationApproval.payload;
    assert.equal(
      approval.schemaVersion,
      "site-logbook.production-activation-approval/v2",
    );
    assert.equal(
      approval.confirmation,
      "AUTHORIZE_EXACT_SITE_LOGBOOK_PRODUCTION_ACTIVATION_V2",
    );
    assert.equal(approval.sourceSha, SOURCE_SHA);
    assert.equal(approval.apiImage, API_IMAGE);
    assert.equal(approval.databaseUser, "site_logbook_runtime");
    assert.equal(approval.desiredConfigSha256, "e".repeat(64));
    assert.equal(approval.deployedConfigSha256, "e".repeat(64));
    assert.equal(approval.resolvedComposeSha256, "f".repeat(64));
    assert.equal(
      approval.migrationTransitionSha256,
      `sha256:${value.transitionPass.sha256}`,
    );
    assert.equal(
      approval.credentialRequestSha256,
      `sha256:${value.credential.request.sha256}`,
    );
    assert.equal(
      approval.credentialReceiptSha256,
      `sha256:${value.credential.passReceipt.sha256}`,
    );
    assert.equal(
      evidence.apiImageProvenance.signatureB64,
      Buffer.alloc(64, 7).toString("base64"),
    );
    for (const key of ["coolify", "docker", "postgres"]) {
      const wrapped = evidence.finalObservations[key];
      assert.equal(
        wrapped.sha256,
        digest(Buffer.from(canonicalProductionActivationJson(wrapped.payload))),
      );
    }
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("is default-dark and creates no output for a wrong confirmation", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    await assert.rejects(
      executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile, { confirmation: "APPROVE" }),
        authority(value),
      ),
      (error) =>
        error instanceof ProductionActivationPredecessorV2EvidenceError &&
        error.code ===
          "PRODUCTION_ACTIVATION_PREDECESSOR_V2_CONFIRMATION_REQUIRED",
    );
    await assert.rejects(
      readFile(path.join(value.output, "activation-evidence-v2.json")),
      { code: "ENOENT" },
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("fails closed before persistence when the exact semantic verifier rejects", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const rejecting = authority(value);
    rejecting.verifyContract = async () => {
      throw new Error("semantic rejection");
    };
    await assert.rejects(
      executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile),
        rejecting,
      ),
      /semantic rejection/,
    );
    await assert.rejects(
      readFile(path.join(value.output, "activation-evidence-v2.json")),
      { code: "ENOENT" },
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("rejects aliased inputs before semantic verification", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const descriptor = JSON.parse(await readFile(value.descriptorFile, "utf8"));
    descriptor.inputs.dockerObservation = descriptor.inputs.coolifyObservation;
    await canonicalFile(value.descriptorFile, descriptor);
    let verified = false;
    const testAuthority = authority(value, {
      verifyContract() {
        verified = true;
      },
    });
    await assert.rejects(
      executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile),
        testAuthority,
      ),
      (error) =>
        error instanceof ProductionActivationPredecessorV2EvidenceError &&
        error.code === "PRODUCTION_ACTIVATION_PREDECESSOR_V2_PATH_INVALID",
    );
    assert.equal(verified, false);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("refuses an existing fixed output before semantic verification", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const existing = path.join(value.output, "activation-evidence-v2.json");
    await writeFile(existing, "preserve\n", "utf8");
    let verified = false;
    const testAuthority = authority(value, {
      verifyContract() {
        verified = true;
      },
    });
    await assert.rejects(
      executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile),
        testAuthority,
      ),
      (error) =>
        error instanceof ProductionActivationPredecessorV2EvidenceError &&
        error.code === "PRODUCTION_ACTIVATION_PREDECESSOR_V2_OUTPUT_EXISTS",
    );
    assert.equal(verified, false);
    assert.equal(await readFile(existing, "utf8"), "preserve\n");
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("the durable output is accepted as predecessorEvidence by the existing 0108 assembler", async () => {
  const value = await fixture();
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    const predecessor =
      await executeProductionActivationPredecessorV2EvidenceWithTestAuthority(
        argv(value.descriptorFile),
        authority(value),
      );
    const migrations = path.join(value.root, "migrations");
    const overlayOutput = path.join(value.root, "overlay-output");
    await mkdir(migrations);
    await mkdir(overlayOutput);

    const backup = createProductionMigrationArtifact({
      schemaVersion:
        "site-logbook.production-exact-0107-backup-restore-reference/v1",
      kind: "site-logbook-production-exact-0107-backup-restore-reference",
      receiptStorageId: "fixture-exact-0107-backup.json",
      receiptSha256: `sha256:${"6".repeat(64)}`,
      sourceSha: SOURCE_SHA,
      sourceInventorySha256:
        PRODUCTION_INVOICE_0108_PRE_STATE.knownAppliedRowsSha256,
      backupCompletedAt: "2026-08-24T17:40:00.000Z",
      restoreVerifiedAt: "2026-08-24T17:41:00.000Z",
      decision: "PASS",
      productionRestorePerformed: false,
      authorizesProductionMigration: false,
    });
    const plan = createProductionInvoice0108Plan({
      sourceSha: SOURCE_SHA,
      backupRestoreReferenceCanonical: backup.canonical,
      createdAt: "2026-08-24T17:42:00.000Z",
    });
    const intent = createProductionInvoice0108Intent({
      planCanonical: plan.canonical,
      intentId: "7".repeat(64),
      operator: "release-reviewer",
      createdAt: "2026-08-24T17:43:00.000Z",
      confirmation:
        "APPLY_EXACT_0108_INVOICE_UPGRADE_TO_EXACT_0107_MODVOLT_PRODUCTION",
    });
    const migrationReceipt = createProductionInvoice0108Receipt({
      planCanonical: plan.canonical,
      intentCanonical: intent.canonical,
      before: invoiceInventory("pre"),
      after: invoiceInventory("post"),
      transactionStartedAt: "2026-08-24T17:44:00.000Z",
      transactionCompletedAt: "2026-08-24T17:45:00.000Z",
    });
    const roleReceipt = createProductionMigrationArtifact({
      schemaVersion:
        "site-logbook.production-invoice-0108-role-delta-receipt/v1",
      kind: "site-logbook-production-invoice-0108-role-delta-receipt",
      decision: "PASS",
      migration: PRODUCTION_INVOICE_0108_MIGRATION.tag,
      migrationSha256: PRODUCTION_INVOICE_0108_MIGRATION.sqlSha256.slice(7),
      migrationReceiptSha256: migrationReceipt.sha256,
      base0107PlanSha256: `sha256:${"8".repeat(64)}`,
      deltaPlanSha256: `sha256:${"9".repeat(64)}`,
      preProjectionSha256: `sha256:${"a".repeat(64)}`,
      postProjectionSha256: `sha256:${"b".repeat(64)}`,
      authoritySourceSha256: `sha256:${"c".repeat(64)}`,
      transactionCommitted: true,
      completedAt: "2026-08-24T17:46:00.000Z",
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
      sourceSha: SOURCE_SHA,
      databaseName: "admin",
      databaseUser: "site_logbook_runtime",
      schemaFingerprintSha256: SCHEMA,
      invoiceSchemaProjectionSha256: `sha256:${"d".repeat(64)}`,
      migrationReceiptSha256: migrationReceipt.sha256,
      roleReceiptSha256: roleReceipt.sha256,
      lineage,
      checkedAt: "2026-08-24T17:47:00.000Z",
      authorizesApplicationStart: false,
    };
    const readinessCanonical =
      canonicalProductionActivationJson(readinessValue);
    const approvalValue = {
      schemaVersion: PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
      kind: "site-logbook-production-invoice-0108-activation-approval",
      decision: "APPROVE",
      confirmation: PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
      sourceSha: SOURCE_SHA,
      apiImage: API_IMAGE,
      nonce: NONCE,
      containerId: CONTAINER_ID,
      schemaReadinessSha256: `sha256:${digest(Buffer.from(readinessCanonical))}`,
      migrationReceiptSha256: migrationReceipt.sha256,
      roleReceiptSha256: roleReceipt.sha256,
      invoiceSchemaProjectionSha256: `sha256:${"d".repeat(64)}`,
      approvedAt: "2026-08-24T18:00:00.000Z",
      operator: "release-reviewer",
      authorizesApplicationStart: true,
      authorizesDeployment: false,
    };

    const overlayInputs = {
      predecessorEvidence: path.relative(value.root, predecessor.output),
      backupRestoreReference: "inputs/overlay-backup.json",
      plan: "inputs/overlay-plan.json",
      intent: "inputs/overlay-intent.json",
      migrationReceipt: "inputs/overlay-migration-receipt.json",
      roleReceipt: "inputs/overlay-role-receipt.json",
      challenge: "inputs/challenge.json",
    };
    await Promise.all([
      writeFile(
        path.join(value.root, overlayInputs.backupRestoreReference),
        backup.canonical,
      ),
      writeFile(path.join(value.root, overlayInputs.plan), plan.canonical),
      writeFile(path.join(value.root, overlayInputs.intent), intent.canonical),
      writeFile(
        path.join(value.root, overlayInputs.migrationReceipt),
        migrationReceipt.canonical,
      ),
      writeFile(
        path.join(value.root, overlayInputs.roleReceipt),
        roleReceipt.canonical,
      ),
      writeFile(
        path.join(overlayOutput, "invoice-0108-schema-readiness.json"),
        readinessCanonical,
      ),
      writeFile(
        path.join(overlayOutput, "invoice-0108-activation-approval.json"),
        canonicalProductionActivationJson(approvalValue),
      ),
    ]);
    const overlayDescriptor = {
      schemaVersion:
        PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA,
      kind: "site-logbook-production-invoice-0108-activation-evidence",
      executionDefault: "disabled",
      sourceSha: SOURCE_SHA,
      migrationsDirectory: "migrations",
      outputDirectory: "overlay-output",
      connection: {
        environmentVariable: "DATABASE_URL",
        databaseName: "admin",
        databaseUser: "site_logbook_runtime",
        expectedSchemaFingerprintSha256: SCHEMA,
      },
      inputs: overlayInputs,
      authorizesApplicationStart: false,
    };
    const overlayDescriptorFile = path.join(
      value.root,
      "overlay-descriptor.json",
    );
    await canonicalFile(overlayDescriptorFile, overlayDescriptor);
    const assembled = await executeProductionInvoice0108ActivationEvidence(
      [
        "assemble",
        "--descriptor",
        overlayDescriptorFile,
        "--confirmation",
        PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION,
      ],
      { environment: { BUILD_SHA: SOURCE_SHA } },
    );
    const evidenceV3 = JSON.parse(await readFile(assembled.output, "utf8"));
    assert.deepEqual(
      Object.keys(evidenceV3)
        .filter((key) => key !== "migration0107To0108")
        .sort(),
      [
        "activationApproval",
        "apiImageProvenance",
        "exact0096Backup",
        "finalObservations",
        "migration0096To0107",
        "runtimeDatabaseCredentialCutover",
      ],
    );
    assert.equal(
      evidenceV3.migration0107To0108.schemaReadiness.payload.decision,
      "PASS",
    );
    assert.equal(
      evidenceV3.migration0107To0108.activationApproval.payload.decision,
      "APPROVE",
    );
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    await rm(value.root, { recursive: true, force: true });
  }
});

test("production wiring is fixed to the direct v2 runtime verifier", async () => {
  const source = await readFile(
    new URL(
      "../production-evidence/run-production-activation-predecessor-v2-evidence.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /verifyProductionActivationContractV2/);
  assert.match(
    source,
    /verifyContract:\s*verifyProductionActivationContractV2/,
  );
  assert.match(source, /process\.env\.NODE_ENV !== "test"/);
});

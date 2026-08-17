import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PRODUCTION_MIGRATION_PREFIX_STATES,
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  PRODUCTION_MIGRATION_STEPS,
  PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
  PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
} from "../production-evidence/production-migration-contract.mjs";
import {
  PRODUCTION_MIGRATION_EXECUTOR_INTERFACE,
  createProductionMigrationIntent,
  createProductionMigrationIntentPersistenceReceipt,
  createProductionMigrationPlan,
} from "../production-evidence/production-migration-planner.mjs";
import {
  classifyProductionMigrationRecovery,
  createProductionMigrationResumeCommand,
  createProductionMigrationStepReceipt,
  createProductionMigrationTransitionChain,
  verifyProductionMigrationReceiptSequence,
  verifyProductionMigrationTransitionChain,
} from "../production-evidence/production-migration-verifier.mjs";
import {
  fixtureIntentInput,
  fixtureInventory,
  fixturePlanInput,
  fixturePlanInputForBackup,
  fixtureIntentId,
  fixtureRunId,
  fixtureSourceSha,
} from "./production-migration-control-plane-fixtures.mjs";
import { fixturePlanInput as fixtureExactBackupPlanInput } from "./production-exact-0096-backup-contract-fixtures.mjs";

const migrationsUrl = new URL("../../lib/db/migrations/", import.meta.url);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function planAndIntent() {
  const plan = createProductionMigrationPlan(fixturePlanInput());
  const intent = createProductionMigrationIntent(
    fixtureIntentInput(plan.canonical),
  );
  const persistence = createProductionMigrationIntentPersistenceReceipt({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    persistedCanonical: intent.canonical,
    persistedAt: "2026-08-12T11:00:30.000Z",
    storageId: "production-intents/2026-08-12/exclusive-intent",
  });
  return { plan, intent, persistence };
}

function transactionEvidence(plan, intent, persistence, index) {
  const minute = String(index + 1).padStart(2, "0");
  const nextMinute = String(index + 2).padStart(2, "0");
  const liveIdentity = fixtureLiveIdentity(
    plan,
    index + 1,
    `2026-08-12T11:${nextMinute}:00.000Z`,
  );
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
    kind: "site-logbook-production-migration-transaction-evidence",
    executorRunId: fixtureRunId,
    planSha256: plan.sha256,
    intentSha256: intent.sha256,
    intentPersistenceReceiptSha256: persistence.sha256,
    migration: PRODUCTION_MIGRATION_STEPS[index],
    before: fixtureInventory(index),
    after: fixtureInventory(index + 1),
    liveIdentityCanonical: liveIdentity.canonical,
    liveIdentitySha256: liveIdentity.sha256,
    advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    transactionCommitted: true,
    transactionStartedAt: `2026-08-12T11:${minute}:00.000Z`,
    transactionCompletedAt: `2026-08-12T11:${nextMinute}:00.000Z`,
    authorizesApplicationStart: false,
  });
}

function fixtureLiveIdentity(plan, stateIndex, observedAt) {
  const baseline = JSON.parse(plan.value.baselineLiveIdentityCanonical);
  return createProductionMigrationLiveIdentity({
    sourceSha: plan.value.sourceSha,
    database: plan.value.database,
    applicationImageRef: baseline.applicationImageRef,
    postgresImageRef: baseline.postgresImageRef,
    runtimeBindingSha256: baseline.runtimeBindingSha256,
    inventory: fixtureInventory(stateIndex),
    observedAt,
  });
}

function fixturePostCommitRole(plan, observedAt) {
  const role = JSON.parse(plan.value.rolePreconditionCanonical);
  const projection = JSON.parse(role.preProjectionCanonical);
  const projectionSha256 = createHash("sha256")
    .update(canonicalProductionMigrationJson(projection))
    .digest("hex");
  const receiptBody = {
    schemaVersion: "site-logbook.production-db-role-separation-receipt/v1",
    planSha256: role.rolePlanSha256,
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    executorId: "independent-role-executor",
    approvalId: "role-separation-approval",
    executedAt: "2026-08-12T11:11:10.000Z",
    statementCount: 1,
    postProjectionSha256: projectionSha256,
    postValidation: "passed",
    authorizesDeployment: false,
    postCommitVerification: "unavailable",
    postCommitVerifierArtifact: null,
  };
  const receipt = createProductionMigrationArtifact({
    ...receiptBody,
    receiptSha256: createHash("sha256")
      .update(canonicalProductionMigrationJson(receiptBody))
      .digest("hex"),
  });
  const postCommit = createProductionMigrationArtifact({
    schemaVersion: "site-logbook.production-db-role-separation-postcommit/v1",
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: role.rolePlanSha256,
    transactionReceiptSha256: receipt.value.receiptSha256,
    projection,
    projectionSha256,
    verifierId: "independent-role-verifier",
    observedAt,
    authorizesDeployment: false,
  });
  return { receipt, postCommit };
}

function allReceipts(plan, intent, persistence, count = 10) {
  const receipts = [];
  for (let index = 0; index < count; index += 1) {
    receipts.push(
      createProductionMigrationStepReceipt({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        priorReceiptCanonicals: receipts.map((receipt) => receipt.canonical),
        transactionEvidenceCanonical: transactionEvidence(
          plan,
          intent,
          persistence,
          index,
        ).canonical,
      }),
    );
  }
  return receipts;
}

test("freezes exact 97-known plus two opaque to ordered 107-known transition", () => {
  const { plan, intent } = planAndIntent();
  assert.equal(plan.value.steps.length, 10);
  assert.deepEqual(
    plan.value.steps.map((step) => step.tag),
    [
      "0097_session_and_api_idempotency",
      "0098_object-upload-ledger",
      "0099_secret_envelope_encryption",
      "0101_public_access_token_lifecycle",
      "0102_immutable_job_quote_versions",
      "0103_durable_operational_incident_outbox",
      "0104_thin_sheva_callister",
      "0105_smooth_nitro",
      "0106_graceful_frog_thor",
      "0107_canonical_audit_evidence",
    ],
  );
  assert.equal(plan.value.baseline.knownAppliedMigrations, 97);
  assert.equal(plan.value.baseline.totalJournalRows, 99);
  assert.equal(plan.value.target.knownAppliedMigrations, 107);
  assert.equal(plan.value.target.totalJournalRows, 109);
  assert.equal(
    intent.value.persistencePolicy,
    "durable-before-first-database-write",
  );
  assert.equal(
    intent.value.recoveryPolicy,
    "receipt-backed-prefix-only-no-blind-retry",
  );
  assert.equal(intent.value.authorizesApplicationStart, false);
  assert.equal(
    PRODUCTION_MIGRATION_STEPS.some((step) => step.tag.startsWith("0100")),
    false,
  );
  assert.ok(
    PRODUCTION_MIGRATION_EXECUTOR_INTERFACE.constraints.includes(
      "no-generic-migrate-fallback",
    ),
  );
});

test("binds backup v3 live source and executor as distinct exact identities", async () => {
  const input = fixturePlanInput();
  const plan = createProductionMigrationPlan(input);
  const backupPlan = JSON.parse(plan.value.backupPlanCanonical);
  const backupTrace = JSON.parse(plan.value.backupExecutorTraceCanonical);
  const signatureEnvelope = JSON.parse(
    plan.value.backupSignatureEnvelopeCanonical,
  );

  assert.equal(plan.value.sourceSha, backupPlan.liveSource.sha);
  assert.equal(
    JSON.parse(plan.value.baselineLiveIdentityCanonical).applicationImageRef,
    backupPlan.liveSource.imageRef,
  );
  assert.notEqual(backupPlan.liveSource.sha, backupPlan.executor.buildSha);
  assert.notEqual(backupPlan.liveSource.imageRef, backupPlan.executor.imageRef);
  assert.equal(backupTrace.producer.buildSha, backupPlan.executor.buildSha);
  assert.equal(
    backupTrace.producer.executorImageRef,
    backupPlan.executor.imageRef,
  );
  assert.equal(
    signatureEnvelope.schemaVersion,
    "site-logbook.production-exact-0096-backup-signature-envelope/v2",
  );
  assert.equal(signatureEnvelope.liveSourceSha, backupPlan.liveSource.sha);
  assert.equal(
    signatureEnvelope.liveSourceImageRef,
    backupPlan.liveSource.imageRef,
  );
  assert.equal(
    signatureEnvelope.executorBuildSha,
    backupPlan.executor.buildSha,
  );
  assert.equal(
    signatureEnvelope.executorImageRef,
    backupPlan.executor.imageRef,
  );

  const aliasedBackupPlanInput = fixtureExactBackupPlanInput();
  aliasedBackupPlanInput.executor = {
    buildSha: aliasedBackupPlanInput.liveSource.sha,
    imageRef: aliasedBackupPlanInput.liveSource.imageRef,
  };
  await assert.rejects(
    () => fixturePlanInputForBackup(aliasedBackupPlanInput),
    /PRODUCTION_BACKUP_RESTORE_NOT_DISPOSABLE|PRODUCTION_BACKUP_EXECUTOR_INVALID/,
  );

  const swappedPlanInput = fixturePlanInput();
  const swappedBackupPlan = JSON.parse(swappedPlanInput.backupPlanCanonical);
  const originalLiveSource = swappedBackupPlan.liveSource;
  swappedBackupPlan.liveSource = {
    sha: swappedBackupPlan.executor.buildSha,
    imageRef: swappedBackupPlan.executor.imageRef,
  };
  swappedBackupPlan.executor = {
    buildSha: originalLiveSource.sha,
    imageRef: originalLiveSource.imageRef,
  };
  swappedPlanInput.backupPlanCanonical =
    canonicalProductionMigrationJson(swappedBackupPlan);
  assert.throws(
    () => createProductionMigrationPlan(swappedPlanInput),
    /PRODUCTION_BACKUP_RUNTIME_BINDING_INVALID|PRODUCTION_BACKUP_SOURCE_BINDING_INVALID/,
  );

  const swappedTraceInput = fixturePlanInput();
  const swappedTracePlan = JSON.parse(swappedTraceInput.backupPlanCanonical);
  const swappedTrace = JSON.parse(
    swappedTraceInput.backupExecutorTraceCanonical,
  );
  swappedTrace.producer.buildSha = swappedTracePlan.liveSource.sha;
  swappedTrace.producer.executorImageRef = swappedTracePlan.liveSource.imageRef;
  swappedTraceInput.backupExecutorTraceCanonical =
    canonicalProductionMigrationJson(swappedTrace);
  assert.throws(
    () => createProductionMigrationPlan(swappedTraceInput),
    /PRODUCTION_BACKUP_EXECUTOR_INVALID/,
  );

  const swappedSignatureInput = fixturePlanInput();
  const swappedSignature = JSON.parse(
    swappedSignatureInput.backupSignatureEnvelopeCanonical,
  );
  [swappedSignature.liveSourceSha, swappedSignature.executorBuildSha] = [
    swappedSignature.executorBuildSha,
    swappedSignature.liveSourceSha,
  ];
  [swappedSignature.liveSourceImageRef, swappedSignature.executorImageRef] = [
    swappedSignature.executorImageRef,
    swappedSignature.liveSourceImageRef,
  ];
  swappedSignatureInput.backupSignatureEnvelopeCanonical =
    canonicalProductionMigrationJson(swappedSignature);
  assert.throws(
    () => createProductionMigrationPlan(swappedSignatureInput),
    /PRODUCTION_BACKUP_SIGNATURE_BINDING_INVALID/,
  );
});

test("pinned steps match the committed LF bundle and prefix digests form one exact chain", () => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsUrl), "utf8"),
  );
  const rows = journal.entries.map((entry) => {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsUrl),
      "utf8",
    ).replace(/\r\n/g, "\n");
    return { createdAt: entry.when, hash: sha256(sql) };
  });
  for (const [index, step] of PRODUCTION_MIGRATION_STEPS.entries()) {
    const journalEntry = journal.entries[97 + index];
    assert.deepEqual(
      { idx: journalEntry.idx, when: journalEntry.when, tag: journalEntry.tag },
      { idx: step.idx, when: step.when, tag: step.tag },
    );
    assert.equal(rows[97 + index].hash, step.sqlSha256.slice("sha256:".length));
  }
  assert.equal(
    PRODUCTION_MIGRATION_PREFIX_STATES[0].knownAppliedRowsSha256,
    "sha256:fe26ddc43d40d91030a34c116695e92c54ea355f8149e245f4afabe8276693b5",
  );
  assert.equal(
    PRODUCTION_MIGRATION_PREFIX_STATES.at(-1).knownAppliedRowsSha256,
    "sha256:c5477bc69313ef758fb2022cc7c781caa9a703c8cace8a11742294913cdd4313",
  );
  for (const [index, step] of PRODUCTION_MIGRATION_STEPS.entries()) {
    const before = PRODUCTION_MIGRATION_PREFIX_STATES[index];
    const after = PRODUCTION_MIGRATION_PREFIX_STATES[index + 1];
    assert.equal(step.knownRowsSha256Before, before.knownAppliedRowsSha256);
    assert.equal(step.knownRowsSha256After, after.knownAppliedRowsSha256);
    assert.equal(step.knownCountBefore, before.knownAppliedMigrations);
    assert.equal(step.knownCountAfter, after.knownAppliedMigrations);
    assert.equal(after.latestKnownAppliedTag, step.tag);
  }
});

test("builds and verifies ten externally evidenced chained receipts and a non-authorizing chain", () => {
  const { plan, intent, persistence } = planAndIntent();
  const receipts = allReceipts(plan, intent, persistence);
  const verified = verifyProductionMigrationReceiptSequence({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    requireComplete: true,
  });
  assert.equal(verified.receipts.length, 10);
  const finalLive = fixtureLiveIdentity(plan, 10, "2026-08-12T11:11:00.000Z");
  const roleEvidence = fixturePostCommitRole(plan, "2026-08-12T11:11:30.000Z");
  const chain = createProductionMigrationTransitionChain({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    finalInventory: fixtureInventory(10),
    finalLiveIdentityCanonical: finalLive.canonical,
    roleTransactionReceiptCanonical: roleEvidence.receipt.canonical,
    postCommitRoleArtifactCanonical: roleEvidence.postCommit.canonical,
    completedAt: "2026-08-12T11:12:00.000Z",
  });
  assert.equal(chain.value.decision, "PASS");
  assert.equal(chain.value.authorizesApplicationStart, false);
  assert.equal(
    chain.value.opaqueLegacyRowsSha256,
    PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  );
  assert.equal(
    verifyProductionMigrationTransitionChain({
      chainCanonical: chain.canonical,
      planCanonical: plan.canonical,
      intentCanonical: intent.canonical,
      intentPersistenceReceiptCanonical: persistence.canonical,
      receiptCanonicals: receipts.map((receipt) => receipt.canonical),
      finalInventory: fixtureInventory(10),
      finalLiveIdentityCanonical: finalLive.canonical,
      roleTransactionReceiptCanonical: roleEvidence.receipt.canonical,
      postCommitRoleArtifactCanonical: roleEvidence.postCommit.canonical,
    }).sha256,
    chain.sha256,
  );
  const tamperedPostRole = JSON.parse(roleEvidence.postCommit.canonical);
  tamperedPostRole.authorizesDeployment = true;
  assert.throws(
    () =>
      createProductionMigrationTransitionChain({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: receipts.map((receipt) => receipt.canonical),
        finalInventory: fixtureInventory(10),
        finalLiveIdentityCanonical: finalLive.canonical,
        roleTransactionReceiptCanonical: roleEvidence.receipt.canonical,
        postCommitRoleArtifactCanonical:
          canonicalProductionMigrationJson(tamperedPostRole),
        completedAt: "2026-08-12T11:12:00.000Z",
      }),
    /POST_COMMIT_ROLE_INVALID/,
  );
});

test("inspect never authorizes resume; exact receipt-head command does", () => {
  const { plan, intent, persistence } = planAndIntent();
  const receipts = allReceipts(plan, intent, persistence, 3);
  const inspect = classifyProductionMigrationRecovery({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    liveIdentityCanonical: fixtureLiveIdentity(
      plan,
      3,
      "2026-08-12T11:04:00.000Z",
    ).canonical,
  });
  assert.equal(inspect.value.decision, "INSPECT_READY_EXPLICIT_RESUME");
  assert.equal(inspect.value.resumeAllowed, false);
  assert.equal(inspect.value.nextStep, null);
  const command = createProductionMigrationResumeCommand({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    operator: "production-owner",
    approvedAt: "2026-08-12T11:05:00.000Z",
    confirmation: PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  });
  const classification = classifyProductionMigrationRecovery({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    liveIdentityCanonical: fixtureLiveIdentity(
      plan,
      3,
      "2026-08-12T11:04:00.000Z",
    ).canonical,
    requestedAction: "resume",
    resumeCommandCanonical: command.canonical,
  });
  assert.equal(classification.value.decision, "READY_EXPLICIT_RESUME");
  assert.equal(
    classification.value.nextStep.tag,
    "0101_public_access_token_lifecycle",
  );
  assert.equal(classification.value.resumeAllowed, true);
  assert.equal(classification.value.resumeCommandSha256, command.sha256);
  assert.equal(classification.value.blindRetryAllowed, false);
  assert.throws(
    () =>
      classifyProductionMigrationRecovery({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: receipts.map((receipt) => receipt.canonical),
        liveIdentityCanonical: fixtureLiveIdentity(
          plan,
          3,
          "2026-08-12T11:04:00.000Z",
        ).canonical,
        requestedAction: "retry",
      }),
    /PRODUCTION_MIGRATION_BLIND_RETRY_REJECTED/,
  );
});

test("unknown commit or receipt/live divergence requires restore instead of resume", () => {
  const { plan, intent, persistence } = planAndIntent();
  const unknownCommit = classifyProductionMigrationRecovery({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: [],
    liveIdentityCanonical: fixtureLiveIdentity(
      plan,
      1,
      "2026-08-12T11:04:00.000Z",
    ).canonical,
  });
  assert.equal(unknownCommit.value.decision, "RESTORE_REQUIRED_UNKNOWN_COMMIT");
  assert.equal(unknownCommit.value.resumeAllowed, false);

  const receipts = allReceipts(plan, intent, persistence, 2);
  const missingDatabaseState = classifyProductionMigrationRecovery({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    liveIdentityCanonical: fixtureLiveIdentity(
      plan,
      1,
      "2026-08-12T11:04:00.000Z",
    ).canonical,
  });
  assert.equal(
    missingDatabaseState.value.decision,
    "RESTORE_REQUIRED_RECEIPT_DIVERGENCE",
  );
});

test("rejects 0100, non-prefix lineage, unknown tags and opaque drift", () => {
  for (const mutate of [
    (inventory) => {
      inventory.excludedMigration0100Present = true;
    },
    (inventory) => {
      inventory.knownAppliedRowsSha256 = `sha256:${"1".repeat(64)}`;
    },
    (inventory) => {
      inventory.unexpectedKnownMigrationTags = ["0999_unknown"];
    },
    (inventory) => {
      inventory.opaqueLegacyRows[0].hash = "2".repeat(64);
    },
  ]) {
    const input = fixturePlanInput();
    mutate(input.baselineInventory);
    assert.throws(() => createProductionMigrationPlan(input));
  }
});

test("rejects missing, reordered, or tampered receipts", () => {
  const { plan, intent, persistence } = planAndIntent();
  const receipts = allReceipts(plan, intent, persistence, 3);
  assert.throws(
    () =>
      verifyProductionMigrationReceiptSequence({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: [receipts[1].canonical, receipts[0].canonical],
      }),
    /RECEIPT_INVALID|TRANSACTION_EVIDENCE_INVALID/,
  );
  const tampered = structuredClone(receipts[1].value);
  tampered.authorizesApplicationStart = true;
  assert.throws(
    () =>
      verifyProductionMigrationReceiptSequence({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: [
          receipts[0].canonical,
          canonicalProductionMigrationJson(tampered),
        ],
      }),
    /RECEIPT_INVALID/,
  );
  const forgedTransaction = structuredClone(receipts[0].value);
  const transaction = JSON.parse(
    forgedTransaction.transactionEvidenceCanonical,
  );
  transaction.transactionCommitted = false;
  forgedTransaction.transactionEvidenceCanonical =
    canonicalProductionMigrationJson(transaction);
  assert.throws(
    () =>
      verifyProductionMigrationReceiptSequence({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: [
          canonicalProductionMigrationJson(forgedTransaction),
        ],
      }),
    /TRANSACTION_EVIDENCE_INVALID/,
  );
});

test("requires exact durable intent read-back before any receipt or resume", () => {
  const plan = createProductionMigrationPlan(fixturePlanInput());
  const intent = createProductionMigrationIntent(
    fixtureIntentInput(plan.canonical),
  );
  assert.throws(
    () =>
      createProductionMigrationIntentPersistenceReceipt({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        persistedCanonical: `${intent.canonical} `,
        persistedAt: "2026-08-12T11:00:30.000Z",
        storageId: "production-intents/exclusive",
      }),
    /INTENT_NOT_DURABLE/,
  );
  assert.throws(
    () =>
      verifyProductionMigrationReceiptSequence({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: intent.canonical,
        receiptCanonicals: [],
      }),
    /INTENT_NOT_DURABLE|SCHEMA_INVALID/,
  );
});

test("derives receipt digest only from exact canonical transaction evidence", () => {
  const { plan, intent, persistence } = planAndIntent();
  const evidence = transactionEvidence(plan, intent, persistence, 0);
  const tampered = structuredClone(evidence.value);
  tampered.transactionCommitted = false;
  assert.throws(
    () =>
      createProductionMigrationStepReceipt({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        priorReceiptCanonicals: [],
        transactionEvidenceCanonical:
          canonicalProductionMigrationJson(tampered),
      }),
    /TRANSACTION_EVIDENCE_INVALID/,
  );
  tampered.transactionCommitted = true;
  tampered.migration = PRODUCTION_MIGRATION_STEPS[1];
  assert.throws(
    () =>
      createProductionMigrationStepReceipt({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        priorReceiptCanonicals: [],
        transactionEvidenceCanonical:
          canonicalProductionMigrationJson(tampered),
      }),
    /TRANSACTION_EVIDENCE_INVALID/,
  );
});

test("rejects stale resume command after receipt head advances", () => {
  const { plan, intent, persistence } = planAndIntent();
  const receipts = allReceipts(plan, intent, persistence, 1);
  const stale = createProductionMigrationResumeCommand({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    intentPersistenceReceiptCanonical: persistence.canonical,
    receiptCanonicals: receipts.map((receipt) => receipt.canonical),
    operator: "production-owner",
    approvedAt: "2026-08-12T11:03:00.000Z",
    confirmation: PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  });
  const advanced = allReceipts(plan, intent, persistence, 2);
  assert.throws(
    () =>
      classifyProductionMigrationRecovery({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        receiptCanonicals: advanced.map((receipt) => receipt.canonical),
        liveIdentityCanonical: fixtureLiveIdentity(
          plan,
          2,
          "2026-08-12T11:03:00.000Z",
        ).canonical,
        requestedAction: "resume",
        resumeCommandCanonical: stale.canonical,
      }),
    /RESUME_COMMAND_INVALID/,
  );
});

test("rejects secret material, oversized strings, uppercase identities and evidence drift", () => {
  const planInput = fixturePlanInput();
  assert.throws(
    () =>
      createProductionMigrationPlan({
        ...planInput,
        sourceSha: fixtureSourceSha.toUpperCase(),
      }),
    /SOURCE_INVALID/,
  );
  const opaque = fixtureInventory();
  opaque.opaqueLegacyRows[0].hash =
    opaque.opaqueLegacyRows[0].hash.toUpperCase();
  assert.throws(
    () =>
      createProductionMigrationPlan({
        ...fixturePlanInput(),
        baselineInventory: opaque,
      }),
    /OPAQUE_DRIFT/,
  );
  const opaqueTypeDrift = fixtureInventory();
  opaqueTypeDrift.opaqueLegacyRows[0].createdAt = String(
    opaqueTypeDrift.opaqueLegacyRows[0].createdAt,
  );
  assert.throws(
    () =>
      createProductionMigrationPlan({
        ...fixturePlanInput(),
        baselineInventory: opaqueTypeDrift,
      }),
    /OPAQUE_DRIFT/,
  );
  const { plan } = planAndIntent();
  assert.throws(
    () =>
      createProductionMigrationIntent({
        ...fixtureIntentInput(plan.canonical),
        operator: "github_pat_must_never_be_retained_123456",
      }),
    /SECRET_MATERIAL/,
  );
  assert.throws(
    () =>
      createProductionMigrationIntent({
        ...fixtureIntentInput(plan.canonical),
        operator: "x".repeat(20 * 1024),
      }),
    /SCHEMA_INVALID/,
  );
  assert.throws(
    () =>
      createProductionMigrationIntent({
        ...fixtureIntentInput(plan.canonical),
        intentId: fixtureIntentId.toUpperCase(),
      }),
    /INTENT_INVALID/,
  );
  const liveDrift = fixturePlanInput();
  const live = JSON.parse(liveDrift.baselineLiveIdentityCanonical);
  live.database.sessionUser = live.database.sessionUser.toUpperCase();
  liveDrift.baselineLiveIdentityCanonical =
    canonicalProductionMigrationJson(live);
  assert.throws(
    () => createProductionMigrationPlan(liveDrift),
    /DATABASE_INVALID|LIVE_IDENTITY_INVALID/,
  );
  const signatureDrift = fixturePlanInput();
  signatureDrift.backupDetachedSignatureB64 = `${signatureDrift.backupDetachedSignatureB64.slice(0, -1)}A`;
  assert.throws(
    () => createProductionMigrationPlan(signatureDrift),
    /BACKUP_EVIDENCE_INVALID/,
  );
  const drifted = fixturePlanInput();
  const target = JSON.parse(drifted.targetEvidenceCanonical);
  target.database.sessionUser = "different_user";
  drifted.targetEvidenceCanonical = canonicalProductionMigrationJson(target);
  assert.throws(
    () => createProductionMigrationPlan(drifted),
    /TARGET_EVIDENCE_INVALID|SCHEMA_INVALID/,
  );
});

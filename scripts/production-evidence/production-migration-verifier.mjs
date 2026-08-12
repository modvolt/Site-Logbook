import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_RESUME_COMMAND_SCHEMA,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  PRODUCTION_MIGRATION_STEP_RECEIPT_SCHEMA,
  PRODUCTION_MIGRATION_STEPS,
  PRODUCTION_MIGRATION_TRANSITION_CHAIN_SCHEMA,
  PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
  PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  exactObject,
  exactString,
  exactTimestamp,
  frozenStateSummary,
  parseCanonicalProductionMigrationArtifact,
  parseProductionMigrationLiveIdentity,
  productionMigrationSha256,
  productionMigrationFail,
  validateProductionMigrationInventory,
} from "./production-migration-contract.mjs";
import {
  validateProductionMigrationIntent,
  validateProductionMigrationIntentPersistenceReceipt,
  validateProductionMigrationPlan,
} from "./production-migration-planner.mjs";

function parseRoleTransactionReceipt(canonical, verified) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "roleTransactionReceipt",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "planSha256",
      "migrationSha256",
      "executorId",
      "approvalId",
      "executedAt",
      "statementCount",
      "postProjectionSha256",
      "postValidation",
      "authorizesDeployment",
      "postCommitVerification",
      "postCommitVerifierArtifact",
      "receiptSha256",
    ],
    "roleTransactionReceipt",
  );
  const rolePrecondition = parseCanonicalProductionMigrationArtifact(
    verified.plan.rolePreconditionCanonical,
    "plan.rolePreconditionCanonical",
  ).value;
  const { receiptSha256, ...body } = value;
  if (
    value.schemaVersion !==
      "site-logbook.production-db-role-separation-receipt/v1" ||
    value.planSha256 !== rolePrecondition.rolePlanSha256 ||
    value.migrationSha256 !==
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122" ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(String(value.executorId)) ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(String(value.approvalId)) ||
    !Number.isSafeInteger(value.statementCount) ||
    value.statementCount < 1 ||
    !/^[0-9a-f]{64}$/.test(String(value.postProjectionSha256)) ||
    value.postValidation !== "passed" ||
    value.authorizesDeployment !== false ||
    value.postCommitVerification !== "unavailable" ||
    value.postCommitVerifierArtifact !== null ||
    value.receiptSha256 !==
      createHash("sha256")
        .update(canonicalProductionMigrationJson(body))
        .digest("hex")
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ROLE_RECEIPT_INVALID",
      "Role transaction receipt is not exact, non-authorizing and self-consistent.",
    );
  }
  const executedAt = exactTimestamp(
    value.executedAt,
    "roleTransactionReceipt.executedAt",
  );
  return Object.freeze({ artifact, value, executedAt });
}

function parsePostCommitRoleArtifact(canonical, verified, roleReceipt) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "postCommitRoleArtifact",
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "planSha256",
      "transactionReceiptSha256",
      "projection",
      "projectionSha256",
      "verifierId",
      "observedAt",
      "authorizesDeployment",
    ],
    "postCommitRoleArtifact",
  );
  const rolePrecondition = parseCanonicalProductionMigrationArtifact(
    verified.plan.rolePreconditionCanonical,
    "plan.rolePreconditionCanonical",
  ).value;
  const projection = value.projection;
  if (
    value.schemaVersion !==
      "site-logbook.production-db-role-separation-postcommit/v1" ||
    value.kind !== "site-logbook-production-db-role-separation-postcommit" ||
    value.planSha256 !== rolePrecondition.rolePlanSha256 ||
    value.transactionReceiptSha256 !== roleReceipt.value.receiptSha256 ||
    !projection ||
    typeof projection !== "object" ||
    Array.isArray(projection) ||
    projection.schemaVersion !==
      "site-logbook.production-db-role-separation/v1" ||
    projection.migration !== "0107_canonical_audit_evidence" ||
    projection.migrationSha256 !==
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122" ||
    projection.databaseName !== verified.plan.database.name ||
    projection.runtimeRole?.name !== rolePrecondition.runtimeRole ||
    projection.migratorRole?.name !== rolePrecondition.migrationRole ||
    value.projectionSha256 !==
      createHash("sha256")
        .update(canonicalProductionMigrationJson(projection))
        .digest("hex") ||
    value.projectionSha256 !== roleReceipt.value.postProjectionSha256 ||
    !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(String(value.verifierId)) ||
    value.authorizesDeployment !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_POST_COMMIT_ROLE_INVALID",
      "Post-0107 role evidence is not independently bound to the exact role plan and projection.",
    );
  }
  const observedAt = exactTimestamp(
    value.observedAt,
    "postCommitRoleArtifact.observedAt",
  );
  return Object.freeze({ artifact, value, observedAt });
}

const RUN_ID = /^[0-9a-f]{64}$/;

function parseBoundPlanIntent(
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
) {
  const planArtifact = parseCanonicalProductionMigrationArtifact(
    planCanonical,
    "plan",
  );
  const plan = validateProductionMigrationPlan(planArtifact.value);
  const intentArtifact = parseCanonicalProductionMigrationArtifact(
    intentCanonical,
    "intent",
  );
  const intent = validateProductionMigrationIntent(
    intentArtifact.value,
    planCanonical,
  );
  const persistenceArtifact =
    validateProductionMigrationIntentPersistenceReceipt(
      intentPersistenceReceiptCanonical,
      planCanonical,
      intentCanonical,
    );
  return { planArtifact, plan, intentArtifact, intent, persistenceArtifact };
}

function validateTransactionEvidenceCanonical(canonical, index, binding) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    `transactionEvidence[${index}]`,
    256 * 1024,
  );
  const transaction = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "executorRunId",
      "planSha256",
      "intentSha256",
      "intentPersistenceReceiptSha256",
      "migration",
      "before",
      "after",
      "liveIdentityCanonical",
      "liveIdentitySha256",
      "advisoryLockKey",
      "transactionCommitted",
      "transactionStartedAt",
      "transactionCompletedAt",
      "authorizesApplicationStart",
    ],
    `transactionEvidence[${index}]`,
  );
  const before = validateProductionMigrationInventory(transaction.before);
  const after = validateProductionMigrationInventory(transaction.after);
  const live = parseProductionMigrationLiveIdentity(
    transaction.liveIdentityCanonical,
    `transactionEvidence[${index}].liveIdentityCanonical`,
  );
  const expectedLive = parseProductionMigrationLiveIdentity(
    binding.plan.baselineLiveIdentityCanonical,
    "plan.baselineLiveIdentityCanonical",
  );
  if (
    transaction.schemaVersion !==
      PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA ||
    transaction.kind !==
      "site-logbook-production-migration-transaction-evidence" ||
    !RUN_ID.test(String(transaction.executorRunId)) ||
    transaction.planSha256 !== binding.planArtifact.sha256 ||
    transaction.intentSha256 !== binding.intentArtifact.sha256 ||
    transaction.intentPersistenceReceiptSha256 !==
      binding.persistenceArtifact.sha256 ||
    canonicalProductionMigrationJson(transaction.migration) !==
      canonicalProductionMigrationJson(PRODUCTION_MIGRATION_STEPS[index]) ||
    before.stateIndex !== index ||
    after.stateIndex !== index + 1 ||
    transaction.liveIdentitySha256 !== live.artifact.sha256 ||
    live.value.sourceSha !== binding.plan.sourceSha ||
    canonicalProductionMigrationJson(live.database) !==
      canonicalProductionMigrationJson(binding.plan.database) ||
    live.value.applicationImageRef !== expectedLive.value.applicationImageRef ||
    live.value.postgresImageRef !== expectedLive.value.postgresImageRef ||
    live.value.runtimeBindingSha256 !==
      expectedLive.value.runtimeBindingSha256 ||
    live.state.stateIndex !== index + 1 ||
    canonicalProductionMigrationJson(live.value.inventory) !==
      canonicalProductionMigrationJson(transaction.after) ||
    transaction.advisoryLockKey !== PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY ||
    transaction.transactionCommitted !== true ||
    transaction.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_INVALID",
      "Transaction evidence is not the exact committed next step binding.",
    );
  }
  const startedAt = exactTimestamp(
    transaction.transactionStartedAt,
    `transactionEvidence[${index}].transactionStartedAt`,
  );
  const completedAt = exactTimestamp(
    transaction.transactionCompletedAt,
    `transactionEvidence[${index}].transactionCompletedAt`,
  );
  if (completedAt < startedAt || live.observedAt < completedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Transaction or its read-only live observation is not chronological.",
    );
  }
  return { artifact, transaction, live, before, after, startedAt, completedAt };
}

function validateReceiptValue(receipt, index, previousReceiptSha256, binding) {
  const value = exactObject(
    receipt,
    [
      "schemaVersion",
      "kind",
      "sequence",
      "executorRunId",
      "planSha256",
      "intentSha256",
      "intentPersistenceReceiptSha256",
      "previousReceiptSha256",
      "migration",
      "operation",
      "advisoryLockKey",
      "transactionCommitted",
      "transactionEvidenceCanonical",
      "transactionEvidenceSha256",
      "liveIdentitySha256",
      "before",
      "after",
      "startedAt",
      "completedAt",
      "opaqueLegacyRowsSha256",
      "productionTargetsTouched",
      "authorizesApplicationStart",
    ],
    `receipt[${index}]`,
  );
  const step = PRODUCTION_MIGRATION_STEPS[index];
  const transaction = validateTransactionEvidenceCanonical(
    value.transactionEvidenceCanonical,
    index,
    binding,
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_STEP_RECEIPT_SCHEMA ||
    value.kind !== "site-logbook-production-migration-step-receipt" ||
    value.sequence !== index + 1 ||
    !RUN_ID.test(String(value.executorRunId)) ||
    value.planSha256 !== binding.planArtifact.sha256 ||
    value.intentSha256 !== binding.intentArtifact.sha256 ||
    value.intentPersistenceReceiptSha256 !==
      binding.persistenceArtifact.sha256 ||
    value.previousReceiptSha256 !== previousReceiptSha256 ||
    canonicalProductionMigrationJson(value.migration) !==
      canonicalProductionMigrationJson(step) ||
    value.operation !== "applied" ||
    value.advisoryLockKey !== PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY ||
    value.transactionCommitted !== true ||
    value.transactionEvidenceSha256 !== transaction.artifact.sha256 ||
    value.liveIdentitySha256 !== transaction.live.artifact.sha256 ||
    value.executorRunId !== transaction.transaction.executorRunId ||
    canonicalProductionMigrationJson(value.before) !==
      canonicalProductionMigrationJson(
        frozenStateSummary(
          /** @type {any} */ ({
            ...step,
            knownAppliedMigrations: step.knownCountBefore,
            knownAppliedRowsSha256: step.knownRowsSha256Before,
            latestKnownAppliedTag:
              index === 0
                ? "0096_far_smiling_tiger"
                : PRODUCTION_MIGRATION_STEPS[index - 1].tag,
            totalJournalRows: 99 + index,
          }),
        ),
      ) ||
    canonicalProductionMigrationJson(value.after) !==
      canonicalProductionMigrationJson(
        frozenStateSummary(
          /** @type {any} */ ({
            ...step,
            knownAppliedMigrations: step.knownCountAfter,
            knownAppliedRowsSha256: step.knownRowsSha256After,
            latestKnownAppliedTag: step.tag,
            totalJournalRows: 100 + index,
          }),
        ),
      ) ||
    value.opaqueLegacyRowsSha256 !== PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 ||
    value.productionTargetsTouched !== true ||
    value.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RECEIPT_INVALID",
      `Receipt ${index + 1} is not the exact ordered committed step.`,
    );
  }
  const startedAt = exactTimestamp(
    value.startedAt,
    `receipt[${index}].startedAt`,
  );
  const completedAt = exactTimestamp(
    value.completedAt,
    `receipt[${index}].completedAt`,
  );
  if (completedAt < startedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Receipt completion precedes its start.",
    );
  }
  if (
    startedAt !== transaction.startedAt ||
    completedAt !== transaction.completedAt ||
    canonicalProductionMigrationJson(value.before) !==
      canonicalProductionMigrationJson(
        frozenStateSummary(transaction.before),
      ) ||
    canonicalProductionMigrationJson(value.after) !==
      canonicalProductionMigrationJson(frozenStateSummary(transaction.after))
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RECEIPT_INVALID",
      "Receipt does not preserve its canonical transaction evidence.",
    );
  }
  return { startedAt, completedAt };
}

export function verifyProductionMigrationReceiptSequence({
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  receiptCanonicals,
  requireComplete = false,
}) {
  if (!Array.isArray(receiptCanonicals) || receiptCanonicals.length > 10) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RECEIPT_INVALID",
      "Receipt sequence must contain at most ten canonical artifacts.",
    );
  }
  if (requireComplete && receiptCanonicals.length !== 10) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RECEIPT_INCOMPLETE",
      "Complete transition evidence requires all ten receipts.",
    );
  }
  const binding = parseBoundPlanIntent(
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
  );
  let previousReceiptSha256 = null;
  let previousCompletedAt = exactTimestamp(
    binding.persistenceArtifact.value.persistedAt,
    "intentPersistenceReceipt.persistedAt",
  );
  const receipts = receiptCanonicals.map((canonical, index) => {
    const artifact = parseCanonicalProductionMigrationArtifact(
      canonical,
      `receipt[${index}]`,
    );
    const times = validateReceiptValue(
      artifact.value,
      index,
      previousReceiptSha256,
      binding,
    );
    if (times.startedAt < previousCompletedAt) {
      productionMigrationFail(
        "PRODUCTION_MIGRATION_TIME_INVALID",
        "Receipt sequence is not chronological.",
      );
    }
    previousCompletedAt = times.completedAt;
    previousReceiptSha256 = artifact.sha256;
    return artifact;
  });
  return Object.freeze({
    ...binding,
    receipts: Object.freeze(receipts),
    receiptHeadSha256: previousReceiptSha256,
    completedAt: previousCompletedAt,
  });
}

export function createProductionMigrationStepReceipt({
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  priorReceiptCanonicals,
  transactionEvidenceCanonical,
}) {
  const verified = verifyProductionMigrationReceiptSequence({
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
    receiptCanonicals: priorReceiptCanonicals,
  });
  const index = verified.receipts.length;
  if (index >= 10) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_ALREADY_COMPLETE",
      "No migration step remains.",
    );
  }
  const transaction = validateTransactionEvidenceCanonical(
    transactionEvidenceCanonical,
    index,
    verified,
  );
  const before = transaction.before;
  const after = transaction.after;
  const startedMillis = transaction.startedAt;
  const completedMillis = transaction.completedAt;
  if (startedMillis < verified.completedAt || completedMillis < startedMillis) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Receipt timestamps must follow durable intent and prior receipts.",
    );
  }
  const receipt = {
    schemaVersion: PRODUCTION_MIGRATION_STEP_RECEIPT_SCHEMA,
    kind: "site-logbook-production-migration-step-receipt",
    sequence: index + 1,
    executorRunId: transaction.transaction.executorRunId,
    planSha256: verified.planArtifact.sha256,
    intentSha256: verified.intentArtifact.sha256,
    intentPersistenceReceiptSha256: verified.persistenceArtifact.sha256,
    previousReceiptSha256: verified.receiptHeadSha256,
    migration: PRODUCTION_MIGRATION_STEPS[index],
    operation: "applied",
    advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    transactionCommitted: true,
    transactionEvidenceCanonical: transaction.artifact.canonical,
    transactionEvidenceSha256: transaction.artifact.sha256,
    liveIdentitySha256: transaction.live.artifact.sha256,
    before: frozenStateSummary(before),
    after: frozenStateSummary(after),
    startedAt: new Date(startedMillis).toISOString(),
    completedAt: new Date(completedMillis).toISOString(),
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  };
  validateReceiptValue(receipt, index, verified.receiptHeadSha256, verified);
  return createProductionMigrationArtifact(receipt);
}

export function classifyProductionMigrationRecovery({
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  receiptCanonicals,
  liveIdentityCanonical,
  requestedAction = "inspect",
  resumeCommandCanonical,
}) {
  if (requestedAction === "retry") {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_BLIND_RETRY_REJECTED",
      "Blind retry is forbidden; classify and use an explicit receipt-backed resume.",
    );
  }
  if (!["inspect", "resume"].includes(requestedAction)) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RECOVERY_ACTION_INVALID",
      "Recovery action must be inspect or explicit resume.",
    );
  }
  const verified = verifyProductionMigrationReceiptSequence({
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
    receiptCanonicals,
  });
  const liveIdentity = parseProductionMigrationLiveIdentity(
    liveIdentityCanonical,
    "recovery.liveIdentityCanonical",
  );
  const expectedLive = parseProductionMigrationLiveIdentity(
    verified.plan.baselineLiveIdentityCanonical,
    "plan.baselineLiveIdentityCanonical",
  );
  if (
    liveIdentity.value.sourceSha !== verified.plan.sourceSha ||
    canonicalProductionMigrationJson(liveIdentity.database) !==
      canonicalProductionMigrationJson(verified.plan.database) ||
    liveIdentity.value.applicationImageRef !==
      expectedLive.value.applicationImageRef ||
    liveIdentity.value.postgresImageRef !==
      expectedLive.value.postgresImageRef ||
    liveIdentity.value.runtimeBindingSha256 !==
      expectedLive.value.runtimeBindingSha256
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_LIVE_IDENTITY_INVALID",
      "Recovery live identity does not match the frozen source/database/runtime target.",
    );
  }
  const live = liveIdentity.state;
  if (liveIdentity.observedAt < verified.completedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Recovery live identity predates the durable receipt head.",
    );
  }
  const receiptCount = verified.receipts.length;
  let decision;
  let resumeAllowed = false;
  let nextStep = null;
  let resumeCommandSha256 = null;
  if (live.stateIndex > receiptCount) {
    decision = "RESTORE_REQUIRED_UNKNOWN_COMMIT";
  } else if (live.stateIndex < receiptCount) {
    decision = "RESTORE_REQUIRED_RECEIPT_DIVERGENCE";
  } else if (receiptCount === 10) {
    decision = "COMPLETE_RECEIPT_BACKED";
  } else {
    decision =
      receiptCount === 0
        ? "INSPECT_READY_FIRST_STEP"
        : "INSPECT_READY_EXPLICIT_RESUME";
    if (requestedAction === "resume") {
      const resumeCommand = validateProductionMigrationResumeCommand({
        commandCanonical: resumeCommandCanonical,
        verified,
        nextStep: PRODUCTION_MIGRATION_STEPS[receiptCount],
      });
      decision =
        receiptCount === 0 ? "READY_FIRST_STEP" : "READY_EXPLICIT_RESUME";
      resumeAllowed = true;
      nextStep = PRODUCTION_MIGRATION_STEPS[receiptCount];
      resumeCommandSha256 = resumeCommand.sha256;
    }
  }
  const authorization = {
    schemaVersion:
      "site-logbook.production-migration-recovery-classification/v1",
    decision,
    intentSha256: verified.intentArtifact.sha256,
    receiptHeadSha256: verified.receiptHeadSha256,
    receiptCount,
    liveStateIndex: live.stateIndex,
    liveIdentitySha256: liveIdentity.artifact.sha256,
    nextStep,
    resumeCommandSha256,
    resumeAllowed,
    blindRetryAllowed: false,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    authorizesApplicationStart: false,
  };
  return createProductionMigrationArtifact(authorization);
}

export function createProductionMigrationResumeCommand({
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  receiptCanonicals,
  operator,
  approvedAt,
  confirmation,
}) {
  const verified = verifyProductionMigrationReceiptSequence({
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
    receiptCanonicals,
  });
  if (
    verified.receipts.length >= 10 ||
    confirmation !== PRODUCTION_MIGRATION_RESUME_CONFIRMATION
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RESUME_COMMAND_INVALID",
      "Exact resume confirmation and an incomplete receipt prefix are required.",
    );
  }
  const command = {
    schemaVersion: PRODUCTION_MIGRATION_RESUME_COMMAND_SCHEMA,
    kind: "site-logbook-production-migration-resume-command",
    planSha256: verified.planArtifact.sha256,
    intentSha256: verified.intentArtifact.sha256,
    intentPersistenceReceiptSha256: verified.persistenceArtifact.sha256,
    receiptHeadSha256: verified.receiptHeadSha256,
    receiptCount: verified.receipts.length,
    nextStep: PRODUCTION_MIGRATION_STEPS[verified.receipts.length],
    operator: exactString(operator, "operator", 256),
    approvedAt: new Date(
      exactTimestamp(approvedAt, "approvedAt"),
    ).toISOString(),
    confirmation,
    authorizesApplicationStart: false,
  };
  if (exactTimestamp(command.approvedAt, "approvedAt") < verified.completedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Resume approval predates durable receipt state.",
    );
  }
  return createProductionMigrationArtifact(command);
}

function validateProductionMigrationResumeCommand({
  commandCanonical,
  verified,
  nextStep,
}) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    commandCanonical,
    "resumeCommand",
    64 * 1024,
  );
  const command = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "planSha256",
      "intentSha256",
      "intentPersistenceReceiptSha256",
      "receiptHeadSha256",
      "receiptCount",
      "nextStep",
      "operator",
      "approvedAt",
      "confirmation",
      "authorizesApplicationStart",
    ],
    "resumeCommand",
  );
  if (
    command.schemaVersion !== PRODUCTION_MIGRATION_RESUME_COMMAND_SCHEMA ||
    command.kind !== "site-logbook-production-migration-resume-command" ||
    command.planSha256 !== verified.planArtifact.sha256 ||
    command.intentSha256 !== verified.intentArtifact.sha256 ||
    command.intentPersistenceReceiptSha256 !==
      verified.persistenceArtifact.sha256 ||
    command.receiptHeadSha256 !== verified.receiptHeadSha256 ||
    command.receiptCount !== verified.receipts.length ||
    canonicalProductionMigrationJson(command.nextStep) !==
      canonicalProductionMigrationJson(nextStep) ||
    command.confirmation !== PRODUCTION_MIGRATION_RESUME_CONFIRMATION ||
    command.authorizesApplicationStart !== false
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_RESUME_COMMAND_INVALID",
      "Resume command is not bound to the exact current receipt head and next step.",
    );
  }
  exactString(command.operator, "resumeCommand.operator", 256);
  if (
    exactTimestamp(command.approvedAt, "resumeCommand.approvedAt") <
    verified.completedAt
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Resume approval predates durable receipt state.",
    );
  }
  return artifact;
}

export function createProductionMigrationTransitionChain({
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  receiptCanonicals,
  finalInventory,
  finalLiveIdentityCanonical,
  roleTransactionReceiptCanonical,
  postCommitRoleArtifactCanonical,
  completedAt,
}) {
  const verified = verifyProductionMigrationReceiptSequence({
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
    receiptCanonicals,
    requireComplete: true,
  });
  const finalState = validateProductionMigrationInventory(finalInventory);
  if (finalState.stateIndex !== 10) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_FINAL_STATE_INVALID",
      "Transition chain requires exact 107-known/0107 plus two opaque rows.",
    );
  }
  const finalLive = parseProductionMigrationLiveIdentity(
    finalLiveIdentityCanonical,
    "finalLiveIdentityCanonical",
  );
  const expectedLive = parseProductionMigrationLiveIdentity(
    verified.plan.baselineLiveIdentityCanonical,
    "plan.baselineLiveIdentityCanonical",
  );
  if (
    finalLive.state.stateIndex !== 10 ||
    canonicalProductionMigrationJson(finalLive.value.inventory) !==
      canonicalProductionMigrationJson(finalInventory) ||
    finalLive.value.sourceSha !== verified.plan.sourceSha ||
    canonicalProductionMigrationJson(finalLive.database) !==
      canonicalProductionMigrationJson(verified.plan.database) ||
    finalLive.value.applicationImageRef !==
      expectedLive.value.applicationImageRef ||
    finalLive.value.postgresImageRef !== expectedLive.value.postgresImageRef ||
    finalLive.value.runtimeBindingSha256 !==
      expectedLive.value.runtimeBindingSha256
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_FINAL_STATE_INVALID",
      "Final live identity is not exact 0107 on the frozen source/database/runtime target.",
    );
  }
  const roleReceipt = parseRoleTransactionReceipt(
    roleTransactionReceiptCanonical,
    verified,
  );
  const postCommitRole = parsePostCommitRoleArtifact(
    postCommitRoleArtifactCanonical,
    verified,
    roleReceipt,
  );
  const completedMillis = exactTimestamp(completedAt, "completedAt");
  if (completedMillis < verified.completedAt) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Transition completion precedes the final receipt.",
    );
  }
  if (
    finalLive.observedAt < verified.completedAt ||
    roleReceipt.executedAt < finalLive.observedAt ||
    postCommitRole.observedAt < roleReceipt.executedAt ||
    completedMillis < postCommitRole.observedAt
  ) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TIME_INVALID",
      "Final live and post-commit role evidence must follow the migration receipts.",
    );
  }
  const chain = {
    schemaVersion: PRODUCTION_MIGRATION_TRANSITION_CHAIN_SCHEMA,
    kind: "site-logbook-production-migration-transition-chain",
    decision: "PASS",
    operation: "applied",
    sourceSha: verified.plan.sourceSha,
    targetEvidenceSha256: verified.plan.targetEvidenceSha256,
    planSha256: verified.planArtifact.sha256,
    intentSha256: verified.intentArtifact.sha256,
    intentPersistenceReceiptSha256: verified.persistenceArtifact.sha256,
    backupPlanSha256: verified.plan.backupPlanSha256,
    backupReceiptSha256: verified.plan.backupReceiptSha256,
    backupSignatureEnvelopeSha256: verified.plan.backupSignatureEnvelopeSha256,
    backupIntegritySha256: verified.plan.backupIntegritySha256,
    rolePreconditionSha256: verified.plan.rolePreconditionSha256,
    baseline: verified.plan.baseline,
    final: frozenStateSummary(finalState),
    receipts: verified.receipts.map((receipt, index) => ({
      sequence: index + 1,
      tag: PRODUCTION_MIGRATION_STEPS[index].tag,
      receiptSha256: receipt.sha256,
    })),
    receiptHeadSha256: verified.receiptHeadSha256,
    finalLiveIdentitySha256: finalLive.artifact.sha256,
    roleTransactionReceiptSha256: roleReceipt.artifact.sha256,
    postCommitRoleArtifactSha256: postCommitRole.artifact.sha256,
    opaqueLegacyRowsSha256: PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256,
    excludedMigration0100Present: false,
    completedAt: new Date(completedMillis).toISOString(),
    productionTargetsTouched: true,
    authorizesApplicationStart: false,
  };
  return createProductionMigrationArtifact(chain);
}

export function verifyProductionMigrationTransitionChain({
  chainCanonical,
  planCanonical,
  intentCanonical,
  intentPersistenceReceiptCanonical,
  receiptCanonicals,
  finalInventory,
  finalLiveIdentityCanonical,
  roleTransactionReceiptCanonical,
  postCommitRoleArtifactCanonical,
}) {
  const supplied = parseCanonicalProductionMigrationArtifact(
    chainCanonical,
    "transitionChain",
  );
  const expected = createProductionMigrationTransitionChain({
    planCanonical,
    intentCanonical,
    intentPersistenceReceiptCanonical,
    receiptCanonicals,
    finalInventory,
    finalLiveIdentityCanonical,
    roleTransactionReceiptCanonical,
    postCommitRoleArtifactCanonical,
    completedAt: supplied.value.completedAt,
  });
  if (supplied.canonical !== expected.canonical) {
    productionMigrationFail(
      "PRODUCTION_MIGRATION_TRANSITION_CHAIN_INVALID",
      "Transition chain is not the exact receipt-backed canonical artifact.",
    );
  }
  return supplied;
}
import { createHash } from "node:crypto";

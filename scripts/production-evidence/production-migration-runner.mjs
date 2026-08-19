import {
  PRODUCTION_MIGRATION_CONFIRMATION,
  PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
  PRODUCTION_MIGRATION_STEPS,
  canonicalProductionMigrationJson,
  createProductionMigrationArtifact,
  exactObject,
  exactString,
  parseCanonicalProductionMigrationArtifact,
  parseProductionMigrationLiveIdentity,
} from "./production-migration-contract.mjs";
import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createProductionMigrationAdapter,
  createProductionMigrationAdapterActivation,
  createVerifiedProductionMigrationPlan,
} from "./production-migration-adapter.mjs";
import { createProductionMigrationIntent } from "./production-migration-planner.mjs";
import {
  classifyProductionMigrationRecovery,
  createProductionMigrationResumeCommand,
  verifyProductionMigrationReceiptSequence,
} from "./production-migration-verifier.mjs";

export const PRODUCTION_MIGRATION_RUN_MANIFEST_SCHEMA =
  "site-logbook.production-migration-run-manifest/v1";
export const PRODUCTION_MIGRATION_INSPECT_CONFIRMATION =
  "INSPECT_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_READ_ONLY";
export const PRODUCTION_MIGRATION_APPLY_CONFIRMATION =
  "APPLY_NEXT_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_STEP";
export const PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION =
  "FINALIZE_RECEIPT_BACKED_0096_TO_0107_EXACT_MODVOLT_PRODUCTION_CHAIN";
export const PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION =
  "APPLY_RECEIPT_BACKED_0107_PRODUCTION_ROLE_CEREMONY";

const STORAGE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const INTENT_ID = /^[0-9a-f]{64}$/;

export class ProductionMigrationRunnerError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationRunnerError";
    this.code = code;
    this.restoreRequired = options?.restoreRequired === true;
    this.manualReviewRequired = options?.manualReviewRequired === true;
  }
}

function fail(code, message, options) {
  throw new ProductionMigrationRunnerError(code, message, options);
}

function exactStorageId(value, field) {
  const id = exactString(value, field, 128);
  if (!STORAGE_ID.test(id)) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_STORAGE_INVALID",
      `${field} is not a reviewed descriptor-relative storage identifier.`,
    );
  }
  return id;
}

function exactReceiptCount(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_RECEIPT_COUNT_INVALID",
      "Receipt count must be an explicit integer from zero through ten.",
    );
  }
  return value;
}

function requireConfirmation(actual, expected, field) {
  if (actual !== expected) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_CONFIRMATION_REQUIRED",
      `${field} requires its exact attended confirmation.`,
    );
  }
}

function receiptStorageIds(receiptCount) {
  return PRODUCTION_MIGRATION_STEPS.slice(
    0,
    exactReceiptCount(receiptCount),
  ).map(
    (step, index) =>
      `receipt-${String(index + 1).padStart(2, "0")}-${step.tag}.json`,
  );
}

function assertSameLiveBoundary(actualCanonical, expectedCanonical) {
  const actual = parseProductionMigrationLiveIdentity(
    actualCanonical,
    "runner.liveBoundary",
  );
  const expected = parseProductionMigrationLiveIdentity(
    expectedCanonical,
    "runner.expectedLiveBoundary",
  );
  if (
    actual.value.sourceSha !== expected.value.sourceSha ||
    canonicalProductionMigrationJson(actual.database) !==
      canonicalProductionMigrationJson(expected.database) ||
    actual.value.applicationImageRef !== expected.value.applicationImageRef ||
    actual.value.postgresImageRef !== expected.value.postgresImageRef ||
    actual.value.runtimeBindingSha256 !== expected.value.runtimeBindingSha256 ||
    canonicalProductionMigrationJson(actual.value.inventory) !==
      canonicalProductionMigrationJson(expected.value.inventory)
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_LIVE_DRIFT",
      "Authoritative live source, database, runtime or migration prefix differs from the reviewed baseline.",
    );
  }
  return actual;
}

function createRunManifest({
  intentId,
  plan,
  intent,
  activation,
  durableRun,
  createdAt,
}) {
  return createProductionMigrationArtifact({
    schemaVersion: PRODUCTION_MIGRATION_RUN_MANIFEST_SCHEMA,
    kind: "site-logbook-production-migration-run-manifest",
    intentId,
    planSha256: plan.sha256,
    intentSha256: intent.sha256,
    activationSha256: activation.sha256,
    planStorageId: durableRun.planStorageId,
    intentStorageId: durableRun.intentStorageId,
    intentPersistenceReceiptStorageId:
      durableRun.intentPersistenceReceiptStorageId,
    activationStorageId: `activation-${activation.sha256.slice(7)}.json`,
    createdAt,
    executionDefault: "disabled",
    authorizesApplicationStart: false,
  });
}

function parseRunManifest(canonical, expected) {
  const artifact = parseCanonicalProductionMigrationArtifact(
    canonical,
    "runManifest",
    128 * 1024,
  );
  const value = exactObject(
    artifact.value,
    [
      "schemaVersion",
      "kind",
      "intentId",
      "planSha256",
      "intentSha256",
      "activationSha256",
      "planStorageId",
      "intentStorageId",
      "intentPersistenceReceiptStorageId",
      "activationStorageId",
      "createdAt",
      "executionDefault",
      "authorizesApplicationStart",
    ],
    "runManifest",
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_RUN_MANIFEST_SCHEMA ||
    value.kind !== "site-logbook-production-migration-run-manifest" ||
    value.intentId !== expected.intentId ||
    value.planSha256 !== expected.planSha256 ||
    value.executionDefault !== "disabled" ||
    value.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_MANIFEST_INVALID",
      "Durable run manifest is not exact, default-dark and bound to this reviewed plan.",
    );
  }
  for (const field of [
    "planStorageId",
    "intentStorageId",
    "intentPersistenceReceiptStorageId",
    "activationStorageId",
  ]) {
    exactStorageId(value[field], `runManifest.${field}`);
  }
  return Object.freeze({ artifact, value });
}

async function persistAndReadback(artifacts, storageId, canonical) {
  exactStorageId(storageId, "storageId");
  await artifacts.persistExclusive(storageId, canonical);
  const readback = await artifacts.readCanonical(storageId);
  if (readback !== canonical) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_READBACK_MISMATCH",
      "Durable artifact read-back differs from the exact canonical bytes.",
    );
  }
}

function requiredDependencies({
  database,
  artifacts,
  roleAuthority,
  backupAuthority,
}) {
  if (
    !database ||
    typeof database.readLiveIdentityReadOnly !== "function" ||
    typeof database.applyExactStepTransaction !== "function" ||
    !artifacts ||
    typeof artifacts.persistExclusive !== "function" ||
    typeof artifacts.readCanonical !== "function" ||
    !roleAuthority ||
    typeof roleAuthority.assertPrecondition !== "function" ||
    !backupAuthority ||
    typeof backupAuthority.assertInputSignature !== "function" ||
    typeof backupAuthority.assertPlanSignature !== "function"
  ) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_UNAVAILABLE",
      "Runner dependencies are incomplete; production migration remains disabled.",
    );
  }
}

export function createProductionMigrationExecutable({
  planInput,
  roleBindingCanonical,
  intentId,
  database = null,
  artifacts = null,
  roleAuthority = null,
  backupAuthority = null,
  now = () => new Date(),
} = {}) {
  requiredDependencies({ database, artifacts, roleAuthority, backupAuthority });
  if (!INTENT_ID.test(String(intentId))) {
    fail(
      "PRODUCTION_MIGRATION_RUNNER_INTENT_INVALID",
      "Runner intent id must be an exact 64-character lowercase hex value.",
    );
  }
  const plan = createVerifiedProductionMigrationPlan(
    planInput,
    backupAuthority,
  );
  const adapter = createProductionMigrationAdapter({
    database,
    artifacts,
    roleAuthority,
    backupAuthority,
    now,
  });
  const manifestStorageId = `run-${intentId}.json`;

  async function loadContext(receiptCount) {
    const manifestCanonical = await artifacts.readCanonical(manifestStorageId);
    const manifest = parseRunManifest(manifestCanonical, {
      intentId,
      planSha256: plan.sha256,
    });
    const durableRun = Object.freeze({
      planStorageId: manifest.value.planStorageId,
      intentStorageId: manifest.value.intentStorageId,
      intentPersistenceReceiptStorageId:
        manifest.value.intentPersistenceReceiptStorageId,
    });
    const durable = await adapter.loadDurableRun(durableRun);
    const activationCanonical = await artifacts.readCanonical(
      manifest.value.activationStorageId,
    );
    const activation = parseCanonicalProductionMigrationArtifact(
      activationCanonical,
      "activation",
    );
    if (activation.sha256 !== manifest.value.activationSha256) {
      fail(
        "PRODUCTION_MIGRATION_RUNNER_MANIFEST_INVALID",
        "Durable activation digest differs from the run manifest.",
      );
    }
    const ids = receiptStorageIds(receiptCount);
    const receiptCanonicals = [];
    for (const id of ids) {
      receiptCanonicals.push(await artifacts.readCanonical(id));
    }
    verifyProductionMigrationReceiptSequence({
      planCanonical: durable.planCanonical,
      intentCanonical: durable.intentCanonical,
      intentPersistenceReceiptCanonical:
        durable.intentPersistenceReceiptCanonical,
      receiptCanonicals,
    });
    return Object.freeze({
      manifest,
      durableRun,
      durable,
      activationCanonical,
      receiptStorageIds: ids,
      receiptCanonicals,
    });
  }

  async function freshRecovery(context, requestedAction, resumeCanonical) {
    const live = await database.readLiveIdentityReadOnly();
    return classifyProductionMigrationRecovery({
      planCanonical: context.durable.planCanonical,
      intentCanonical: context.durable.intentCanonical,
      intentPersistenceReceiptCanonical:
        context.durable.intentPersistenceReceiptCanonical,
      receiptCanonicals: context.receiptCanonicals,
      liveIdentityCanonical: live.canonical,
      requestedAction,
      resumeCommandCanonical: resumeCanonical,
    });
  }

  return Object.freeze({
    planSha256: plan.sha256,
    manifestStorageId,

    async prepare({
      operator,
      approvedAt,
      intentConfirmation,
      activationConfirmation,
    }) {
      requireConfirmation(
        intentConfirmation,
        PRODUCTION_MIGRATION_CONFIRMATION,
        "intentConfirmation",
      );
      requireConfirmation(
        activationConfirmation,
        PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
        "activationConfirmation",
      );
      const live = await database.readLiveIdentityReadOnly();
      assertSameLiveBoundary(
        live.canonical,
        plan.value.baselineLiveIdentityCanonical,
      );
      const intent = createProductionMigrationIntent({
        planCanonical: plan.canonical,
        intentId,
        createdAt: approvedAt,
        operator,
        confirmation: intentConfirmation,
      });
      const activation = createProductionMigrationAdapterActivation({
        planCanonical: plan.canonical,
        roleBindingCanonical,
        approvedAt,
        operator,
        confirmation: activationConfirmation,
      });
      const durableRun = await adapter.prepareDurableRun({
        activationCanonical: activation.canonical,
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
      });
      const activationStorageId = `activation-${activation.sha256.slice(7)}.json`;
      await persistAndReadback(
        artifacts,
        activationStorageId,
        activation.canonical,
      );
      const manifest = createRunManifest({
        intentId,
        plan,
        intent,
        activation,
        durableRun,
        createdAt: approvedAt,
      });
      await persistAndReadback(
        artifacts,
        manifestStorageId,
        manifest.canonical,
      );
      return Object.freeze({
        decision: "DURABLE_RUN_PREPARED",
        manifestStorageId,
        manifestSha256: manifest.sha256,
        planSha256: plan.sha256,
        authorizesApplicationStart: false,
      });
    },

    async inspect({ receiptCount, confirmation }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_MIGRATION_INSPECT_CONFIRMATION,
        "inspect.confirmation",
      );
      const context = await loadContext(receiptCount);
      const recovery = await freshRecovery(context, "inspect");
      return Object.freeze({
        decision: recovery.value.decision,
        receiptCount: context.receiptCanonicals.length,
        liveStateIndex: recovery.value.liveStateIndex,
        inspectionSha256: recovery.sha256,
        resumeAllowed: false,
        nextStep: null,
        authorizesApplicationStart: false,
      });
    },

    async resume({ receiptCount, operator, approvedAt, confirmation }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_MIGRATION_RESUME_CONFIRMATION,
        "resume.confirmation",
      );
      const context = await loadContext(receiptCount);
      if (
        context.receiptCanonicals.length >= PRODUCTION_MIGRATION_STEPS.length
      ) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ALREADY_COMPLETE",
          "All ten receipt-backed steps are already present.",
        );
      }
      const command = createProductionMigrationResumeCommand({
        planCanonical: context.durable.planCanonical,
        intentCanonical: context.durable.intentCanonical,
        intentPersistenceReceiptCanonical:
          context.durable.intentPersistenceReceiptCanonical,
        receiptCanonicals: context.receiptCanonicals,
        operator,
        approvedAt,
        confirmation,
      });
      const recovery = await freshRecovery(
        context,
        "resume",
        command.canonical,
      );
      if (!recovery.value.resumeAllowed || !recovery.value.nextStep) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_RESUME_DENIED",
          "Fresh read-only classification did not authorize one exact next step.",
        );
      }
      const storageId = `resume-${String(receiptCount + 1).padStart(2, "0")}-${command.sha256.slice(7)}.json`;
      await persistAndReadback(artifacts, storageId, command.canonical);
      return Object.freeze({
        decision: "NEXT_STEP_RESUME_DURABLE",
        storageId,
        sha256: command.sha256,
        nextStepTag: recovery.value.nextStep.tag,
        receiptCount,
        authorizesApplicationStart: false,
      });
    },

    async apply({ receiptCount, resumeStorageId, confirmation }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_MIGRATION_APPLY_CONFIRMATION,
        "apply.confirmation",
      );
      const count = exactReceiptCount(receiptCount);
      if (count >= PRODUCTION_MIGRATION_STEPS.length) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ALREADY_COMPLETE",
          "All ten receipt-backed steps are already present.",
        );
      }
      const id = exactStorageId(resumeStorageId, "resumeStorageId");
      if (!id.startsWith(`resume-${String(count + 1).padStart(2, "0")}-`)) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_RESUME_INVALID",
          "Resume artifact is not sequence-bound to the explicit receipt count.",
        );
      }
      const context = await loadContext(count);
      const resumeCommandCanonical = await artifacts.readCanonical(id);
      const applied = await adapter.executeNext({
        activationCanonical: context.activationCanonical,
        durableRun: context.durableRun,
        receiptStorageIds: context.receiptStorageIds,
        resumeCommandCanonical,
      });
      return Object.freeze({
        decision: applied.decision,
        receiptStorageId: applied.receiptStorageId,
        receiptSha256: applied.receiptSha256,
        receiptCount: count + 1,
        authorizesApplicationStart: false,
      });
    },

    async applyRoleCeremony({
      receiptCount,
      confirmation,
      activationCanonical,
      persistEvidence,
    }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_MIGRATION_ROLE_CEREMONY_CONFIRMATION,
        "applyRoleCeremony.confirmation",
      );
      const count = exactReceiptCount(receiptCount);
      if (count !== PRODUCTION_MIGRATION_STEPS.length) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_DENIED",
          "Role ceremony requires all ten exact durable migration receipts.",
        );
      }
      if (
        typeof roleAuthority.applyCeremony !== "function" ||
        typeof persistEvidence !== "function" ||
        typeof activationCanonical !== "string"
      ) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_UNAVAILABLE",
          "Source-pinned role ceremony authority and exclusive custody are required.",
        );
      }
      const context = await loadContext(count);
      const recovery = await freshRecovery(context, "inspect");
      if (recovery.value.decision !== "COMPLETE_RECEIPT_BACKED") {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_DENIED",
          "Fresh read-only recovery evidence does not prove the complete ten-receipt target.",
        );
      }
      const evidence = await roleAuthority.applyCeremony({
        planCanonical: context.durable.planCanonical,
        activationCanonical,
      });
      try {
        await persistEvidence(evidence);
      } catch (error) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_ROLE_CEREMONY_CUSTODY_INCOMPLETE",
          "Role changes committed but exclusive evidence custody is incomplete; preserve evidence and perform manual restore review.",
          {
            cause: error,
            restoreRequired: true,
            manualReviewRequired: true,
          },
        );
      }
      return Object.freeze({
        decision: "ROLE_CEREMONY_COMMITTED_EVIDENCE_DURABLE",
        receiptCount: count,
        restoreRequired: false,
        authorizesApplicationStart: false,
      });
    },

    async finalize({ receiptCount, confirmation }) {
      requireConfirmation(
        confirmation,
        PRODUCTION_MIGRATION_FINALIZE_CONFIRMATION,
        "finalize.confirmation",
      );
      const count = exactReceiptCount(receiptCount);
      if (count !== PRODUCTION_MIGRATION_STEPS.length) {
        fail(
          "PRODUCTION_MIGRATION_RUNNER_FINALIZE_DENIED",
          "Finalization requires all ten exact durable step receipts.",
        );
      }
      const context = await loadContext(count);
      const chain = await adapter.finalize({
        activationCanonical: context.activationCanonical,
        durableRun: context.durableRun,
        receiptStorageIds: context.receiptStorageIds,
      });
      return Object.freeze({
        decision: "TRANSITION_CHAIN_DURABLE",
        storageId: chain.storageId,
        sha256: chain.sha256,
        receiptCount: count,
        rolePostCommitProofRequired: true,
        authorizesApplicationStart: false,
      });
    },
  });
}

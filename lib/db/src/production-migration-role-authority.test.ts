// @ts-nocheck -- Cross-runtime integration imports source-only canonical JS.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  PRODUCTION_ROLE_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
  REQUIRED_FUNCTION_GRANTS,
  REQUIRED_SEQUENCE_GRANTS,
  REQUIRED_TABLE_GRANTS,
  ROLE_CONTRACT_MIGRATION,
  ROLE_CONTRACT_MIGRATION_SHA256,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  createOneShotProductionRoleExecutor,
  type ProductionRoleProjection,
  type ProjectedObject,
} from "./production-role-separation-contract.js";
import {
  assertProductionMigrationPlanRolePrecondition,
  parseProductionMigrationPostCommitRoleAuthority,
  productionMigrationRoleAuthority,
} from "./production-migration-role-authority.js";

import {
  PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  createProductionMigrationAdapter,
  createProductionMigrationAdapterActivation,
  createProductionMigrationRoleBinding,
} from "../../../scripts/production-evidence/production-migration-adapter.mjs";
import {
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_MIGRATION_STEPS,
  PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
  createProductionMigrationArtifact,
  createProductionMigrationLiveIdentity,
} from "../../../scripts/production-evidence/production-migration-contract.mjs";
import {
  createProductionMigrationIntent,
  createProductionMigrationIntentPersistenceReceipt,
  createProductionMigrationPlan,
} from "../../../scripts/production-evidence/production-migration-planner.mjs";
import { createProductionMigrationStepReceipt } from "../../../scripts/production-evidence/production-migration-verifier.mjs";
import {
  fixtureIntentInput,
  fixtureInventory,
  fixturePlanInput,
  fixtureRunId,
} from "../../../scripts/test/production-migration-control-plane-fixtures.mjs";

const runtimeRole = {
  name: "site_logbook_runtime",
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
} as const;
const migratorRole = {
  name: "site_logbook_backup",
  login: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
} as const;
const database = {
  name: "site_logbook",
  sessionUser: "site_logbook_executor",
  currentUser: migratorRole.name,
} as const;

function requiredObjects(): ProjectedObject[] {
  return [
    ...REQUIRED_TABLE_GRANTS.map((grant) => ({
      kind: "table" as const,
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: migratorRole.name,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...REQUIRED_SEQUENCE_GRANTS.map((grant) => ({
      kind: "sequence" as const,
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: migratorRole.name,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...REQUIRED_FUNCTION_GRANTS.map((grant) => ({
      kind: "function" as const,
      schema: grant.schema,
      name: grant.name,
      identityArguments: grant.identityArguments,
      owner: migratorRole.name,
      securityDefiner: false,
      functionSettings: ["search_path=pg_catalog, public, pg_temp"],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
  ];
}

function validProjection(): ProductionRoleProjection {
  return {
    schemaVersion: PRODUCTION_ROLE_CONTRACT_SCHEMA,
    migration: ROLE_CONTRACT_MIGRATION,
    migrationSha256: ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: database.name,
    databaseOwner: migratorRole.name,
    databasePublicPrivileges: ["CONNECT"],
    databaseRuntimePrivileges: ["CONNECT"],
    databaseOtherGrants: [],
    runtimeRole,
    migratorRole,
    runtimeMemberOf: [],
    migratorMemberOf: [],
    runtimeRoleMembers: [],
    migratorRoleMembers: [],
    runtimeGlobalSettings: [],
    runtimeDatabaseSettings: ["search_path=pg_catalog, public, pg_temp"],
    schemas: [
      {
        name: "public",
        owner: migratorRole.name,
        publicPrivileges: ["USAGE"],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
      {
        name: "drizzle",
        owner: migratorRole.name,
        publicPrivileges: [],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
    ],
    defaultPrivileges: ["public", "drizzle"].flatMap((schema) =>
      ["table", "sequence", "function"].map((kind) => ({
        schema: schema as "public" | "drizzle",
        kind: kind as "table" | "sequence" | "function",
        owner: migratorRole.name,
        publicPrivileges: [],
        runtimePrivileges: [],
        otherGrants: [],
      })),
    ),
    objects: requiredObjects(),
  };
}

function rolePreconditionCanonical(projection = validProjection()): string {
  const preProjectionCanonical = canonicalProductionRoleJson(projection);
  const preProjectionSha256 = createHash("sha256")
    .update(preProjectionCanonical)
    .digest("hex");
  const rolePlan = buildProductionRolePlan({
    databaseName: database.name,
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const rolePlanCanonical = canonicalProductionRoleJson(rolePlan);
  return canonicalProductionRoleJson({
    schemaVersion: "site-logbook.production-migration-role-precondition/v1",
    kind: "site-logbook-production-migration-role-precondition",
    sourceSha: "a".repeat(40),
    database,
    migrationRole: migratorRole.name,
    runtimeRole: runtimeRole.name,
    rolePlanCanonical,
    rolePlanSha256: rolePlan.planSha256,
    preProjectionCanonical,
    preProjectionSha256,
    capturedAt: "2026-08-12T10:00:00.000Z",
    migrationRoleCanApplyMigrations: true,
    runtimeRoleCanApplyMigrations: false,
    authorizesApplicationStart: false,
  });
}

function migrationPlanCanonical(preconditionCanonical: string): string {
  return canonicalProductionRoleJson({
    sourceSha: "a".repeat(40),
    database,
    rolePreconditionCanonical: preconditionCanonical,
    rolePreconditionSha256: `sha256:${createHash("sha256")
      .update(preconditionCanonical)
      .digest("hex")}`,
  });
}

test("authoritative precondition recursively accepts exact ACL projection and rejects nested drift", () => {
  const canonical = rolePreconditionCanonical();
  const result = assertProductionMigrationPlanRolePrecondition(
    migrationPlanCanonical(canonical),
  );
  assert.equal(result.value.migrationRole, migratorRole.name);
  assert.equal(result.value.authorizesApplicationStart, false);

  const drifted = structuredClone(validProjection()) as unknown as {
    objects: Array<{ publicPrivileges: string[] }>;
  };
  drifted.objects[0].publicPrivileges.push("SELECT");
  assert.throws(
    () =>
      assertProductionMigrationPlanRolePrecondition(
        migrationPlanCanonical(
          rolePreconditionCanonical(
            drifted as unknown as ProductionRoleProjection,
          ),
        ),
      ),
    /PRODUCTION_MIGRATION_ROLE_PRE_PROJECTION_INVALID/,
  );
});

test("authoritative postcommit wrapper binds exact role plan, receipt and recursive projection", async () => {
  const projection = validProjection();
  const rolePlan = buildProductionRolePlan({
    databaseName: database.name,
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const executor = {
    id: "role-executor-1",
    async begin() {},
    async execute() {},
    async project() {
      return projection;
    },
    async commit() {},
    async rollback() {},
  };
  const receipt = await createOneShotProductionRoleExecutor(executor).execute(
    rolePlan,
    {
      enabled: true,
      expectedPlanSha256: rolePlan.planSha256,
      approvalId: "role-approval-1",
      preProjectionCanonical: canonicalProductionRoleJson(projection),
      expectedPreProjectionSha256: createHash("sha256")
        .update(canonicalProductionRoleJson(projection))
        .digest("hex"),
    },
  );
  const postCommitCanonical = canonicalProductionRoleJson({
    schemaVersion: PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: rolePlan.planSha256,
    transactionReceiptSha256: receipt.receiptSha256,
    projection,
    projectionSha256: receipt.postProjectionSha256,
    verifierId: "role-verifier-1",
    observedAt: new Date(Date.parse(receipt.executedAt) + 1).toISOString(),
    authorizesDeployment: false,
  });
  const result = parseProductionMigrationPostCommitRoleAuthority({
    rolePlanCanonical: canonicalProductionRoleJson(rolePlan),
    roleTransactionReceiptCanonical: canonicalProductionRoleJson(receipt),
    rolePostCommitProjectionCanonical: postCommitCanonical,
  });
  assert.equal(result.value.authorizesDeployment, false);
  assert.equal(result.value.projection.migratorRole.login, false);
});

test("adapter finalize invokes the real recursive pre/post role authority", async () => {
  const projection = validProjection();
  const rolePlan = buildProductionRolePlan({
    databaseName: database.name,
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const executor = {
    id: "role-executor-finalize",
    async begin() {},
    async execute() {},
    async project() {
      return projection;
    },
    async commit() {},
    async rollback() {},
  };
  const generatedRoleReceipt = await createOneShotProductionRoleExecutor(
    executor,
  ).execute(rolePlan, {
    enabled: true,
    expectedPlanSha256: rolePlan.planSha256,
    approvalId: "role-approval-finalize",
    preProjectionCanonical: canonicalProductionRoleJson(projection),
    expectedPreProjectionSha256: createHash("sha256")
      .update(canonicalProductionRoleJson(projection))
      .digest("hex"),
  });
  const roleReceiptBody = {
    ...generatedRoleReceipt,
    executedAt: "2026-08-12T11:11:10.000Z",
  };
  delete (roleReceiptBody as Partial<typeof generatedRoleReceipt>)
    .receiptSha256;
  const roleReceipt = {
    ...roleReceiptBody,
    receiptSha256: createHash("sha256")
      .update(canonicalProductionRoleJson(roleReceiptBody))
      .digest("hex"),
  };
  const roleExecutedAt = Date.parse(roleReceipt.executedAt);
  const postCommitRoleArtifactCanonical = canonicalProductionRoleJson({
    schemaVersion: PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: rolePlan.planSha256,
    transactionReceiptSha256: roleReceipt.receiptSha256,
    projection,
    projectionSha256: roleReceipt.postProjectionSha256,
    verifierId: "role-verifier-finalize",
    observedAt: new Date(roleExecutedAt + 1).toISOString(),
    authorizesDeployment: false,
  });

  const input = fixturePlanInput();
  input.rolePreconditionCanonical = rolePreconditionCanonical(projection);
  const plan = createProductionMigrationPlan(input);
  const intent = createProductionMigrationIntent(
    fixtureIntentInput(plan.canonical),
  );
  const persistence = createProductionMigrationIntentPersistenceReceipt({
    planCanonical: plan.canonical,
    intentCanonical: intent.canonical,
    persistedCanonical: intent.canonical,
    persistedAt: "2026-08-12T11:00:30.000Z",
    storageId: "intent-finalize-real-role.json",
  });
  const baseline = JSON.parse(plan.value.baselineLiveIdentityCanonical);
  const receiptClockStart = Date.parse("2026-08-12T11:01:00.000Z");
  const receipts: Array<{ canonical: string }> = [];
  for (const [index, migration] of PRODUCTION_MIGRATION_STEPS.entries()) {
    const startedAt = new Date(receiptClockStart + index * 2_000);
    const completedAt = new Date(startedAt.getTime() + 1_000);
    const live = createProductionMigrationLiveIdentity({
      sourceSha: plan.value.sourceSha,
      database: plan.value.database,
      applicationImageRef: baseline.applicationImageRef,
      postgresImageRef: baseline.postgresImageRef,
      runtimeBindingSha256: baseline.runtimeBindingSha256,
      inventory: fixtureInventory(index + 1),
      observedAt: completedAt.toISOString(),
    });
    const transaction = createProductionMigrationArtifact({
      schemaVersion: PRODUCTION_MIGRATION_TRANSACTION_EVIDENCE_SCHEMA,
      kind: "site-logbook-production-migration-transaction-evidence",
      executorRunId: fixtureRunId,
      planSha256: plan.sha256,
      intentSha256: intent.sha256,
      intentPersistenceReceiptSha256: persistence.sha256,
      migration,
      before: fixtureInventory(index),
      after: fixtureInventory(index + 1),
      liveIdentityCanonical: live.canonical,
      liveIdentitySha256: live.sha256,
      advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
      transactionCommitted: true,
      transactionStartedAt: startedAt.toISOString(),
      transactionCompletedAt: completedAt.toISOString(),
      authorizesApplicationStart: false,
    });
    receipts.push(
      createProductionMigrationStepReceipt({
        planCanonical: plan.canonical,
        intentCanonical: intent.canonical,
        intentPersistenceReceiptCanonical: persistence.canonical,
        priorReceiptCanonicals: receipts.map((receipt) => receipt.canonical),
        transactionEvidenceCanonical: transaction.canonical,
      }),
    );
  }
  const finalLive = createProductionMigrationLiveIdentity({
    sourceSha: plan.value.sourceSha,
    database: plan.value.database,
    applicationImageRef: baseline.applicationImageRef,
    postgresImageRef: baseline.postgresImageRef,
    runtimeBindingSha256: baseline.runtimeBindingSha256,
    inventory: fixtureInventory(10),
    observedAt: new Date(receiptClockStart + 20_500).toISOString(),
  });
  const roleBinding = createProductionMigrationRoleBinding({
    databaseName: database.name,
    sessionUser: database.sessionUser,
    migrationRole: database.currentUser,
    runtimeRole: runtimeRole.name,
  });
  const activation = createProductionMigrationAdapterActivation({
    planCanonical: plan.canonical,
    roleBindingCanonical: roleBinding.canonical,
    approvedAt: "2026-08-12T11:00:10.000Z",
    operator: "production-owner",
    confirmation: PRODUCTION_MIGRATION_ADAPTER_CONFIRMATION,
  });
  const values = new Map<string, string>([
    ["plan.json", plan.canonical],
    ["intent.json", intent.canonical],
    ["persistence.json", persistence.canonical],
    ...receipts.map(
      (receipt, index) =>
        [`receipt-${index + 1}.json`, receipt.canonical] as const,
    ),
  ]);
  let postRoleRuntimeChecks = 0;
  const adapter = createProductionMigrationAdapter({
    database: {
      async readInventoryReadOnly() {
        return fixtureInventory(10);
      },
      async readLiveIdentityReadOnly() {
        return finalLive;
      },
      async assertLiveRuntimeReadOnly() {
        postRoleRuntimeChecks += 1;
      },
      async applyExactStepTransaction() {
        throw new Error("not used by finalize");
      },
    },
    artifacts: {
      async persistExclusive(storageId: string, canonical: string) {
        assert.equal(values.has(storageId), false);
        values.set(storageId, canonical);
      },
      async readCanonical(storageId: string) {
        const canonical = values.get(storageId);
        if (canonical === undefined) throw new Error("artifact missing");
        return canonical;
      },
    },
    roleAuthority: {
      ...productionMigrationRoleAuthority,
      async readPostCommitEvidence() {
        return {
          roleTransactionReceiptCanonical:
            canonicalProductionRoleJson(roleReceipt),
          postCommitRoleArtifactCanonical,
        };
      },
    },
    backupAuthority: { assertPlanSignature() {} },
    now: () => new Date("2026-08-12T11:12:00.000Z"),
  });
  const result = await adapter.finalize({
    activationCanonical: activation.canonical,
    durableRun: {
      planStorageId: "plan.json",
      intentStorageId: "intent.json",
      intentPersistenceReceiptStorageId: "persistence.json",
    },
    receiptStorageIds: receipts.map(
      (_receipt, index) => `receipt-${index + 1}.json`,
    ),
  });
  assert.equal(JSON.parse(result.canonical).authorizesApplicationStart, false);
  assert.equal(postRoleRuntimeChecks, 1);
});

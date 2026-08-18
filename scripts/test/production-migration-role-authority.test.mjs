import assert from "node:assert/strict";
import test from "node:test";

import { createVerifiedProductionMigrationPlan } from "../production-evidence/production-migration-adapter.mjs";
import { fixturePlanInput } from "./production-migration-control-plane-fixtures.mjs";

const { tsImport } =
  await import("../../lib/db/node_modules/tsx/dist/esm/api/index.mjs");
const roleContract = await tsImport(
  "../../lib/db/src/production-role-separation-contract.ts",
  import.meta.url,
);
const roleAuthority = await tsImport(
  "../production-evidence/production-migration-role-authority.ts",
  import.meta.url,
);

function exactProjection(plan) {
  const runtimeRole = {
    name: plan.runtimeRole,
    login: true,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  };
  const migratorRole = {
    name: plan.migratorRole,
    login: false,
    superuser: false,
    createDatabase: false,
    createRole: false,
    replication: false,
    bypassRls: false,
  };
  const objects = [
    ...roleContract.REQUIRED_TABLE_GRANTS.map((grant) => ({
      kind: "table",
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...roleContract.REQUIRED_SEQUENCE_GRANTS.map((grant) => ({
      kind: "sequence",
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: [],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
    ...roleContract.REQUIRED_FUNCTION_GRANTS.map((grant) => ({
      kind: "function",
      schema: grant.schema,
      name: grant.name,
      identityArguments: grant.identityArguments,
      owner: plan.migratorRole,
      securityDefiner: false,
      functionSettings: ["search_path=pg_catalog, public, pg_temp"],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
  ];
  const projection = {
    schemaVersion: roleContract.PRODUCTION_ROLE_CONTRACT_SCHEMA,
    migration: roleContract.ROLE_CONTRACT_MIGRATION,
    migrationSha256: roleContract.ROLE_CONTRACT_MIGRATION_SHA256,
    databaseName: plan.databaseName,
    databaseOwner: plan.migratorRole,
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
        owner: plan.migratorRole,
        publicPrivileges: ["USAGE"],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
      {
        name: "drizzle",
        owner: plan.migratorRole,
        publicPrivileges: [],
        runtimePrivileges: ["USAGE"],
        otherGrants: [],
      },
    ],
    defaultPrivileges: ["public", "drizzle"].flatMap((schema) =>
      ["table", "sequence", "function"].map((kind) => ({
        schema,
        kind,
        owner: plan.migratorRole,
        publicPrivileges: [],
        runtimePrivileges: [],
        otherGrants: [],
      })),
    ),
    objects,
  };
  const validation = roleContract.validateProductionRoleProjection(projection);
  assert.deepEqual(validation.errors, []);
  return projection;
}

function rawProjection(projection) {
  return {
    database: {
      name: projection.databaseName,
      owner: projection.databaseOwner,
      publicPrivileges: projection.databasePublicPrivileges,
      runtimePrivileges: projection.databaseRuntimePrivileges,
      otherGrants: projection.databaseOtherGrants,
    },
    roles: [projection.runtimeRole, projection.migratorRole],
    runtimeMemberOf: projection.runtimeMemberOf,
    migratorMemberOf: projection.migratorMemberOf,
    runtimeRoleMembers: projection.runtimeRoleMembers,
    migratorRoleMembers: projection.migratorRoleMembers,
    runtimeGlobalSettings: projection.runtimeGlobalSettings,
    runtimeDatabaseSettings: projection.runtimeDatabaseSettings,
    schemas: projection.schemas,
    defaultPrivileges: projection.defaultPrivileges,
    relations: projection.objects.filter((entry) => entry.kind !== "function"),
    functions: projection.objects.filter((entry) => entry.kind === "function"),
  };
}

function ceremonyFixture() {
  const planInput = fixturePlanInput();
  const rolePlan = roleContract.buildProductionRolePlan({
    databaseName: planInput.database.name,
    runtimeRole: "site_logbook_runtime",
    migratorRole: planInput.database.currentUser,
  });
  const projection = exactProjection(rolePlan);
  const rolePlanCanonical = roleContract.canonicalProductionRoleJson(rolePlan);
  const preProjectionCanonical =
    roleContract.canonicalProductionRoleJson(projection);
  const preProjectionSha256 = roleContract.parseCanonicalProductionRoleArtifact(
    preProjectionCanonical,
  ).sha256;
  const preconditionCanonical = roleContract.canonicalProductionRoleJson({
    schemaVersion: "site-logbook.production-migration-role-precondition/v1",
    kind: "site-logbook-production-migration-role-precondition",
    sourceSha: planInput.sourceSha,
    database: planInput.database,
    migrationRole: rolePlan.migratorRole,
    runtimeRole: rolePlan.runtimeRole,
    rolePlanCanonical,
    rolePlanSha256: rolePlan.planSha256,
    preProjectionCanonical,
    preProjectionSha256,
    capturedAt: "2026-08-12T10:07:00.000Z",
    migrationRoleCanApplyMigrations: true,
    runtimeRoleCanApplyMigrations: false,
    authorizesApplicationStart: false,
  });
  const preconditionSha256 = `sha256:${
    roleContract.parseCanonicalProductionRoleArtifact(preconditionCanonical)
      .sha256
  }`;
  const roleBootstrapReceiptCanonical =
    roleContract.canonicalProductionRoleJson({
      schemaVersion:
        "site-logbook.production-migration-role-bootstrap-receipt/v1",
      kind: "site-logbook-production-migration-role-bootstrap-receipt",
      sourceSha: planInput.sourceSha,
      database: planInput.database,
      migrationRole: rolePlan.migratorRole,
      runtimeRole: rolePlan.runtimeRole,
      approvalId: "approved-production-role-ceremony-20260818",
      rolePlanSha256: rolePlan.planSha256,
      preProjectionSha256,
      preconditionSha256,
      statementCount: 1,
      transactionCommitted: true,
      capturedAt: "2026-08-12T10:07:00.000Z",
      committedAt: "2026-08-12T10:07:30.000Z",
      postCommitProjectionSha256: preProjectionSha256,
      authorizesApplicationStart: false,
      authorizesDeployment: false,
    });
  const plan = createVerifiedProductionMigrationPlan(
    {
      ...planInput,
      rolePreconditionCanonical: preconditionCanonical,
      roleBootstrapReceiptCanonical,
    },
    { assertInputSignature() {}, assertPlanSignature() {} },
  );
  const activationCanonical = roleContract.canonicalProductionRoleJson({
    schemaVersion:
      roleAuthority.PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_SCHEMA,
    kind: "site-logbook-production-migration-role-ceremony-activation",
    enabled: true,
    expectedPlanSha256: rolePlan.planSha256,
    approvalId: "reviewed-role-ceremony-20260817",
    preProjectionCanonical,
    expectedPreProjectionSha256: preProjectionSha256,
    authorizesApplicationStart: false,
  });
  return { plan, activationCanonical, projection, rolePlan };
}

function fakeClient(
  fixture,
  { failStatement, failCommit, failPostCommit } = {},
) {
  const calls = [];
  let projectionCalls = 0;
  const client = {
    calls,
    released: [],
    async query(statement) {
      calls.push(statement);
      if (statement === roleContract.PRODUCTION_ROLE_PROJECTION_SQL) {
        projectionCalls += 1;
        if (failPostCommit && projectionCalls === 2) {
          throw new Error("post-commit projection unavailable");
        }
        return { rows: [{ projection: rawProjection(fixture.projection) }] };
      }
      if (statement === failStatement) throw new Error("statement failed");
      if (statement === "COMMIT" && failCommit) {
        throw new Error("commit acknowledgement lost");
      }
      return { rows: [] };
    },
    release(destroy) {
      this.released.push(destroy === true);
    },
  };
  return client;
}

async function apply(fixture, client) {
  return roleAuthority.applyProductionMigrationRoleCeremony({
    planCanonical: fixture.plan.canonical,
    activationCanonical: fixture.activationCanonical,
    advisoryLockKey: 911072468,
    connect: async () => client,
    signal: new AbortController().signal,
    now: () => new Date("2099-01-01T00:00:00.000Z"),
  });
}

test("actual source role wrapper commits once and returns independently verified post-commit evidence", async () => {
  const fixture = ceremonyFixture();
  const client = fakeClient(fixture);
  const evidence = await apply(fixture, client);
  assert.equal(client.calls[0], "BEGIN");
  assert.equal(client.calls.includes("COMMIT"), true);
  assert.equal(
    client.calls.filter(
      (statement) => statement === roleContract.PRODUCTION_ROLE_PROJECTION_SQL,
    ).length,
    2,
  );
  assert.equal(client.calls.includes("ROLLBACK"), false);
  assert.deepEqual(client.released, [false]);
  assert.equal(evidence.authorizesApplicationStart, false);
  roleAuthority.assertProductionMigrationRolePostCommit(
    {
      planCanonical: fixture.plan.canonical,
      roleTransactionReceiptCanonical: evidence.roleTransactionReceiptCanonical,
      postCommitRoleArtifactCanonical: evidence.postCommitRoleArtifactCanonical,
    },
    { signal: new AbortController().signal },
  );
});

test("actual source role wrapper rolls back pre-commit failure and classifies ambiguous/post-commit failures for manual restore", async () => {
  const rollbackFixture = ceremonyFixture();
  const rollbackClient = fakeClient(rollbackFixture, {
    failStatement: rollbackFixture.rolePlan.statements[0],
  });
  await assert.rejects(
    apply(rollbackFixture, rollbackClient),
    /statement failed/,
  );
  assert.equal(rollbackClient.calls.includes("ROLLBACK"), true);
  assert.equal(rollbackClient.calls.includes("COMMIT"), false);
  assert.deepEqual(rollbackClient.released, [true]);

  const ambiguousFixture = ceremonyFixture();
  const ambiguousClient = fakeClient(ambiguousFixture, { failCommit: true });
  await assert.rejects(
    apply(ambiguousFixture, ambiguousClient),
    (error) =>
      error.code ===
        "PRODUCTION_MIGRATION_ROLE_CEREMONY_COMMIT_OUTCOME_UNKNOWN" &&
      error.restoreRequired === true &&
      error.manualReviewRequired === true,
  );
  assert.equal(ambiguousClient.calls.includes("ROLLBACK"), false);
  assert.deepEqual(ambiguousClient.released, [true]);

  const postCommitFixture = ceremonyFixture();
  const postCommitClient = fakeClient(postCommitFixture, {
    failPostCommit: true,
  });
  await assert.rejects(
    apply(postCommitFixture, postCommitClient),
    (error) =>
      error.code ===
        "PRODUCTION_MIGRATION_ROLE_CEREMONY_POST_COMMIT_INCOMPLETE" &&
      error.restoreRequired === true &&
      error.manualReviewRequired === true,
  );
  assert.equal(postCommitClient.calls.includes("COMMIT"), true);
  assert.deepEqual(postCommitClient.released, [false]);
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  PRODUCTION_ROLE_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
  PRODUCTION_ROLE_PROJECTION_SQL,
  REQUIRED_FUNCTION_GRANTS,
  REQUIRED_SEQUENCE_GRANTS,
  REQUIRED_TABLE_GRANTS,
  ROLE_CONTRACT_MIGRATION,
  ROLE_CONTRACT_MIGRATION_SHA256,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  createOneShotProductionRoleExecutor,
  parseProductionRolePostCommitProjectionArtifact,
  validateProductionRolePlan,
  validateProductionRoleProjection,
  validateProductionRoleReceipt,
  type ProductionRoleProjection,
  type ProductionRolePlan,
  type ProjectedObject,
  type RolePlanExecutor,
} from "./production-role-separation-contract.js";

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
  name: "site_logbook_migrator",
  login: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
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
    databaseName: "site_logbook",
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
    defaultPrivileges: [
      ...(["public", "drizzle"] as const).flatMap((schema) =>
        (["table", "sequence", "function"] as const).map((kind) => ({
          schema,
          kind,
          owner: migratorRole.name,
          publicPrivileges: [],
          runtimePrivileges: [],
          otherGrants: [],
        })),
      ),
    ],
    objects: requiredObjects(),
  };
}

function cloneProjection(): ProductionRoleProjection {
  return structuredClone(validProjection());
}

function validActivation(
  plan: ProductionRolePlan,
  overrides: Record<string, unknown> = {},
) {
  const preProjectionCanonical = canonicalProductionRoleJson(validProjection());
  return {
    enabled: true as const,
    expectedPlanSha256: plan.planSha256,
    approvalId: "approval-1",
    preProjectionCanonical,
    expectedPreProjectionSha256: createHash("sha256")
      .update(preProjectionCanonical)
      .digest("hex"),
    ...overrides,
  };
}

function expectCode(projection: ProductionRoleProjection, code: string): void {
  const validation = validateProductionRoleProjection(projection);
  assert.equal(validation.ok, false);
  assert.ok(
    validation.errors.some((error) => error.code === code),
    JSON.stringify(validation.errors),
  );
}

test("manifest exactly covers committed public tables, serial sequences and functions through 0107", () => {
  const migrations = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "migrations",
  );
  const sql = readdirSync(migrations)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name <= "0107_zzzz.sql")
    .sort()
    .map((name) => readFileSync(join(migrations, name), "utf8"))
    .join("\n");

  const tableMatches = [
    ...sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\((.*?)\);/gis,
    ),
  ];
  const tables = tableMatches.map((match) => match[1]!).sort();
  const serialSequences = tableMatches.flatMap((match) => {
    const table = match[1]!;
    const body = match[2]!;
    return [
      ...body.matchAll(/^\s*"?([a-z_][a-z0-9_]*)"?\s+(?:big)?serial\b/gim),
    ].map((column) => `${table}_${column[1]!}_seq`);
  });
  const identitySequences = tableMatches
    .flatMap((match) => [
      ...match[2]!.matchAll(
        /GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\s*\(\s*sequence\s+name\s+"?([a-z_][a-z0-9_]*)"?/gi,
      ),
    ])
    .map((sequence) => sequence[1]!);
  const explicitSequences = [
    ...sql.matchAll(
      /CREATE\s+SEQUENCE\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?/gi,
    ),
  ].map((match) => match[1]!);
  const functions = [
    ...sql.matchAll(
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:"?public"?\.)?"?([a-z_][a-z0-9_]*)"?\s*\((.*?)\)\s*RETURNS/gis,
    ),
  ].map((match) => {
    const args = match[2]!
      .replace(/\s+/g, " ")
      .trim()
      .split(",")
      .filter(Boolean)
      .map((arg) => arg.trim().split(/\s+/).slice(1).join(" "))
      .join(", ");
    return `${match[1]}(${args})`;
  });

  assert.deepEqual(
    REQUIRED_TABLE_GRANTS.filter((grant) => grant.schema === "public")
      .map((grant) => grant.name)
      .sort(),
    [...new Set(tables)],
  );
  assert.deepEqual(
    REQUIRED_SEQUENCE_GRANTS.filter((grant) => grant.schema === "public")
      .map((grant) => grant.name)
      .sort(),
    [
      ...new Set([
        ...serialSequences,
        ...identitySequences,
        ...explicitSequences,
      ]),
    ].sort(),
  );
  assert.deepEqual(
    REQUIRED_FUNCTION_GRANTS.map(
      (grant) => `${grant.name}(${grant.identityArguments})`,
    ).sort(),
    [...new Set(functions)].sort(),
  );
  assert.equal(REQUIRED_TABLE_GRANTS.length, 118);
  assert.deepEqual(
    REQUIRED_SEQUENCE_GRANTS.filter((grant) => grant.schema === "drizzle"),
    [
      {
        schema: "drizzle",
        name: "__drizzle_migrations_id_seq",
        privileges: [],
      },
    ],
  );
  assert.equal(REQUIRED_SEQUENCE_GRANTS.length, 96);
  assert.equal(REQUIRED_FUNCTION_GRANTS.length, 29);
  assert.deepEqual(
    REQUIRED_SEQUENCE_GRANTS.find(
      (grant) => grant.name === "security_questions_id_seq",
    )?.privileges,
    [],
  );
  assert.deepEqual(
    REQUIRED_SEQUENCE_GRANTS.find((grant) => grant.name === "jobs_id_seq")
      ?.privileges,
    ["USAGE"],
  );
});

test("accepts the exact owner/runtime projection", () => {
  assert.deepEqual(validateProductionRoleProjection(validProjection()), {
    ok: true,
    errors: [],
  });
});

test("rejects extra top-level and nested projection fields", () => {
  expectCode(
    {
      ...cloneProjection(),
      extra: true,
    } as unknown as ProductionRoleProjection,
    "PROJECTION_SHAPE_INVALID",
  );
  const nested = cloneProjection();
  (nested.objects[0] as unknown as Record<string, unknown>).extra = true;
  expectCode(nested, "PROJECTION_SHAPE_INVALID");
});

test("rejects owner equal to runtime and every privileged runtime role flag", () => {
  const sameRole = cloneProjection();
  (sameRole as { migratorRole: typeof runtimeRole }).migratorRole = runtimeRole;
  expectCode(sameRole, "OWNER_EQUALS_RUNTIME");

  for (const flag of [
    "superuser",
    "createDatabase",
    "createRole",
    "replication",
    "bypassRls",
  ] as const) {
    const projection = cloneProjection();
    (projection.runtimeRole as { [key in typeof flag]: boolean })[flag] = true;
    expectCode(projection, "RUNTIME_ROLE_FLAG_FORBIDDEN");
  }
});

test("rejects runtime role membership and PUBLIC schema CREATE", () => {
  const membership = cloneProjection();
  (membership as unknown as { runtimeMemberOf: string[] }).runtimeMemberOf = [
    migratorRole.name,
  ];
  expectCode(membership, "RUNTIME_ROLE_MEMBERSHIP_FORBIDDEN");

  const migratorMembership = cloneProjection();
  (
    migratorMembership as unknown as { migratorMemberOf: string[] }
  ).migratorMemberOf = ["privileged_parent"];
  expectCode(migratorMembership, "MIGRATOR_ROLE_MEMBERSHIP_FORBIDDEN");

  const schemaCreate = cloneProjection();
  (schemaCreate.schemas[0]!.publicPrivileges as string[]).push("CREATE");
  expectCode(schemaCreate, "PUBLIC_SCHEMA_GRANT_MISMATCH");
});

test("rejects database DDL/temp, unsafe search paths, extra schemas and role members", () => {
  const databaseCreate = cloneProjection();
  (databaseCreate.databaseRuntimePrivileges as string[]).push("CREATE");
  expectCode(databaseCreate, "RUNTIME_DATABASE_GRANT_MISMATCH");

  const databaseTemp = cloneProjection();
  (databaseTemp.databasePublicPrivileges as string[]).push("TEMPORARY");
  expectCode(databaseTemp, "PUBLIC_DATABASE_GRANT_MISMATCH");

  const runtimeSetting = cloneProjection();
  (runtimeSetting.runtimeDatabaseSettings as string[])[0] =
    "search_path=public, pg_catalog";
  expectCode(runtimeSetting, "RUNTIME_DATABASE_SEARCH_PATH_MISMATCH");

  const functionSetting = cloneProjection();
  const functionObject = functionSetting.objects.find(
    (object) => object.kind === "function",
  )!;
  (functionObject.functionSettings as string[])[0] = "search_path=public";
  expectCode(functionSetting, "FUNCTION_SEARCH_PATH_MISMATCH");

  const extraSchema = cloneProjection();
  (extraSchema.schemas as ProductionRoleProjection["schemas"][number][]).push({
    name: "shadow",
    owner: runtimeRole.name,
    publicPrivileges: [],
    runtimePrivileges: ["USAGE", "CREATE"],
    otherGrants: [],
  });
  expectCode(extraSchema, "EXTRA_SCHEMA_PROJECTION");

  const ownerMember = cloneProjection();
  (ownerMember.migratorRoleMembers as string[]).push("legacy_admin");
  expectCode(ownerMember, "MIGRATOR_ROLE_MEMBERS_FORBIDDEN");
});

test("rejects non-dark future-object default privileges", () => {
  const projection = cloneProjection();
  (projection.defaultPrivileges[0]!.publicPrivileges as string[]).push(
    "EXECUTE",
  );
  expectCode(projection, "DEFAULT_PRIVILEGE_NOT_DARK");
});

test("rejects missing table, sequence and function grants", () => {
  for (const kind of ["table", "sequence", "function"] as const) {
    const projection = cloneProjection();
    (projection.objects as ProjectedObject[]).splice(
      projection.objects.findIndex((object) => object.kind === kind),
      1,
    );
    expectCode(projection, "REQUIRED_OBJECT_PROJECTION_MISSING");
  }
});

test("rejects audit evidence DDL privileges and other extra dangerous grants", () => {
  const audit = cloneProjection();
  const auditEvents = audit.objects.find(
    (object) => object.name === "audit_events",
  )!;
  (auditEvents.runtimePrivileges as string[]).push("TRIGGER");
  expectCode(audit, "RUNTIME_OBJECT_GRANT_MISMATCH");

  const extra = cloneProjection();
  const customers = extra.objects.find(
    (object) => object.name === "customers",
  )!;
  (customers.runtimePrivileges as string[]).push("TRUNCATE", "REFERENCES");
  expectCode(extra, "RUNTIME_OBJECT_GRANT_MISMATCH");

  const publicFunction = cloneProjection();
  const functionObject = publicFunction.objects.find(
    (object) => object.kind === "function",
  )!;
  (functionObject.publicPrivileges as string[]).push("EXECUTE");
  expectCode(publicFunction, "PUBLIC_OBJECT_GRANT_FORBIDDEN");

  const securityDefiner = cloneProjection();
  const privilegedFunction = securityDefiner.objects.find(
    (object) => object.kind === "function",
  )!;
  (privilegedFunction as { securityDefiner: boolean }).securityDefiner = true;
  expectCode(securityDefiner, "SECURITY_DEFINER_FUNCTION_FORBIDDEN");

  const thirdRole = cloneProjection();
  (
    thirdRole.objects[0]!.otherGrants as Array<{
      grantee: string;
      privileges: string[];
    }>
  ).push({ grantee: "legacy_writer", privileges: ["UPDATE"] });
  expectCode(thirdRole, "OTHER_OBJECT_GRANT_FORBIDDEN");

  const columnGrant = cloneProjection();
  (
    columnGrant.objects[0]!.columnGrants as Array<{
      column: string;
      grantee: string;
      privileges: string[];
    }>
  ).push({
    column: "id",
    grantee: runtimeRole.name,
    privileges: ["UPDATE"],
  });
  expectCode(columnGrant, "COLUMN_GRANT_FORBIDDEN");
});

test("plan is deterministic, exact-schema, credential-free and disabled by default", () => {
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  assert.equal(validateProductionRolePlan(plan), true);
  assert.deepEqual(
    plan,
    buildProductionRolePlan({
      databaseName: "site_logbook",
      runtimeRole: runtimeRole.name,
      migratorRole: migratorRole.name,
    }),
  );
  const tableGrantKeys = REQUIRED_TABLE_GRANTS.map(
    (grant) => `${grant.schema}.${grant.name}`,
  );
  assert.deepEqual(
    tableGrantKeys,
    [...tableGrantKeys].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  assert.deepEqual(tableGrantKeys.slice(0, 4), [
    "drizzle.__drizzle_migrations",
    "public.accounting_aggregate_heads",
    "public.accounting_document_versions",
    "public.accounting_export_outbox",
  ]);
  assert.equal(
    plan.planSha256,
    "1a5a298bf6d9700b2d458ebadc7957c53ca186351872a277e89436601652439c",
  );
  assert.equal(plan.executionDefault, "disabled");
  assert.doesNotMatch(
    plan.statements.join("\n"),
    /PASSWORD|CREATE ROLE|CONNECTION LIMIT/i,
  );
  assert.match(
    plan.statements.join("\n"),
    /NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS/,
  );
  assert.match(plan.statements.join("\n"), /REVOKE CREATE ON SCHEMA/);
  assert.match(
    plan.statements.join("\n"),
    /ALTER SEQUENCE "public"\."job_number_seq" OWNER TO "site_logbook_migrator"/,
  );
  assert.doesNotMatch(
    plan.statements.join("\n"),
    /ALTER SEQUENCE "public"\."jobs_id_seq" OWNER/,
  );
  assert.doesNotMatch(plan.statements.join("\n"), /^GRANT\s+ON/gm);
  assert.match(
    plan.statements.join("\n"),
    /REVOKE ALL PRIVILEGES ON DATABASE "site_logbook" FROM PUBLIC, "site_logbook_runtime"/,
  );
  assert.match(
    plan.statements.join("\n"),
    /SET search_path TO pg_catalog, public, pg_temp/,
  );
  assert.match(plan.statements.join("\n"), /pg_attribute/);
  assert.match(plan.statements.join("\n"), /pg_auth_members/);
  assert.match(PRODUCTION_ROLE_PROJECTION_SQL, /pg_auth_members/);
  assert.match(PRODUCTION_ROLE_PROJECTION_SQL, /has_database_privilege/);
  assert.match(PRODUCTION_ROLE_PROJECTION_SQL, /pg_db_role_setting/);
  assert.match(PRODUCTION_ROLE_PROJECTION_SQL, /procedure\.proconfig/);
  assert.match(PRODUCTION_ROLE_PROJECTION_SQL, /attribute\.attacl/);

  assert.deepEqual(
    REQUIRED_TABLE_GRANTS.find(
      (grant) => grant.name === "document_linking_settings",
    )?.privileges,
    ["SELECT", "INSERT", "UPDATE"],
  );
  assert.deepEqual(
    REQUIRED_TABLE_GRANTS.find(
      (grant) => grant.name === "warehouse_price_history",
    )?.privileges,
    ["SELECT", "INSERT", "UPDATE", "DELETE"],
  );

  assert.equal(validateProductionRolePlan({ ...plan, extra: true }), false);
  assert.equal(
    validateProductionRolePlan({ ...plan, planSha256: "0".repeat(64) }),
    false,
  );
  assert.equal(
    validateProductionRolePlan({
      ...plan,
      statements: plan.statements.slice(1),
    }),
    false,
  );
  assert.throws(
    () =>
      buildProductionRolePlan({
        databaseName: "site-logbook",
        runtimeRole: runtimeRole.name,
        migratorRole: migratorRole.name,
      }),
    /IDENTIFIER_INVALID/,
  );
});

class FakeExecutor implements RolePlanExecutor {
  readonly id = "hermetic-fake";
  readonly calls: string[] = [];
  projection = validProjection();
  commitError: Error | undefined;

  async begin(): Promise<void> {
    this.calls.push("begin");
  }
  async execute(statement: string): Promise<void> {
    this.calls.push(`execute:${statement}`);
  }
  async project(): Promise<ProductionRoleProjection> {
    this.calls.push("project");
    return this.projection;
  }
  async commit(): Promise<void> {
    this.calls.push("commit");
    if (this.commitError) throw this.commitError;
  }
  async rollback(): Promise<void> {
    this.calls.push("rollback");
  }
}

test("one-shot executor performs no work without exact explicit activation", async () => {
  const fake = new FakeExecutor();
  const runner = createOneShotProductionRoleExecutor(fake);
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  await assert.rejects(runner.execute(plan), /EXECUTION_DISABLED/);
  assert.deepEqual(fake.calls, []);
  await assert.rejects(
    runner.execute(plan, validActivation(plan)),
    /ALREADY_ATTEMPTED/,
  );
  assert.deepEqual(fake.calls, []);
});

test("activated fake run commits only after exact post-validation and emits valid receipt", async () => {
  const fake = new FakeExecutor();
  const runner = createOneShotProductionRoleExecutor(fake);
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const receipt = await runner.execute(plan, validActivation(plan));
  assert.equal(validateProductionRoleReceipt(receipt), true);
  assert.equal(fake.calls[0], "begin");
  assert.equal(fake.calls.at(-2), "project");
  assert.equal(fake.calls.at(-1), "commit");
  assert.equal(receipt.statementCount, plan.statements.length);
  assert.equal(receipt.authorizesDeployment, false);
  assert.equal(receipt.postCommitVerification, "unavailable");
  assert.equal(receipt.postCommitVerifierArtifact, null);
  assert.equal(
    validateProductionRoleReceipt({ ...receipt, extra: true }),
    false,
  );

  const projectionCanonical = canonicalProductionRoleJson(validProjection());
  const postCommitCanonical = canonicalProductionRoleJson({
    schemaVersion: PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
    kind: "site-logbook-production-db-role-separation-postcommit",
    planSha256: plan.planSha256,
    transactionReceiptSha256: receipt.receiptSha256,
    projection: validProjection(),
    projectionSha256: createHash("sha256")
      .update(projectionCanonical)
      .digest("hex"),
    verifierId: "independent-role-verifier",
    observedAt: new Date(Date.parse(receipt.executedAt) + 1_000).toISOString(),
    authorizesDeployment: false,
  });
  const postCommit = parseProductionRolePostCommitProjectionArtifact(
    postCommitCanonical,
    { plan, transactionReceipt: receipt },
  );
  assert.equal(postCommit.value.authorizesDeployment, false);
  assert.throws(
    () =>
      parseProductionRolePostCommitProjectionArtifact(
        canonicalProductionRoleJson({
          ...JSON.parse(postCommitCanonical),
          authorizesDeployment: true,
        }),
        { plan, transactionReceipt: receipt },
      ),
    /POST_COMMIT_ARTIFACT_INVALID/,
  );
});

test("canonical approved pre-projection is required before begin", async () => {
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const missing = new FakeExecutor();
  await assert.rejects(
    createOneShotProductionRoleExecutor(missing).execute(plan, {
      enabled: true,
      expectedPlanSha256: plan.planSha256,
      approvalId: "approval-1",
      preProjectionCanonical: "{}\n",
      expectedPreProjectionSha256: "0".repeat(64),
    }),
    /PRE_PROJECTION_INVALID|ARTIFACT/,
  );
  assert.deepEqual(missing.calls, []);

  const tampered = new FakeExecutor();
  const activation = validActivation(plan, {
    expectedPreProjectionSha256: "0".repeat(64),
  });
  await assert.rejects(
    createOneShotProductionRoleExecutor(tampered).execute(plan, activation),
    /PRE_PROJECTION_INVALID/,
  );
  assert.deepEqual(tampered.calls, []);
});

test("role artifacts reject secret material, uppercase evidence ids and oversize", () => {
  assert.throws(
    () => canonicalProductionRoleJson({ accessToken: "not-retained" }),
    /SECRET_MATERIAL/,
  );
  assert.throws(
    () => canonicalProductionRoleJson({ value: "x".repeat(512 * 1024) }),
    /ARTIFACT_TOO_LARGE/,
  );
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  const fake = new FakeExecutor();
  return assert.rejects(
    createOneShotProductionRoleExecutor(fake).execute(
      plan,
      validActivation(plan, { approvalId: "Uppercase" }),
    ),
    /EXECUTION_DISABLED/,
  );
});

test("post-projection is exactly plan-bound and rolls back before commit", async () => {
  const fake = new FakeExecutor();
  fake.projection = {
    ...validProjection(),
    databaseName: "another_database",
  };
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  await assert.rejects(
    createOneShotProductionRoleExecutor(fake).execute(
      plan,
      validActivation(plan),
    ),
    /POST_PROJECTION_BINDING_MISMATCH/,
  );
  assert.equal(fake.calls.includes("commit"), false);
  assert.equal(fake.calls.at(-1), "rollback");
});

test("commit failure is explicit outcome-unknown and never rolls back after commit starts", async () => {
  const fake = new FakeExecutor();
  fake.commitError = new Error("connection lost");
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  await assert.rejects(
    createOneShotProductionRoleExecutor(fake).execute(
      plan,
      validActivation(plan),
    ),
    /COMMIT_OUTCOME_UNKNOWN/,
  );
  assert.equal(fake.calls.at(-1), "commit");
  assert.equal(fake.calls.includes("rollback"), false);
});

test("activation and receipt evidence identifiers are bounded and canonical", async () => {
  const fake = new FakeExecutor();
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  await assert.rejects(
    createOneShotProductionRoleExecutor(fake).execute(
      plan,
      validActivation(plan, { approvalId: "x".repeat(129) }),
    ),
    /EXECUTION_DISABLED/,
  );

  const validFake = new FakeExecutor();
  const receipt = await createOneShotProductionRoleExecutor(validFake).execute(
    plan,
    validActivation(plan),
  );
  assert.equal(
    validateProductionRoleReceipt({
      ...receipt,
      executedAt: receipt.executedAt.replace("Z", "+00:00"),
    }),
    false,
  );
  assert.equal(
    validateProductionRoleReceipt({ ...receipt, authorizesDeployment: true }),
    false,
  );
});

test("activated fake run rolls back on fail-closed post-validation", async () => {
  const fake = new FakeExecutor();
  const invalid = cloneProjection();
  (invalid.objects[0]!.runtimePrivileges as string[]).push("TRIGGER");
  fake.projection = invalid;
  const plan = buildProductionRolePlan({
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  });
  await assert.rejects(
    createOneShotProductionRoleExecutor(fake).execute(
      plan,
      validActivation(plan),
    ),
    /POST_VALIDATION_FAILED/,
  );
  assert.equal(fake.calls.includes("commit"), false);
  assert.equal(fake.calls.at(-1), "rollback");
});

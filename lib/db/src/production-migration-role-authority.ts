import {
  PRODUCTION_ROLE_CONTRACT_SCHEMA,
  ROLE_CONTRACT_MIGRATION,
  ROLE_CONTRACT_MIGRATION_SHA256,
  parseCanonicalProductionRoleArtifact,
  parseProductionRolePostCommitProjectionArtifact,
  validateProductionRolePlan,
  validateProductionRoleProjection,
  validateProductionRoleReceipt,
  type ProductionRolePlan,
  type ProductionRoleProjection,
  type ProductionRoleReceipt,
} from "./production-role-separation-contract.js";

export const PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA =
  "site-logbook.production-migration-role-precondition/v1" as const;

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RAW_SHA256 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const ALLOWED_PRE_0107_PROJECTION_ERRORS = new Set([
  "OBJECT_CARDINALITY_MISMATCH",
  "REQUIRED_OBJECT_PROJECTION_MISSING",
]);

type ExactDatabaseIdentity = Readonly<{
  name: string;
  sessionUser: string;
  currentUser: string;
}>;

export type ProductionMigrationRolePrecondition = Readonly<{
  schemaVersion: typeof PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA;
  kind: "site-logbook-production-migration-role-precondition";
  sourceSha: string;
  database: ExactDatabaseIdentity;
  migrationRole: string;
  runtimeRole: string;
  rolePlanCanonical: string;
  rolePlanSha256: string;
  preProjectionCanonical: string;
  preProjectionSha256: string;
  capturedAt: string;
  migrationRoleCanApplyMigrations: true;
  runtimeRoleCanApplyMigrations: false;
  authorizesApplicationStart: false;
}>;

const PRECONDITION_KEYS = [
  "schemaVersion",
  "kind",
  "sourceSha",
  "database",
  "migrationRole",
  "runtimeRole",
  "rolePlanCanonical",
  "rolePlanSha256",
  "preProjectionCanonical",
  "preProjectionSha256",
  "capturedAt",
  "migrationRoleCanApplyMigrations",
  "runtimeRoleCanApplyMigrations",
  "authorizesApplicationStart",
] as const;
const DATABASE_KEYS = ["name", "sessionUser", "currentUser"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function exactDatabase(value: unknown): ExactDatabaseIdentity {
  if (!isRecord(value) || !hasExactKeys(value, DATABASE_KEYS)) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  for (const key of DATABASE_KEYS) {
    if (typeof value[key] !== "string" || !IDENTIFIER.test(value[key])) {
      throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
    }
  }
  if (value.sessionUser === value.currentUser) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  return Object.freeze({
    name: value.name as string,
    sessionUser: value.sessionUser as string,
    currentUser: value.currentUser as string,
  });
}

function assertProjectionShapeAndPreMigrationAuthority(
  value: unknown,
  expected: {
    database: ExactDatabaseIdentity;
    migrationRole: string;
    runtimeRole: string;
  },
): asserts value is ProductionRoleProjection {
  const validation = validateProductionRoleProjection(value);
  if (
    validation.errors.some(
      (error) => !ALLOWED_PRE_0107_PROJECTION_ERRORS.has(error.code),
    )
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRE_PROJECTION_INVALID");
  }
  const projection = value as ProductionRoleProjection;
  if (
    projection.schemaVersion !== PRODUCTION_ROLE_CONTRACT_SCHEMA ||
    projection.migration !== ROLE_CONTRACT_MIGRATION ||
    projection.migrationSha256 !== ROLE_CONTRACT_MIGRATION_SHA256 ||
    projection.databaseName !== expected.database.name ||
    projection.databaseOwner !== expected.migrationRole ||
    projection.runtimeRole.name !== expected.runtimeRole ||
    projection.runtimeRole.login !== true ||
    projection.migratorRole.name !== expected.migrationRole ||
    projection.migratorRole.login !== false ||
    expected.database.currentUser !== expected.migrationRole ||
    expected.database.sessionUser === expected.migrationRole ||
    expected.database.sessionUser === expected.runtimeRole
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRE_PROJECTION_INVALID");
  }
}

export function parseProductionMigrationRolePrecondition(
  canonical: string,
  expected: {
    sourceSha: string;
    database: ExactDatabaseIdentity;
    rolePlanSha256?: string;
  },
): Readonly<{
  value: ProductionMigrationRolePrecondition;
  canonical: string;
  sha256: string;
  preProjection: ProductionRoleProjection;
  preProjectionSha256: string;
}> {
  if (!SOURCE_SHA.test(expected.sourceSha)) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  const expectedDatabase = exactDatabase(expected.database);
  const artifact = parseCanonicalProductionRoleArtifact(
    canonical,
    "productionMigrationRolePrecondition",
  );
  if (
    !isRecord(artifact.value) ||
    !hasExactKeys(artifact.value, PRECONDITION_KEYS)
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  const value =
    artifact.value as unknown as ProductionMigrationRolePrecondition;
  const database = exactDatabase(value.database);
  const preProjection = parseCanonicalProductionRoleArtifact(
    value.preProjectionCanonical,
    "productionMigrationRolePrecondition.preProjection",
  );
  const rolePlan = parseCanonicalProductionRoleArtifact(
    value.rolePlanCanonical,
    "productionMigrationRolePrecondition.rolePlan",
  );
  if (
    value.schemaVersion !== PRODUCTION_MIGRATION_ROLE_PRECONDITION_SCHEMA ||
    value.kind !== "site-logbook-production-migration-role-precondition" ||
    value.sourceSha !== expected.sourceSha ||
    JSON.stringify(database) !== JSON.stringify(expectedDatabase) ||
    !IDENTIFIER.test(value.migrationRole) ||
    !IDENTIFIER.test(value.runtimeRole) ||
    value.migrationRole !== database.currentUser ||
    value.runtimeRole === value.migrationRole ||
    value.runtimeRole === database.sessionUser ||
    !RAW_SHA256.test(value.rolePlanSha256) ||
    !validateProductionRolePlan(rolePlan.value) ||
    value.rolePlanSha256 !==
      (rolePlan.value as ProductionRolePlan).planSha256 ||
    (rolePlan.value as ProductionRolePlan).databaseName !== database.name ||
    (rolePlan.value as ProductionRolePlan).migratorRole !==
      value.migrationRole ||
    (rolePlan.value as ProductionRolePlan).runtimeRole !== value.runtimeRole ||
    (expected.rolePlanSha256 !== undefined &&
      value.rolePlanSha256 !== expected.rolePlanSha256) ||
    value.preProjectionSha256 !== preProjection.sha256 ||
    !canonicalTimestamp(value.capturedAt) ||
    value.migrationRoleCanApplyMigrations !== true ||
    value.runtimeRoleCanApplyMigrations !== false ||
    value.authorizesApplicationStart !== false
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  assertProjectionShapeAndPreMigrationAuthority(preProjection.value, {
    database,
    migrationRole: value.migrationRole,
    runtimeRole: value.runtimeRole,
  });
  return Object.freeze({
    value: Object.freeze(value),
    canonical: artifact.canonical,
    sha256: `sha256:${artifact.sha256}`,
    preProjection: preProjection.value,
    preProjectionSha256: preProjection.sha256,
  });
}

export function assertProductionMigrationPlanRolePrecondition(
  planCanonical: string,
): ReturnType<typeof parseProductionMigrationRolePrecondition> {
  const planArtifact = parseCanonicalProductionRoleArtifact(
    planCanonical,
    "productionMigrationPlan",
  );
  if (!isRecord(planArtifact.value)) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  const plan = planArtifact.value;
  if (
    typeof plan.sourceSha !== "string" ||
    !SOURCE_SHA.test(plan.sourceSha) ||
    typeof plan.rolePreconditionCanonical !== "string" ||
    typeof plan.rolePreconditionSha256 !== "string" ||
    !SHA256.test(plan.rolePreconditionSha256)
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  const database = exactDatabase(plan.database);
  const result = parseProductionMigrationRolePrecondition(
    plan.rolePreconditionCanonical,
    { sourceSha: plan.sourceSha, database },
  );
  if (result.sha256 !== plan.rolePreconditionSha256) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_PRECONDITION_INVALID");
  }
  return result;
}

export function parseProductionMigrationPostCommitRoleAuthority(input: {
  rolePlanCanonical: string;
  roleTransactionReceiptCanonical: string;
  rolePostCommitProjectionCanonical: string;
}): ReturnType<typeof parseProductionRolePostCommitProjectionArtifact> {
  const planArtifact = parseCanonicalProductionRoleArtifact(
    input.rolePlanCanonical,
    "rolePlan",
  );
  const receiptArtifact = parseCanonicalProductionRoleArtifact(
    input.roleTransactionReceiptCanonical,
    "roleTransactionReceipt",
  );
  if (
    !validateProductionRolePlan(planArtifact.value) ||
    !validateProductionRoleReceipt(receiptArtifact.value)
  ) {
    throw new Error("PRODUCTION_MIGRATION_ROLE_POST_COMMIT_INVALID");
  }
  return parseProductionRolePostCommitProjectionArtifact(
    input.rolePostCommitProjectionCanonical,
    {
      plan: planArtifact.value as ProductionRolePlan,
      transactionReceipt: receiptArtifact.value as ProductionRoleReceipt,
    },
  );
}

export const productionMigrationRoleAuthority = Object.freeze({
  assertPrecondition({ planCanonical }: { planCanonical: string }) {
    return assertProductionMigrationPlanRolePrecondition(planCanonical);
  },
  assertPostCommit(input: {
    planCanonical: string;
    roleTransactionReceiptCanonical: string;
    postCommitRoleArtifactCanonical: string;
  }) {
    const precondition = assertProductionMigrationPlanRolePrecondition(
      input.planCanonical,
    );
    return parseProductionMigrationPostCommitRoleAuthority({
      rolePlanCanonical: precondition.value.rolePlanCanonical,
      roleTransactionReceiptCanonical: input.roleTransactionReceiptCanonical,
      rolePostCommitProjectionCanonical: input.postCommitRoleArtifactCanonical,
    });
  },
  parsePostCommit: parseProductionMigrationPostCommitRoleAuthority,
});

import {
  normalizeProductionMigrationRoleProjection,
  productionMigrationRoleAuthority,
} from "./production-migration-role-authority.js";
import {
  PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
  RoleSeparationCommitOutcomeUnknownError,
  canonicalProductionRoleJson,
  createOneShotProductionRoleExecutor,
  parseCanonicalProductionRoleArtifact,
  PRODUCTION_ROLE_PROJECTION_SQL,
  validateProductionRoleProjection,
  type ProductionRolePlan,
} from "./production-role-separation-contract.js";

export * from "./production-migration-role-authority.js";
export {
  PRODUCTION_ROLE_PROJECTION_SQL,
  canonicalProductionRoleJson,
  validateProductionRoleProjection,
  type ProductionRolePlan,
  type ProductionRoleProjection,
} from "./production-role-separation-contract.js";

export const PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_SCHEMA =
  "site-logbook.production-migration-role-ceremony-activation/v1" as const;
export const PRODUCTION_MIGRATION_ROLE_CEREMONY_EXECUTOR_ID =
  "site-logbook.production-migration.role-ceremony/v1" as const;

const ACTIVATION_KEYS = [
  "schemaVersion",
  "kind",
  "enabled",
  "expectedPlanSha256",
  "approvalId",
  "preProjectionCanonical",
  "expectedPreProjectionSha256",
  "authorizesApplicationStart",
] as const;
const BOUNDED_ID = /^[a-z0-9][a-z0-9._:/-]{0,127}$/;

type QueryResult = Readonly<{ rows?: readonly Record<string, unknown>[] }>;
type CeremonyClient = Readonly<{
  query(statement: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void;
}>;

type CeremonyInput = Readonly<{
  planCanonical: string;
  activationCanonical: string;
  advisoryLockKey: number;
  connect: () => Promise<CeremonyClient>;
  signal: AbortSignal;
  now?: () => Date;
}>;

export class ProductionMigrationRoleCeremonyError extends Error {
  readonly code: string;
  readonly restoreRequired: boolean;
  readonly manualReviewRequired: boolean;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & {
      restoreRequired?: boolean;
      manualReviewRequired?: boolean;
    },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationRoleCeremonyError";
    this.code = code;
    this.restoreRequired = options?.restoreRequired === true;
    this.manualReviewRequired = options?.manualReviewRequired === true;
  }
}

function fail(
  code: string,
  message: string,
  options?: ErrorOptions & {
    restoreRequired?: boolean;
    manualReviewRequired?: boolean;
  },
): never {
  throw new ProductionMigrationRoleCeremonyError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_CEREMONY_ABORTED",
      "Role ceremony was aborted and failed closed.",
      { cause: signal.reason },
    );
  }
}

function normalizeExactProjection(raw: unknown, plan: ProductionRolePlan) {
  const projection = normalizeProductionMigrationRoleProjection(raw, plan, {
    invalid(message): never {
      return fail("PRODUCTION_MIGRATION_ROLE_PROJECTION_INVALID", message);
    },
  });
  const validation = validateProductionRoleProjection(projection);
  if (!validation.ok) {
    const first = validation.errors[0];
    fail(
      "PRODUCTION_MIGRATION_ROLE_PROJECTION_INVALID",
      `Projection failed the source role contract at ${first.code}:${first.path}.`,
    );
  }
  return projection;
}

function parseActivation(
  canonical: string,
  precondition: ReturnType<
    typeof productionMigrationRoleAuthority.assertPrecondition
  >,
) {
  const artifact = parseCanonicalProductionRoleArtifact(
    canonical,
    "productionMigrationRoleCeremonyActivation",
  );
  if (
    !isRecord(artifact.value) ||
    !hasExactKeys(artifact.value, ACTIVATION_KEYS)
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_INVALID",
      "Role ceremony activation is not an exact source-bound artifact.",
    );
  }
  const value = artifact.value;
  if (
    value.schemaVersion !==
      PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_SCHEMA ||
    value.kind !==
      "site-logbook-production-migration-role-ceremony-activation" ||
    value.enabled !== true ||
    value.expectedPlanSha256 !== precondition.value.rolePlanSha256 ||
    typeof value.approvalId !== "string" ||
    !BOUNDED_ID.test(value.approvalId) ||
    value.preProjectionCanonical !==
      precondition.value.preProjectionCanonical ||
    value.expectedPreProjectionSha256 !== precondition.preProjectionSha256 ||
    value.authorizesApplicationStart !== false
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_CEREMONY_ACTIVATION_INVALID",
      "Role ceremony activation differs from the embedded reviewed role plan.",
    );
  }
  return Object.freeze({ artifact, value });
}

function exactInput(input: CeremonyInput): CeremonyInput {
  if (
    !isRecord(input) ||
    !hasExactKeys(input, [
      "planCanonical",
      "activationCanonical",
      "advisoryLockKey",
      "connect",
      "signal",
      "now",
    ])
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_CEREMONY_INPUT_INVALID",
      "Role ceremony input is outside the reviewed authority contract.",
    );
  }
  if (
    typeof input.planCanonical !== "string" ||
    typeof input.activationCanonical !== "string" ||
    !Number.isSafeInteger(input.advisoryLockKey) ||
    typeof input.connect !== "function" ||
    !(input.signal instanceof AbortSignal) ||
    (input.now !== undefined && typeof input.now !== "function")
  ) {
    fail(
      "PRODUCTION_MIGRATION_ROLE_CEREMONY_INPUT_INVALID",
      "Role ceremony input values are malformed.",
    );
  }
  return input;
}

export function assertProductionMigrationRolePrecondition(
  input: { planCanonical: string },
  { signal }: { signal: AbortSignal },
) {
  throwIfAborted(signal);
  return productionMigrationRoleAuthority.assertPrecondition(input);
}

export function assertProductionMigrationRolePostCommit(
  input: {
    planCanonical: string;
    roleTransactionReceiptCanonical: string;
    postCommitRoleArtifactCanonical: string;
  },
  { signal }: { signal: AbortSignal },
) {
  throwIfAborted(signal);
  return productionMigrationRoleAuthority.assertPostCommit(input);
}

export async function applyProductionMigrationRoleCeremony(
  rawInput: CeremonyInput,
) {
  const input = exactInput(rawInput);
  const { signal } = input;
  throwIfAborted(signal);
  const precondition = productionMigrationRoleAuthority.assertPrecondition({
    planCanonical: input.planCanonical,
  });
  const activation = parseActivation(input.activationCanonical, precondition);
  const rolePlanArtifact = parseCanonicalProductionRoleArtifact(
    precondition.value.rolePlanCanonical,
    "productionMigrationRolePlan",
  );
  const plan = rolePlanArtifact.value as ProductionRolePlan;
  let client: CeremonyClient | undefined;
  let commitConfirmed = false;
  try {
    client = await input.connect();
    throwIfAborted(signal);
    const roleExecutor = createOneShotProductionRoleExecutor({
      id: PRODUCTION_MIGRATION_ROLE_CEREMONY_EXECUTOR_ID,
      async begin() {
        await client!.query("BEGIN");
        await client!.query("SELECT pg_advisory_xact_lock($1::integer)", [
          input.advisoryLockKey,
        ]);
      },
      async execute(statement) {
        throwIfAborted(signal);
        await client!.query(statement);
      },
      async project({ databaseName, runtimeRole, migratorRole }) {
        throwIfAborted(signal);
        const result = await client!.query(PRODUCTION_ROLE_PROJECTION_SQL, [
          databaseName,
          runtimeRole,
          migratorRole,
        ]);
        if (result.rows?.length !== 1 || !isRecord(result.rows[0])) {
          fail(
            "PRODUCTION_MIGRATION_ROLE_PROJECTION_INVALID",
            "Projection query must return exactly one row.",
          );
        }
        return normalizeExactProjection(result.rows[0].projection, plan);
      },
      async commit() {
        await client!.query("COMMIT");
        commitConfirmed = true;
      },
      async rollback() {
        await client!.query("ROLLBACK");
      },
    });
    const receipt = await roleExecutor.execute(plan, {
      enabled: true,
      expectedPlanSha256: precondition.value.rolePlanSha256,
      approvalId: activation.value.approvalId as string,
      preProjectionCanonical: precondition.value.preProjectionCanonical,
      expectedPreProjectionSha256: precondition.preProjectionSha256,
    });
    commitConfirmed = true;
    throwIfAborted(signal);
    const postCommitResult = await client.query(
      PRODUCTION_ROLE_PROJECTION_SQL,
      [plan.databaseName, plan.runtimeRole, plan.migratorRole],
    );
    if (
      postCommitResult.rows?.length !== 1 ||
      !isRecord(postCommitResult.rows[0])
    ) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_POST_COMMIT_UNAVAILABLE",
        "Post-commit projection query must return exactly one row.",
        { restoreRequired: true, manualReviewRequired: true },
      );
    }
    const postCommitProjection = normalizeExactProjection(
      postCommitResult.rows[0].projection,
      plan,
    );
    const now = input.now ?? (() => new Date());
    const observedAt = now();
    if (
      !(observedAt instanceof Date) ||
      !Number.isFinite(observedAt.getTime())
    ) {
      fail(
        "PRODUCTION_MIGRATION_ROLE_CEREMONY_CLOCK_INVALID",
        "Role ceremony clock is invalid after commit.",
        { restoreRequired: true, manualReviewRequired: true },
      );
    }
    const receiptCanonical = canonicalProductionRoleJson(receipt);
    const postCommitArtifactCanonical = canonicalProductionRoleJson({
      schemaVersion: PRODUCTION_ROLE_POST_COMMIT_PROJECTION_SCHEMA,
      kind: "site-logbook-production-db-role-separation-postcommit",
      planSha256: plan.planSha256,
      transactionReceiptSha256: receipt.receiptSha256,
      projection: postCommitProjection,
      projectionSha256: receipt.postProjectionSha256,
      verifierId: PRODUCTION_MIGRATION_ROLE_CEREMONY_EXECUTOR_ID,
      observedAt: observedAt.toISOString(),
      authorizesDeployment: false,
    });
    productionMigrationRoleAuthority.assertPostCommit({
      planCanonical: input.planCanonical,
      roleTransactionReceiptCanonical: receiptCanonical,
      postCommitRoleArtifactCanonical: postCommitArtifactCanonical,
    });
    return Object.freeze({
      roleTransactionReceiptCanonical: receiptCanonical,
      postCommitRoleArtifactCanonical: postCommitArtifactCanonical,
      authorizesApplicationStart: false as const,
    });
  } catch (error) {
    if (
      error instanceof RoleSeparationCommitOutcomeUnknownError ||
      commitConfirmed ||
      signal.aborted
    ) {
      fail(
        error instanceof RoleSeparationCommitOutcomeUnknownError
          ? "PRODUCTION_MIGRATION_ROLE_CEREMONY_COMMIT_OUTCOME_UNKNOWN"
          : "PRODUCTION_MIGRATION_ROLE_CEREMONY_POST_COMMIT_INCOMPLETE",
        "Role ceremony may have committed; preserve evidence and perform manual restore review without blind retry.",
        {
          cause: error,
          restoreRequired: true,
          manualReviewRequired: true,
        },
      );
    }
    throw error;
  } finally {
    client?.release(signal.aborted || !commitConfirmed);
  }
}

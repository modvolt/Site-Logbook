import { createHash } from "node:crypto";

import { normalizeProductionMigrationRoleProjection } from "./production-migration-role-authority.js";
import {
  PRODUCTION_ROLE_0108_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_0108_MIGRATION,
  PRODUCTION_ROLE_0108_MIGRATION_SHA256,
  PRODUCTION_ROLE_0108_PROJECTION_SQL,
  buildProductionRole0108Plan,
  overlayProductionRole0108Projection,
  validateProductionRole0108Projection,
  type ProductionRole0108Plan,
  type ProductionRole0108Projection,
} from "./production-role-separation-0108-contract.js";
import {
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  type ProductionRolePlan,
} from "./production-role-separation-contract.js";

export const PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID =
  "site-logbook.production-migration.role-0108-authority/v1" as const;
export const PRODUCTION_MIGRATION_ROLE_0108_CONFIRMATION =
  "APPLY_EXACT_0108_INVOICE_ROLE_DELTA_AFTER_DURABLE_MIGRATION_RECEIPT" as const;
export const PRODUCTION_MIGRATION_ROLE_0108_ADVISORY_LOCK_KEY = 91070108;

const AUTHORITY_SOURCE = Object.freeze({
  authorityId: PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID,
  contractSchema: PRODUCTION_ROLE_0108_CONTRACT_SCHEMA,
  migration: PRODUCTION_ROLE_0108_MIGRATION,
  migrationSha256: PRODUCTION_ROLE_0108_MIGRATION_SHA256,
});

export const PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256 =
  `sha256:${createHash("sha256")
    .update(canonicalProductionRoleJson(AUTHORITY_SOURCE), "utf8")
    .digest("hex")}` as const;

const SOURCE_SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

type QueryResult = Readonly<{ rows?: readonly Record<string, unknown>[] }>;
type AuthorityClient = Readonly<{
  query(statement: string, values?: readonly unknown[]): Promise<QueryResult>;
  release(destroy?: boolean): void | Promise<void>;
}>;

export interface ProductionMigrationRole0108AuthorityOptions {
  readonly connect: () => Promise<AuthorityClient>;
  readonly databaseName: string;
  readonly sessionUser: string;
  readonly migratorRole: string;
  readonly runtimeRole: string;
  readonly now?: () => Date;
}

export class ProductionMigrationRole0108AuthorityError extends Error {
  readonly code: string;
  readonly commitOutcomeUnknown: boolean;
  readonly restoreRequired: boolean;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & {
      commitOutcomeUnknown?: boolean;
      restoreRequired?: boolean;
    },
  ) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionMigrationRole0108AuthorityError";
    this.code = code;
    this.commitOutcomeUnknown = options?.commitOutcomeUnknown === true;
    this.restoreRequired = options?.restoreRequired === true;
  }
}

function fail(
  code: string,
  message: string,
  options?: ErrorOptions & {
    commitOutcomeUnknown?: boolean;
    restoreRequired?: boolean;
  },
): never {
  throw new ProductionMigrationRole0108AuthorityError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("PRODUCTION_ROLE_0108_CONFIGURATION_INVALID", `${field} is invalid.`);
  }
  return value;
}

function canonicalSha256(canonical: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function exactNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("PRODUCTION_ROLE_0108_CLOCK_INVALID", "Authority clock is invalid.");
  }
  return value;
}

function normalize0108Projection(
  raw: unknown,
  basePlan: ProductionRolePlan,
): ProductionRole0108Projection {
  const base = normalizeProductionMigrationRoleProjection(raw, basePlan);
  return overlayProductionRole0108Projection(base);
}

function assertProjection(
  projection: ProductionRole0108Projection,
  phase: "pre" | "post",
): void {
  const validation = validateProductionRole0108Projection(projection, phase);
  if (!validation.ok) {
    const first = validation.errors[0];
    fail(
      "PRODUCTION_ROLE_0108_PROJECTION_INVALID",
      `${phase} projection failed at ${first?.code ?? "UNKNOWN"}:${first?.path ?? "$"}.`,
    );
  }
}

function parseMigrationReceiptCanonical(canonical: string): {
  readonly sha256: `sha256:${string}`;
  readonly value: Record<string, unknown>;
} {
  if (
    typeof canonical !== "string" ||
    Buffer.byteLength(canonical, "utf8") > 256 * 1024
  ) {
    fail(
      "PRODUCTION_ROLE_0108_MIGRATION_RECEIPT_INVALID",
      "Migration receipt is unavailable.",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(canonical);
  } catch {
    fail(
      "PRODUCTION_ROLE_0108_MIGRATION_RECEIPT_INVALID",
      "Migration receipt is not JSON.",
    );
  }
  if (!isRecord(value) || canonicalProductionRoleJson(value) !== canonical) {
    fail(
      "PRODUCTION_ROLE_0108_MIGRATION_RECEIPT_INVALID",
      "Migration receipt is not canonical source-free evidence.",
    );
  }
  const migration = isRecord(value.migration) ? value.migration : null;
  if (
    value.schemaVersion !== "site-logbook.production-invoice-0108-receipt/v1" ||
    value.kind !== "site-logbook-production-invoice-0108-receipt" ||
    value.decision !== "PASS" ||
    value.transactionCommitted !== true ||
    value.roleDeltaApplied !== false ||
    value.authorizesApplicationStart !== false ||
    migration?.tag !== PRODUCTION_ROLE_0108_MIGRATION ||
    migration?.sqlSha256 !== `sha256:${PRODUCTION_ROLE_0108_MIGRATION_SHA256}`
  ) {
    fail(
      "PRODUCTION_ROLE_0108_MIGRATION_RECEIPT_INVALID",
      "Migration receipt does not prove the exact committed 0108 transition.",
    );
  }
  return Object.freeze({ sha256: canonicalSha256(canonical), value });
}

async function release(
  client: AuthorityClient | undefined,
  destroy = false,
): Promise<void> {
  await client?.release(destroy);
}

/**
 * Source-pinned authority for the post-0108 least-privilege delta. It accepts
 * no SQL from callers: the four reviewed statements come only from the exact
 * role plan derived from the 0107 contract and the pinned 0108 migration.
 */
export function createProductionMigrationRole0108Authority(
  rawOptions: ProductionMigrationRole0108AuthorityOptions,
) {
  if (!rawOptions || typeof rawOptions.connect !== "function") {
    fail(
      "PRODUCTION_ROLE_0108_CONFIGURATION_INVALID",
      "A fixed PostgreSQL connector is required.",
    );
  }
  const databaseName = exactIdentifier(rawOptions.databaseName, "databaseName");
  const sessionUser = exactIdentifier(rawOptions.sessionUser, "sessionUser");
  const migratorRole = exactIdentifier(rawOptions.migratorRole, "migratorRole");
  const runtimeRole = exactIdentifier(rawOptions.runtimeRole, "runtimeRole");
  if (migratorRole === runtimeRole) {
    fail(
      "PRODUCTION_ROLE_0108_CONFIGURATION_INVALID",
      "Migrator and runtime roles must differ.",
    );
  }
  const now = rawOptions.now ?? (() => new Date());
  const basePlan = buildProductionRolePlan({
    databaseName,
    migratorRole,
    runtimeRole,
  });
  const deltaPlan = buildProductionRole0108Plan({
    databaseName,
    migratorRole,
    runtimeRole,
  });

  async function setAndAssertIdentity(client: AuthorityClient): Promise<void> {
    await client.query(`SET LOCAL ROLE "${migratorRole}"`);
    const result = await client.query(
      "SELECT current_database()::text AS database_name, session_user::text AS session_user, current_user::text AS current_user",
    );
    const row = result.rows?.[0];
    if (
      result.rows?.length !== 1 ||
      row?.database_name !== databaseName ||
      row?.session_user !== sessionUser ||
      row?.current_user !== migratorRole
    ) {
      fail(
        "PRODUCTION_ROLE_0108_DATABASE_IDENTITY_INVALID",
        "Connected database identity is outside the reviewed role binding.",
      );
    }
  }

  async function readProjection(
    client: AuthorityClient,
    phase: "pre" | "post",
  ): Promise<ProductionRole0108Projection> {
    const result = await client.query(PRODUCTION_ROLE_0108_PROJECTION_SQL, [
      databaseName,
      runtimeRole,
      migratorRole,
    ]);
    const raw = result.rows?.[0]?.projection;
    if (result.rows?.length !== 1 || raw === undefined) {
      fail(
        "PRODUCTION_ROLE_0108_PROJECTION_INVALID",
        "Projection query returned no exact row.",
      );
    }
    const projection = normalize0108Projection(raw, basePlan);
    assertProjection(projection, phase);
    return projection;
  }

  async function observe(
    phase: "pre" | "post",
  ): Promise<ProductionRole0108Projection> {
    let client: AuthorityClient | undefined;
    let transactionOpen = false;
    try {
      client = await rawOptions.connect();
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      transactionOpen = true;
      await setAndAssertIdentity(client);
      const projection = await readProjection(client, phase);
      await client.query("COMMIT");
      transactionOpen = false;
      return projection;
    } catch (error) {
      if (transactionOpen)
        await client?.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await release(client);
    }
  }

  return Object.freeze({
    authorityId: PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID,
    authoritySourceSha256:
      PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256,
    plan: deltaPlan,

    async assertExact0108Contract(input: {
      migration: string;
      migrationSha256: string;
      requiredPreState: string;
    }) {
      if (
        !isRecord(input) ||
        input.migration !== PRODUCTION_ROLE_0108_MIGRATION ||
        input.migrationSha256 !== PRODUCTION_ROLE_0108_MIGRATION_SHA256 ||
        input.requiredPreState !== "exact-0107-plus-0108-default-dark"
      ) {
        fail(
          "PRODUCTION_ROLE_0108_CONTRACT_INVALID",
          "Runner requested a different role delta.",
        );
      }
      const projection = await observe("pre");
      return Object.freeze({
        planSha256: `sha256:${deltaPlan.planSha256}`,
        projectionSha256: canonicalSha256(
          canonicalProductionRoleJson(projection),
        ),
      });
    },

    async applyExact0108Delta(input: {
      migrationReceiptCanonical: string;
      confirmation: string;
    }): Promise<string> {
      if (input?.confirmation !== PRODUCTION_MIGRATION_ROLE_0108_CONFIRMATION) {
        fail(
          "PRODUCTION_ROLE_0108_CONFIRMATION_REQUIRED",
          "Exact attended confirmation is required.",
        );
      }
      const migrationReceipt = parseMigrationReceiptCanonical(
        input.migrationReceiptCanonical,
      );
      let client: AuthorityClient | undefined;
      let transactionOpen = false;
      let commitStarted = false;
      let commitSucceeded = false;
      let preProjection: ProductionRole0108Projection;
      try {
        client = await rawOptions.connect();
        await client.query("BEGIN");
        transactionOpen = true;
        await client.query("SET LOCAL lock_timeout = '15s'");
        await client.query("SET LOCAL statement_timeout = '5min'");
        await setAndAssertIdentity(client);
        await client.query("SELECT pg_advisory_xact_lock($1::integer)", [
          PRODUCTION_MIGRATION_ROLE_0108_ADVISORY_LOCK_KEY,
        ]);
        preProjection = await readProjection(client, "pre");
        for (const statement of deltaPlan.statements)
          await client.query(statement);
        await readProjection(client, "post");
        commitStarted = true;
        await client.query("COMMIT");
        commitSucceeded = true;
        transactionOpen = false;
      } catch (error) {
        if (commitStarted && !commitSucceeded) {
          await release(client, true);
          client = undefined;
          fail(
            "PRODUCTION_ROLE_0108_COMMIT_OUTCOME_UNKNOWN",
            "Role-delta COMMIT outcome is ambiguous; do not retry.",
            { cause: error, commitOutcomeUnknown: true, restoreRequired: true },
          );
        }
        if (transactionOpen)
          await client?.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        await release(client);
      }

      let postProjection: ProductionRole0108Projection;
      try {
        postProjection = await observe("post");
      } catch (error) {
        fail(
          "PRODUCTION_ROLE_0108_POST_COMMIT_INVALID",
          "Committed role delta lacks exact post-commit evidence; do not retry.",
          { cause: error, restoreRequired: true },
        );
      }
      const preCanonical = canonicalProductionRoleJson(preProjection!);
      const postCanonical = canonicalProductionRoleJson(postProjection);
      const receipt = {
        schemaVersion:
          "site-logbook.production-invoice-0108-role-delta-receipt/v1",
        kind: "site-logbook-production-invoice-0108-role-delta-receipt",
        decision: "PASS",
        migration: PRODUCTION_ROLE_0108_MIGRATION,
        migrationSha256: PRODUCTION_ROLE_0108_MIGRATION_SHA256,
        migrationReceiptSha256: migrationReceipt.sha256,
        base0107PlanSha256: `sha256:${deltaPlan.base0107PlanSha256}`,
        deltaPlanSha256: `sha256:${deltaPlan.planSha256}`,
        preProjectionSha256: canonicalSha256(preCanonical),
        postProjectionSha256: canonicalSha256(postCanonical),
        authoritySourceSha256:
          PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256,
        transactionCommitted: true,
        completedAt: exactNow(now).toISOString(),
        productionTargetsTouched: true,
        authorizesApplicationStart: false,
      };
      for (const field of [
        receipt.migrationReceiptSha256,
        receipt.base0107PlanSha256,
        receipt.deltaPlanSha256,
        receipt.preProjectionSha256,
        receipt.postProjectionSha256,
        receipt.authoritySourceSha256,
      ]) {
        if (!SOURCE_SHA256.test(field)) {
          fail(
            "PRODUCTION_ROLE_0108_RECEIPT_INVALID",
            "Receipt digest is invalid.",
          );
        }
      }
      return canonicalProductionRoleJson(receipt);
    },
  });
}

export {
  PRODUCTION_ROLE_0108_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_0108_MIGRATION,
  PRODUCTION_ROLE_0108_MIGRATION_SHA256,
  PRODUCTION_ROLE_0108_PROJECTION_SQL,
  deriveProductionRole0108PostProjection,
  overlayProductionRole0108Projection,
  validateProductionRole0108Projection,
} from "./production-role-separation-0108-contract.js";
export type { ProductionRole0108Projection } from "./production-role-separation-0108-contract.js";

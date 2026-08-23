import { createHash } from "node:crypto";

import {
  PRODUCTION_ROLE_CONTRACT_SCHEMA,
  PRODUCTION_ROLE_PROJECTION_SQL,
  REQUIRED_FUNCTION_GRANTS,
  REQUIRED_SEQUENCE_GRANTS,
  REQUIRED_TABLE_GRANTS,
  ROLE_CONTRACT_MIGRATION,
  ROLE_CONTRACT_MIGRATION_SHA256,
  buildProductionRolePlan,
  canonicalProductionRoleJson,
  validateProductionRoleProjection,
  type ProductionRoleProjection,
  type ProjectedObject,
  type RoleContractError,
  type RoleContractValidation,
} from "./production-role-separation-contract.js";

export const PRODUCTION_ROLE_0108_CONTRACT_SCHEMA =
  "site-logbook.production-db-role-separation-0108/v1" as const;
export const PRODUCTION_ROLE_0108_PLAN_SCHEMA =
  "site-logbook.production-db-role-separation-0108-plan/v1" as const;
export const PRODUCTION_ROLE_0108_MIGRATION =
  "0108_invoice_source_allocations_and_advances" as const;
export const PRODUCTION_ROLE_0108_MIGRATION_SHA256 =
  "220a556f61fc9aed8c215965cd25e69b5e47d7fe171f57ecd6626fe2fd4f7814" as const;

export const PRODUCTION_ROLE_0108_REQUIRED_OBJECT_GRANTS = Object.freeze([
  Object.freeze({
    kind: "table" as const,
    schema: "public" as const,
    name: "invoice_source_allocations",
    privileges: Object.freeze(["SELECT", "INSERT", "UPDATE"] as const),
  }),
  Object.freeze({
    kind: "sequence" as const,
    schema: "public" as const,
    name: "invoice_source_allocations_id_seq",
    privileges: Object.freeze(["USAGE"] as const),
  }),
]);

export interface ProductionRole0108Projection extends Omit<
  ProductionRoleProjection,
  "schemaVersion" | "migration" | "migrationSha256"
> {
  readonly schemaVersion: typeof PRODUCTION_ROLE_0108_CONTRACT_SCHEMA;
  readonly migration: typeof PRODUCTION_ROLE_0108_MIGRATION;
  readonly migrationSha256: typeof PRODUCTION_ROLE_0108_MIGRATION_SHA256;
}

export interface ProductionRole0108Plan {
  readonly schemaVersion: typeof PRODUCTION_ROLE_0108_PLAN_SCHEMA;
  readonly executionDefault: "disabled";
  readonly migration: typeof PRODUCTION_ROLE_0108_MIGRATION;
  readonly migrationSha256: typeof PRODUCTION_ROLE_0108_MIGRATION_SHA256;
  readonly databaseName: string;
  readonly runtimeRole: string;
  readonly migratorRole: string;
  readonly base0107PlanSha256: string;
  readonly requiredPreState: "exact-0107-plus-0108-default-dark";
  readonly statements: readonly string[];
  readonly planSha256: string;
}

const objectKeys = [
  "kind",
  "schema",
  "name",
  "identityArguments",
  "owner",
  "securityDefiner",
  "functionSettings",
  "publicPrivileges",
  "runtimePrivileges",
  "otherGrants",
  "columnGrants",
] as const;

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

function canonicalPrivileges(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))].sort();
}

function sameStrings(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.some((value) => typeof value !== "string"))
    return false;
  const lhs = canonicalPrivileges(left);
  const rhs = canonicalPrivileges(right);
  return (
    lhs.length === rhs.length &&
    lhs.every((value, index) => value === rhs[index])
  );
}

function objectKey(value: unknown): string | null {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    typeof value.schema !== "string" ||
    typeof value.name !== "string"
  ) {
    return null;
  }
  return `${value.kind}:${value.schema}.${value.name}`;
}

const deltaKeys = new Set(
  PRODUCTION_ROLE_0108_REQUIRED_OBJECT_GRANTS.map(
    (grant) => `${grant.kind}:${grant.schema}.${grant.name}`,
  ),
);

function base0107Projection(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const objects = Array.isArray(value.objects)
    ? value.objects.filter((object) => {
        const key = objectKey(object);
        return key === null || !deltaKeys.has(key);
      })
    : value.objects;
  return {
    ...value,
    schemaVersion: PRODUCTION_ROLE_CONTRACT_SCHEMA,
    migration: ROLE_CONTRACT_MIGRATION,
    migrationSha256: ROLE_CONTRACT_MIGRATION_SHA256,
    objects,
  };
}

export function validateProductionRole0108Projection(
  value: unknown,
  phase: "pre" | "post" = "post",
): RoleContractValidation {
  const errors: RoleContractError[] = [];
  const add = (code: string, path: string, detail: string) =>
    errors.push({ code, path, detail });

  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        {
          code: "PROJECTION_SHAPE_INVALID",
          path: "$",
          detail: "projection must be an object",
        },
      ],
    };
  }

  if (value.schemaVersion !== PRODUCTION_ROLE_0108_CONTRACT_SCHEMA) {
    add(
      "PROJECTION_SCHEMA_MISMATCH",
      "schemaVersion",
      "projection schema is not exact 0108",
    );
  }
  if (
    value.migration !== PRODUCTION_ROLE_0108_MIGRATION ||
    value.migrationSha256 !== PRODUCTION_ROLE_0108_MIGRATION_SHA256
  ) {
    add(
      "MIGRATION_BINDING_MISMATCH",
      "migration",
      "projection is not bound to exact 0108",
    );
  }

  const baseValidation = validateProductionRoleProjection(
    base0107Projection(value),
  );
  for (const error of baseValidation.errors) {
    add(error.code, `base0107.${error.path}`, error.detail);
  }

  if (!Array.isArray(value.objects)) {
    add("PROJECTION_SHAPE_INVALID", "objects", "objects must be an array");
    return { ok: false, errors };
  }
  const migratorName = isRecord(value.migratorRole)
    ? value.migratorRole.name
    : null;

  for (const required of PRODUCTION_ROLE_0108_REQUIRED_OBJECT_GRANTS) {
    const key = `${required.kind}:${required.schema}.${required.name}`;
    const matches = value.objects.filter((object) => objectKey(object) === key);
    if (matches.length !== 1) {
      add(
        "DELTA_OBJECT_CARDINALITY_MISMATCH",
        `objects.${key}`,
        "exactly one 0108 object projection is required",
      );
      continue;
    }
    const object = matches[0];
    if (!isRecord(object) || !hasExactKeys(object, objectKeys)) {
      add(
        "DELTA_OBJECT_SHAPE_INVALID",
        `objects.${key}`,
        "0108 object projection has unexpected fields",
      );
      continue;
    }
    if (
      object.identityArguments !== "" ||
      object.securityDefiner !== false ||
      !sameStrings(object.functionSettings, [])
    ) {
      add(
        "DELTA_OBJECT_IDENTITY_INVALID",
        `objects.${key}`,
        "0108 relation identity is not exact",
      );
    }
    if (object.owner !== migratorName) {
      add(
        "DELTA_OBJECT_OWNER_MISMATCH",
        `objects.${key}.owner`,
        "migration role must own the 0108 object",
      );
    }
    if (!sameStrings(object.publicPrivileges, [])) {
      add(
        "DELTA_PUBLIC_GRANT_FORBIDDEN",
        `objects.${key}.publicPrivileges`,
        "PUBLIC must have no 0108 object privileges",
      );
    }
    const expectedRuntimePrivileges =
      phase === "pre" ? [] : required.privileges;
    if (!sameStrings(object.runtimePrivileges, expectedRuntimePrivileges)) {
      add(
        "DELTA_RUNTIME_GRANT_MISMATCH",
        `objects.${key}.runtimePrivileges`,
        `runtime privileges must be exactly ${expectedRuntimePrivileges.join(",") || "none"}`,
      );
    }
    if (!Array.isArray(object.otherGrants) || object.otherGrants.length > 0) {
      add(
        "DELTA_OTHER_GRANT_FORBIDDEN",
        `objects.${key}.otherGrants`,
        "third-party direct grants are forbidden",
      );
    }
    if (!Array.isArray(object.columnGrants) || object.columnGrants.length > 0) {
      add(
        "DELTA_COLUMN_GRANT_FORBIDDEN",
        `objects.${key}.columnGrants`,
        "column grants are forbidden",
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(`ROLE_0108_IDENTIFIER_INVALID:${value}`);
  }
  return `"${value}"`;
}

function planSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalProductionRoleJson(value), "utf8")
    .digest("hex");
}

export function buildProductionRole0108Plan(input: {
  readonly databaseName: string;
  readonly runtimeRole: string;
  readonly migratorRole: string;
}): ProductionRole0108Plan {
  quoteIdentifier(input.databaseName);
  const runtime = quoteIdentifier(input.runtimeRole);
  quoteIdentifier(input.migratorRole);
  if (input.runtimeRole === input.migratorRole) {
    throw new Error("OWNER_EQUALS_RUNTIME");
  }
  const base0107Plan = buildProductionRolePlan(input);
  const table = '"public"."invoice_source_allocations"';
  const sequence = '"public"."invoice_source_allocations_id_seq"';
  const statements = Object.freeze([
    `REVOKE ALL PRIVILEGES ON TABLE ${table} FROM PUBLIC, ${runtime}`,
    `REVOKE ALL PRIVILEGES ON SEQUENCE ${sequence} FROM PUBLIC, ${runtime}`,
    `GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ${runtime}`,
    `GRANT USAGE ON SEQUENCE ${sequence} TO ${runtime}`,
  ]);
  const body = {
    schemaVersion: PRODUCTION_ROLE_0108_PLAN_SCHEMA,
    executionDefault: "disabled" as const,
    migration: PRODUCTION_ROLE_0108_MIGRATION,
    migrationSha256: PRODUCTION_ROLE_0108_MIGRATION_SHA256,
    databaseName: input.databaseName,
    runtimeRole: input.runtimeRole,
    migratorRole: input.migratorRole,
    base0107PlanSha256: base0107Plan.planSha256,
    requiredPreState: "exact-0107-plus-0108-default-dark" as const,
    statements,
  };
  return Object.freeze({ ...body, planSha256: planSha256(body) });
}

/**
 * The existing read-only projection query already returns every public and
 * drizzle relation. The 0108 validator partitions its two new objects before
 * delegating the unchanged prefix to the exact-0107 validator.
 */
export const PRODUCTION_ROLE_0108_PROJECTION_SQL =
  PRODUCTION_ROLE_PROJECTION_SQL;

export function expectedProductionRole0108Objects(
  owner: string,
  phase: "pre" | "post" = "post",
): readonly ProjectedObject[] {
  return PRODUCTION_ROLE_0108_REQUIRED_OBJECT_GRANTS.map((grant) => ({
    kind: grant.kind,
    schema: grant.schema,
    name: grant.name,
    identityArguments: "",
    owner,
    securityDefiner: false,
    functionSettings: [],
    publicPrivileges: [],
    runtimePrivileges: phase === "pre" ? [] : [...grant.privileges],
    otherGrants: [],
    columnGrants: [],
  }));
}

export function expectedProductionRole0107Objects(
  owner: string,
): readonly ProjectedObject[] {
  return [
    ...REQUIRED_TABLE_GRANTS.map((grant) => ({
      kind: "table" as const,
      schema: grant.schema,
      name: grant.name,
      identityArguments: "",
      owner,
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
      owner,
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
      owner,
      securityDefiner: false,
      functionSettings: ["search_path=pg_catalog, public, pg_temp"],
      publicPrivileges: [],
      runtimePrivileges: [...grant.privileges],
      otherGrants: [],
      columnGrants: [],
    })),
  ];
}

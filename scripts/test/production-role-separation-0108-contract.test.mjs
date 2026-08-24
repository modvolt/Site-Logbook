import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { tsImport } =
  await import("../../lib/db/node_modules/tsx/dist/esm/api/index.mjs");
const contract = await tsImport(
  "../../lib/db/src/production-role-separation-0108-contract.ts",
  import.meta.url,
);

const runtimeRole = Object.freeze({
  name: "site_logbook_runtime",
  login: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
});
const migratorRole = Object.freeze({
  name: "site_logbook_migrator",
  login: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  bypassRls: false,
});

function exactProjection(phase = "post") {
  return {
    schemaVersion: contract.PRODUCTION_ROLE_0108_CONTRACT_SCHEMA,
    migration: contract.PRODUCTION_ROLE_0108_MIGRATION,
    migrationSha256: contract.PRODUCTION_ROLE_0108_MIGRATION_SHA256,
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
      ...["public", "drizzle"].flatMap((schema) =>
        ["table", "sequence", "function"].map((kind) => ({
          schema,
          kind,
          owner: migratorRole.name,
          publicPrivileges: [],
          runtimePrivileges: [],
          otherGrants: [],
        })),
      ),
    ],
    objects: [
      ...contract.expectedProductionRole0107Objects(migratorRole.name),
      ...contract.expectedProductionRole0108Objects(migratorRole.name, phase),
    ],
  };
}

function exactBase0107Projection() {
  const projection = exactProjection("post");
  return {
    ...projection,
    schemaVersion: "site-logbook.production-db-role-separation/v1",
    migration: "0107_canonical_audit_evidence",
    migrationSha256:
      "c90d91e2ddcfbf00419980388c2e7b0f0a573fe73925638d737966fb6604e122",
    objects: contract.expectedProductionRole0107Objects(migratorRole.name),
  };
}

test("binds the 0108 role delta to the canonical migration bytes", async () => {
  const sql = (
    await readFile(
      new URL(
        "../../lib/db/migrations/0108_invoice_source_allocations_and_advances.sql",
        import.meta.url,
      ),
      "utf8",
    )
  ).replaceAll("\r\n", "\n");
  assert.equal(
    createHash("sha256").update(sql).digest("hex"),
    contract.PRODUCTION_ROLE_0108_MIGRATION_SHA256,
  );
});

test("accepts exact default-dark pre-state and least-privilege post-state", () => {
  assert.deepEqual(
    contract.validateProductionRole0108Projection(
      exactProjection("pre"),
      "pre",
    ),
    { ok: true, errors: [] },
  );
  assert.deepEqual(
    contract.validateProductionRole0108Projection(exactProjection("post")),
    { ok: true, errors: [] },
  );
});

test("derives the exact post-0108 projection from an approved 0107 base", () => {
  const derived = contract.deriveProductionRole0108PostProjection(
    exactBase0107Projection(),
  );
  assert.deepEqual(
    contract.validateProductionRole0108Projection(derived, "post"),
    { ok: true, errors: [] },
  );
  const expected = exactProjection("post");
  expected.objects.sort((left, right) => {
    const leftKey = `${left.kind}:${left.schema}:${left.name}:${left.identityArguments}`;
    const rightKey = `${right.kind}:${right.schema}:${right.name}:${right.identityArguments}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  assert.deepEqual(derived, expected);
});

test("keeps every object outside the two pinned 0108 additions fail-closed", () => {
  const base = exactBase0107Projection();
  base.objects = [
    ...base.objects,
    {
      ...contract.expectedProductionRole0108Objects(migratorRole.name)[0],
      name: "unexpected_future_table",
    },
  ];
  assert.throws(
    () => contract.deriveProductionRole0108PostProjection(base),
    /ROLE_0108_BASE_PROJECTION_INVALID:EXTRA_OBJECT_PROJECTION/,
  );
});

test("rejects DELETE, missing sequence usage and any public or third-party grant", () => {
  const projection = structuredClone(exactProjection());
  const table = projection.objects.find(
    (object) => object.name === "invoice_source_allocations",
  );
  const sequence = projection.objects.find(
    (object) => object.name === "invoice_source_allocations_id_seq",
  );
  table.runtimePrivileges.push("DELETE");
  table.publicPrivileges.push("SELECT");
  table.otherGrants.push({
    grantee: "unexpected_role",
    privileges: ["SELECT"],
  });
  sequence.runtimePrivileges = [];
  const validation = contract.validateProductionRole0108Projection(projection);
  assert.equal(validation.ok, false);
  assert.deepEqual(
    new Set(validation.errors.map((error) => error.code)),
    new Set([
      "DELTA_RUNTIME_GRANT_MISMATCH",
      "DELTA_PUBLIC_GRANT_FORBIDDEN",
      "DELTA_OTHER_GRANT_FORBIDDEN",
    ]),
  );
});

test("builds a deterministic disabled plan without DELETE or DDL grants", () => {
  const input = {
    databaseName: "site_logbook",
    runtimeRole: runtimeRole.name,
    migratorRole: migratorRole.name,
  };
  const left = contract.buildProductionRole0108Plan(input);
  const right = contract.buildProductionRole0108Plan(input);
  assert.deepEqual(left, right);
  assert.equal(left.executionDefault, "disabled");
  assert.equal(left.requiredPreState, "exact-0107-plus-0108-default-dark");
  assert.match(
    left.statements.join("\n"),
    /GRANT SELECT, INSERT, UPDATE ON TABLE "public"\."invoice_source_allocations"/,
  );
  assert.match(
    left.statements.join("\n"),
    /GRANT USAGE ON SEQUENCE "public"\."invoice_source_allocations_id_seq"/,
  );
  assert.doesNotMatch(left.statements.join("\n"), /GRANT[^\n]*DELETE/);
  assert.doesNotMatch(
    left.statements.join("\n"),
    /GRANT[^\n]*(CREATE|ALTER|TRUNCATE|REFERENCES|TRIGGER)/,
  );
  assert.equal(left.planSha256.length, 64);
  assert.equal(left.base0107PlanSha256.length, 64);
});

test("keeps the projection query read-only and parameterized", () => {
  assert.match(contract.PRODUCTION_ROLE_0108_PROJECTION_SQL, /\$1::name/);
  assert.match(contract.PRODUCTION_ROLE_0108_PROJECTION_SQL, /\$2::name/);
  assert.match(contract.PRODUCTION_ROLE_0108_PROJECTION_SQL, /\$3::name/);
  assert.doesNotMatch(
    contract.PRODUCTION_ROLE_0108_PROJECTION_SQL,
    /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|GRANT|REVOKE)\b/i,
  );
});

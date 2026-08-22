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

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SOURCE_SHA = "a".repeat(40);
const EXECUTOR_SHA = "b".repeat(40);
const EXECUTOR_IMAGE = `ghcr.io/modvolt/site-logbook-control-plane@sha256:${"c".repeat(64)}`;
const roleContract = vi.hoisted(() => ({
  projectionSql: "SELECT fixture_full_role_projection",
}));
const authority = vi.hoisted(() => ({
  sourceSha: "a".repeat(40),
  databaseName: "site_logbook",
  runtimeRole: "site_logbook_runtime",
  migratorRole: "site_logbook_migrator",
  reject: false,
}));

vi.mock(
  "../../../scripts/production-evidence/production-migration-role-authority.js",
  () => ({
    assertProductionMigrationRolePrecondition() {
      if (authority.reject) throw new Error("fixture role authority rejected");
      return {
        value: {
          sourceSha: authority.sourceSha,
          rolePlanCanonical: `${JSON.stringify({
            databaseName: authority.databaseName,
            migratorRole: authority.migratorRole,
            runtimeRole: authority.runtimeRole,
          })}\n`,
        },
      };
    },
    assertProductionMigrationRolePostCommit() {
      if (authority.reject) throw new Error("fixture role authority rejected");
      return {
        value: {
          projection: {
            databaseName: authority.databaseName,
            runtimeRole: { name: authority.runtimeRole, login: true },
            migratorRole: { name: authority.migratorRole, login: false },
            runtimeMemberOf: [],
            databaseOtherGrants: [],
            defaultPrivileges: [
              {
                schema: "public",
                kind: "table",
                owner: authority.migratorRole,
                publicPrivileges: [],
                runtimePrivileges: [],
                otherGrants: [],
              },
            ],
            objects: [
              {
                kind: "table",
                schema: "public",
                name: "jobs",
                identityArguments: "",
                owner: authority.migratorRole,
                securityDefiner: false,
                functionSettings: [],
                publicPrivileges: [],
                runtimePrivileges: ["SELECT"],
                otherGrants: [],
                columnGrants: [],
              },
            ],
          },
        },
      };
    },
  }),
);

vi.mock(
  "../../../scripts/production-evidence/production-migration-role-bootstrap.js",
  () => ({
    normalizeProductionMigrationRoleBootstrapProjection(raw: unknown) {
      return raw;
    },
  }),
);

vi.mock("../../../lib/db/src/production-role-separation-contract.js", () => ({
  PRODUCTION_ROLE_PROJECTION_SQL: roleContract.projectionSql,
  validateProductionRoleProjection() {
    return { ok: true, errors: [] };
  },
}));

import {
  applyProductionRuntimeDbCredentialCutover,
  canonicalProductionRuntimeDbCredentialJson,
  productionRuntimeDbCredentialSha256,
  PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA,
  type ProductionRuntimeCredentialClient,
} from "../src/lib/production-runtime-db-credential-cutover";
import {
  PRODUCTION_RUNTIME_DATABASE_USER,
  validateProductionRuntimeDatabaseUrl,
} from "../src/lib/production-runtime-database";
import {
  parseProductionRuntimeDbCredentialCliArguments,
  parseProductionRuntimeCredentialAdminDatabaseUrl,
  persistProductionRuntimeDbCredentialReceipt,
  reserveProductionRuntimeDbCredentialReceipt,
} from "../src/production-runtime-db-credential-cutover";

const PASSWORD = "R".repeat(48);

function fixture(
  options: {
    pre?: Partial<Record<string, unknown>>;
    fail?: "alter" | "stored-verifier" | "commit" | "runtime-connect";
    roleProjectionDrift?: "membership" | "acl" | "default-acl";
  } = {},
) {
  const migrationPlanCanonical = canonicalProductionRuntimeDbCredentialJson({
    fixture: "migration-plan",
  });
  const roleTransactionReceiptCanonical =
    canonicalProductionRuntimeDbCredentialJson({ fixture: "role-receipt" });
  const rolePostCommitArtifactCanonical =
    canonicalProductionRuntimeDbCredentialJson({ fixture: "role-postcommit" });
  const requestCanonical = canonicalProductionRuntimeDbCredentialJson({
    schemaVersion: PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA,
    kind: "site-logbook-production-runtime-db-credential-cutover-request",
    liveSourceSha: SOURCE_SHA,
    executorSourceSha: EXECUTOR_SHA,
    executorImage: EXECUTOR_IMAGE,
    databaseName: "site_logbook",
    runtimeRole: "site_logbook_runtime",
    migratorRole: "site_logbook_migrator",
    expectedMigrationPlanSha256: productionRuntimeDbCredentialSha256(
      migrationPlanCanonical,
    ),
    expectedRoleTransactionReceiptSha256: productionRuntimeDbCredentialSha256(
      roleTransactionReceiptCanonical,
    ),
    expectedRolePostCommitArtifactSha256: productionRuntimeDbCredentialSha256(
      rolePostCommitArtifactCanonical,
    ),
    approvalId: "runtime-credential-cutover-20260818",
    advisoryLockKey: PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY,
    confirmation: PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
    authorizesDeployment: false,
  });
  const queries: Array<{ statement: string; values?: readonly unknown[] }> = [];
  const releases: Array<{ client: "admin" | "runtime"; destroy?: boolean }> =
    [];
  const pre = {
    databaseName: "site_logbook",
    sessionUser: "stavba",
    currentUser: "stavba",
    adminSuperuser: true,
    runtimeExists: true,
    runtimeLogin: true,
    runtimePrivileged: false,
    runtimeCredentialPresent: false,
    migratorExists: true,
    migratorLogin: false,
    ...options.pre,
  };
  const approvedRoleProjection = {
    databaseName: authority.databaseName,
    runtimeRole: { name: authority.runtimeRole, login: true },
    migratorRole: { name: authority.migratorRole, login: false },
    runtimeMemberOf: [] as string[],
    databaseOtherGrants: [] as Array<Record<string, unknown>>,
    defaultPrivileges: [
      {
        schema: "public",
        kind: "table",
        owner: authority.migratorRole,
        publicPrivileges: [] as string[],
        runtimePrivileges: [] as string[],
        otherGrants: [] as Array<Record<string, unknown>>,
      },
    ],
    objects: [
      {
        kind: "table",
        schema: "public",
        name: "jobs",
        identityArguments: "",
        owner: authority.migratorRole,
        securityDefiner: false,
        functionSettings: [] as string[],
        publicPrivileges: [] as string[],
        runtimePrivileges: ["SELECT"],
        otherGrants: [] as Array<Record<string, unknown>>,
        columnGrants: [] as Array<Record<string, unknown>>,
      },
    ],
  };
  if (options.roleProjectionDrift === "membership") {
    approvedRoleProjection.runtimeMemberOf = [authority.migratorRole];
  } else if (options.roleProjectionDrift === "acl") {
    approvedRoleProjection.databaseOtherGrants = [
      { grantee: "unexpected_role", privileges: ["CONNECT"] },
    ];
  } else if (options.roleProjectionDrift === "default-acl") {
    approvedRoleProjection.defaultPrivileges[0].otherGrants = [
      { grantee: "unexpected_role", privileges: ["INSERT"] },
    ];
  }
  let storedVerifier = "";
  const admin: ProductionRuntimeCredentialClient = {
    async query(statement, values) {
      queries.push({ statement, values });
      if (statement === roleContract.projectionSql) {
        return { rows: [{ projection: approvedRoleProjection }] };
      }
      if (statement.includes("adminSuperuser")) return { rows: [pre] };
      if (statement.startsWith('ALTER ROLE "site_logbook_runtime"')) {
        if (options.fail === "alter") throw new Error("fixture alter failure");
        storedVerifier =
          statement.match(/ PASSWORD '([^']+)'$/)?.[1] ?? "fixture-invalid";
        return { rows: [] };
      }
      if (statement.includes('AS "runtimeCredentialVerifier"')) {
        return {
          rows: [
            {
              runtimeCredentialVerifier:
                options.fail === "stored-verifier"
                  ? "SCRAM-SHA-256$4096:wrong"
                  : storedVerifier,
            },
          ],
        };
      }
      if (statement === "COMMIT" && options.fail === "commit") {
        throw new Error("fixture ambiguous commit");
      }
      return { rows: [] };
    },
    release(destroy) {
      releases.push({ client: "admin", destroy });
    },
  };
  const runtime: ProductionRuntimeCredentialClient = {
    async query(statement, values) {
      queries.push({ statement, values });
      return {
        rows: [
          {
            databaseName: "site_logbook",
            sessionUser: "site_logbook_runtime",
            currentUser: "site_logbook_runtime",
          },
        ],
      };
    },
    release(destroy) {
      releases.push({ client: "runtime", destroy });
    },
  };
  let clock = Date.parse("2026-08-18T10:00:00.000Z");
  let runtimeConnectInput: unknown;
  const input = {
    requestCanonical,
    migrationPlanCanonical,
    roleTransactionReceiptCanonical,
    rolePostCommitArtifactCanonical,
    embeddedSourceSha: EXECUTOR_SHA,
    executorImage: EXECUTOR_IMAGE,
    runtimePassword: PASSWORD,
    connectAdmin: vi.fn(async () => admin),
    connectRuntime: vi.fn(async (value: unknown) => {
      runtimeConnectInput = value;
      if (options.fail === "runtime-connect") {
        throw new Error("fixture runtime connection failed");
      }
      return runtime;
    }),
    signal: new AbortController().signal,
    now: () => new Date((clock += 1_000)),
  };
  return {
    input,
    queries,
    releases,
    get runtimeConnectInput() {
      return runtimeConnectInput;
    },
  };
}

beforeEach(() => {
  authority.sourceSha = SOURCE_SHA;
  authority.databaseName = "site_logbook";
  authority.runtimeRole = "site_logbook_runtime";
  authority.migratorRole = "site_logbook_migrator";
  authority.reject = false;
});

describe("production runtime database credential cutover", () => {
  it("commits a client-derived SCRAM verifier and emits only secret-free non-authorizing evidence", async () => {
    const state = fixture();
    const result = await applyProductionRuntimeDbCredentialCutover(state.input);
    const alter = state.queries.find((entry) =>
      entry.statement.startsWith('ALTER ROLE "site_logbook_runtime"'),
    );
    expect(alter?.statement).toMatch(
      /^ALTER ROLE "site_logbook_runtime" PASSWORD 'SCRAM-SHA-256\$4096:/,
    );
    expect(alter?.statement).not.toContain(PASSWORD);
    expect(alter?.values).toBeUndefined();
    expect(state.runtimeConnectInput).toEqual({
      databaseName: "site_logbook",
      databaseUser: PRODUCTION_RUNTIME_DATABASE_USER,
      password: PASSWORD,
    });
    expect(
      state.queries.find((entry) =>
        entry.statement.includes("pg_advisory_xact_lock"),
      )?.values,
    ).toEqual([PRODUCTION_MIGRATION_ADVISORY_LOCK_KEY]);
    expect(result.receiptCanonical).not.toContain(PASSWORD);
    expect(result.receiptCanonical).not.toMatch(
      /databaseUrl|connectionString|password/i,
    );
    expect(JSON.parse(result.receiptCanonical)).toMatchObject({
      decision: "PASS",
      requiresExplicitCoolifySecretTransfer: true,
      authorizesApplicationStart: false,
      authorizesDeployment: false,
      sourceBinding: {
        liveSourceSha: SOURCE_SHA,
        executorSourceSha: EXECUTOR_SHA,
        executorImage: EXECUTOR_IMAGE,
      },
      transaction: {
        cleartextCredentialSentInSql: false,
        cleartextCredentialSentAsQueryParameter: false,
      },
      verification: {
        exactScramVerifierStoredInTransaction: true,
        freshRuntimeLoginVerified: true,
        exactRuntimeIdentityVerified: true,
      },
    });
    expect(state.releases).toEqual([
      { client: "runtime", destroy: false },
      { client: "admin", destroy: false },
    ]);
  });

  it("rolls back before ALTER when the live runtime role already has a credential", async () => {
    const state = fixture({ pre: { runtimeCredentialPresent: true } });
    await expect(
      applyProductionRuntimeDbCredentialCutover(state.input),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_PRECONDITION_FAILED",
      manualReviewRequired: false,
    });
    expect(state.queries.map(({ statement }) => statement)).toContain(
      "ROLLBACK",
    );
    expect(
      state.queries.some(({ statement }) => statement.startsWith("ALTER ROLE")),
    ).toBe(false);
  });

  it.each(["membership", "acl", "default-acl"] as const)(
    "rolls back %s drift in the full live role projection before ALTER",
    async (roleProjectionDrift) => {
      const state = fixture({ roleProjectionDrift });
      await expect(
        applyProductionRuntimeDbCredentialCutover(state.input),
      ).rejects.toMatchObject({
        code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROLE_DRIFT",
      });
      const statements = state.queries.map(({ statement }) => statement);
      expect(statements.indexOf(roleContract.projectionSql)).toBeGreaterThan(
        statements.indexOf("SELECT pg_advisory_xact_lock($1::integer)"),
      );
      expect(statements).toContain("ROLLBACK");
      expect(
        statements.some((statement) => statement.startsWith("ALTER ROLE")),
      ).toBe(false);
      expect(statements).not.toContain("COMMIT");
    },
  );

  it("rolls back a known pre-commit ALTER failure", async () => {
    const state = fixture({ fail: "alter" });
    await expect(
      applyProductionRuntimeDbCredentialCutover(state.input),
    ).rejects.toThrow("fixture alter failure");
    expect(state.queries.map(({ statement }) => statement).slice(-1)).toEqual([
      "ROLLBACK",
    ]);
  });

  it("rolls back when PostgreSQL does not read back the exact derived SCRAM verifier", async () => {
    const state = fixture({ fail: "stored-verifier" });
    await expect(
      applyProductionRuntimeDbCredentialCutover(state.input),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_IN_TRANSACTION_VERIFY_FAILED",
    });
    const statements = state.queries.map(({ statement }) => statement);
    expect(statements).toContain("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
    expect(state.input.connectRuntime).not.toHaveBeenCalled();
  });

  it("never rolls back or retries when COMMIT outcome is ambiguous", async () => {
    const state = fixture({ fail: "commit" });
    await expect(
      applyProductionRuntimeDbCredentialCutover(state.input),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_COMMIT_OUTCOME_UNKNOWN",
      commitOutcomeUnknown: true,
      manualReviewRequired: true,
    });
    const statements = state.queries.map(({ statement }) => statement);
    expect(statements).toContain("COMMIT");
    expect(statements).not.toContain("ROLLBACK");
    expect(state.input.connectRuntime).not.toHaveBeenCalled();
    expect(state.releases).toEqual([{ client: "admin", destroy: true }]);
  });

  it("fails closed after commit when a fresh runtime login cannot be proven", async () => {
    const state = fixture({ fail: "runtime-connect" });
    await expect(
      applyProductionRuntimeDbCredentialCutover(state.input),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_POST_COMMIT_VERIFY_FAILED",
      manualReviewRequired: true,
    });
    expect(state.queries.map(({ statement }) => statement)).toContain("COMMIT");
    expect(state.queries.map(({ statement }) => statement)).not.toContain(
      "ROLLBACK",
    );
  });

  it("rejects a weak password or role-evidence drift before opening a DB connection", async () => {
    const weak = fixture();
    await expect(
      applyProductionRuntimeDbCredentialCutover({
        ...weak.input,
        runtimePassword: "too-short",
      }),
    ).rejects.toThrow(/PRODUCTION_RUNTIME_DATABASE_PASSWORD_INVALID/);
    expect(weak.input.connectAdmin).not.toHaveBeenCalled();

    const drift = fixture();
    await expect(
      applyProductionRuntimeDbCredentialCutover({
        ...drift.input,
        rolePostCommitArtifactCanonical:
          canonicalProductionRuntimeDbCredentialJson({ fixture: "changed" }),
      }),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_SOURCE_BINDING_INVALID",
    });
    expect(drift.input.connectAdmin).not.toHaveBeenCalled();
  });

  it("rejects swapped or aliased live-source and executor identities", async () => {
    for (const mutate of [
      (request: Record<string, unknown>) => {
        request.liveSourceSha = EXECUTOR_SHA;
        request.executorSourceSha = SOURCE_SHA;
      },
      (request: Record<string, unknown>) => {
        request.executorSourceSha = request.liveSourceSha;
      },
      (request: Record<string, unknown>) => {
        request.liveSourceSha = request.executorSourceSha;
      },
    ]) {
      const state = fixture();
      const request = JSON.parse(state.input.requestCanonical) as Record<
        string,
        unknown
      >;
      mutate(request);
      await expect(
        applyProductionRuntimeDbCredentialCutover({
          ...state.input,
          requestCanonical: canonicalProductionRuntimeDbCredentialJson(request),
        }),
      ).rejects.toThrow(/PRODUCTION_RUNTIME_DB_CREDENTIAL_/);
      expect(state.input.connectAdmin).not.toHaveBeenCalled();
    }
  });

  it("rejects an alternate positive advisory lock before opening a DB connection", async () => {
    const state = fixture();
    const request = JSON.parse(state.input.requestCanonical) as Record<
      string,
      unknown
    >;
    request.advisoryLockKey = 1;
    await expect(
      applyProductionRuntimeDbCredentialCutover({
        ...state.input,
        requestCanonical: canonicalProductionRuntimeDbCredentialJson(request),
      }),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_INVALID",
    });
    expect(state.input.connectAdmin).not.toHaveBeenCalled();
  });
});

describe("production runtime database URL contract", () => {
  it("returns only the exact runtime identity, never the credential", () => {
    const identity = validateProductionRuntimeDatabaseUrl(
      `postgres://site_logbook_runtime:${PASSWORD}@postgres:5432/site_logbook`,
      "site_logbook",
    );
    expect(identity).toEqual({
      databaseName: "site_logbook",
      databaseUser: "site_logbook_runtime",
      host: "postgres",
      port: "5432",
    });
    expect(JSON.stringify(identity)).not.toContain(PASSWORD);
  });

  it.each(["stavba", "site_logbook_migrator"])(
    "rejects non-runtime API user %s",
    (user) => {
      expect(() =>
        validateProductionRuntimeDatabaseUrl(
          `postgres://${user}:${PASSWORD}@postgres:5432/site_logbook`,
          "site_logbook",
        ),
      ).toThrow(/PRODUCTION_RUNTIME_DATABASE_USER_INVALID/);
    },
  );

  it.each([
    `postgres://site_logbook_runtime:${PASSWORD}@postgres:5432/site_logbook?user=stavba`,
    `postgres://site_logbook_runtime:${PASSWORD}@postgres:5432/site_logbook?password=admin-secret`,
    `postgres://site_logbook_runtime:${PASSWORD}@postgres:5432/site_logbook?host=other-postgres`,
    `postgres://site_logbook_runtime:${PASSWORD}@postgres:5432/site_logbook?port=6543`,
    `postgres://site_logbook_runtime:${PASSWORD}@other-postgres:5432/site_logbook`,
    `postgres://site_logbook_runtime:${PASSWORD}@postgres:5433/site_logbook`,
  ])("rejects identity override or wrong-topology URL %s", (url) => {
    expect(() =>
      validateProductionRuntimeDatabaseUrl(url, "site_logbook"),
    ).toThrow(/PRODUCTION_RUNTIME_DATABASE_URL_INVALID/);
  });
});

describe("production runtime credential CLI boundary", () => {
  const exactArgv = [
    "--request-file",
    "/evidence/request.json",
    "--migration-plan-file",
    "/evidence/plan.json",
    "--role-transaction-receipt-file",
    "/evidence/role-receipt.json",
    "--role-postcommit-file",
    "/evidence/role-postcommit.json",
    "--receipt-out",
    "/evidence/credential-receipt.json",
    "--confirm",
    PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
  ];

  it("accepts only the exact attended confirmation and non-repeated CLI fields", () => {
    expect(
      parseProductionRuntimeDbCredentialCliArguments(exactArgv),
    ).toMatchObject({
      confirm: PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
      "receipt-out": "/evidence/credential-receipt.json",
    });
    expect(() =>
      parseProductionRuntimeDbCredentialCliArguments([
        ...exactArgv.slice(0, -1),
        "almost-the-confirmation",
      ]),
    ).toThrow(/PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_ARGUMENT_INVALID/);
    expect(() =>
      parseProductionRuntimeDbCredentialCliArguments([
        ...exactArgv,
        "--confirm",
        PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
      ]),
    ).toThrow(/PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_ARGUMENT_INVALID/);
  });

  it.each([
    `postgres://stavba:${PASSWORD}@postgres:5432/site_logbook?user=site_logbook_runtime`,
    `postgres://stavba:${PASSWORD}@postgres:5432/site_logbook?password=override`,
    `postgres://stavba:${PASSWORD}@postgres:5432/site_logbook?host=other-postgres`,
    `postgres://stavba:${PASSWORD}@postgres:5432/site_logbook?port=6543`,
    `postgres://stavba:${PASSWORD}@other-postgres:5432/site_logbook`,
    `postgres://stavba:${PASSWORD}@postgres:5433/site_logbook`,
  ])("rejects an admin identity override or wrong topology %s", (url) => {
    expect(() =>
      parseProductionRuntimeCredentialAdminDatabaseUrl(url, "site_logbook"),
    ).toThrow(/PRODUCTION_RUNTIME_DB_CREDENTIAL_ADMIN_URL_INVALID/);
  });

  it("source-orders durable no-clobber reservation before the DB ceremony", () => {
    const source = readFileSync(
      new URL(
        "../src/production-runtime-db-credential-cutover.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const reserveAt = source.indexOf(
      "const reservation = await reserveProductionRuntimeDbCredentialReceipt",
    );
    const applyAt = source.indexOf(
      "result = await applyProductionRuntimeDbCredentialCutover",
    );
    expect(reserveAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(reserveAt);
  });

  it("reserves and finalizes the exact same no-clobber inode with digest readback", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "site-logbook-runtime-credential-reserve-"),
    );
    try {
      const output = path.join(directory, "receipt.json");
      const canonical = canonicalProductionRuntimeDbCredentialJson({
        decision: "PASS",
        authorizesDeployment: false,
      });
      const reservation =
        await reserveProductionRuntimeDbCredentialReceipt(output);
      const reserved = await lstat(output, { bigint: true });
      expect(reserved.size).toBe(0n);
      expect(reserved.dev).toBe(reservation.dev);
      expect(reserved.ino).toBe(reservation.ino);

      const published = await reservation.finalize(canonical);
      const final = await lstat(output, { bigint: true });
      expect(final.dev).toBe(reservation.dev);
      expect(final.ino).toBe(reservation.ino);
      expect(await readFile(output, "utf8")).toBe(canonical);
      expect(published.sha256).toBe(
        productionRuntimeDbCredentialSha256(canonical),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("retains an incomplete reservation marker and never replaces peer evidence", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "site-logbook-runtime-credential-incomplete-"),
    );
    try {
      const output = path.join(directory, "receipt.json");
      const reservation =
        await reserveProductionRuntimeDbCredentialReceipt(output);
      await reservation.closeIncomplete();
      const marker = await lstat(output, { bigint: true });
      expect(marker.dev).toBe(reservation.dev);
      expect(marker.ino).toBe(reservation.ino);
      expect(marker.size).toBe(0n);
      await expect(
        reserveProductionRuntimeDbCredentialReceipt(output),
      ).rejects.toMatchObject({
        code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_EXISTS",
      });
      expect((await lstat(output, { bigint: true })).ino).toBe(marker.ino);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("persists canonical receipt bytes exclusively and never overwrites evidence", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "site-logbook-runtime-credential-"),
    );
    try {
      const output = path.join(directory, "receipt.json");
      const canonical = canonicalProductionRuntimeDbCredentialJson({
        decision: "PASS",
        authorizesDeployment: false,
      });
      await expect(
        persistProductionRuntimeDbCredentialReceipt(output, canonical),
      ).resolves.toBe(output);
      expect(await readFile(output, "utf8")).toBe(canonical);
      const stat = await lstat(output, { bigint: true });
      expect(stat.isFile()).toBe(true);
      expect(stat.nlink).toBe(1n);
      if (process.platform !== "win32") {
        expect(Number(stat.mode & 0o777n)).toBe(0o600);
      }
      await expect(
        persistProductionRuntimeDbCredentialReceipt(
          output,
          canonicalProductionRuntimeDbCredentialJson({ decision: "CHANGED" }),
        ),
      ).rejects.toMatchObject({
        code: "PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_EXISTS",
      });
      expect(await readFile(output, "utf8")).toBe(canonical);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("production Compose runtime credential boundary", () => {
  const compose = readFileSync(
    new URL("../../../docker-compose.yml", import.meta.url),
    "utf8",
  );
  const envExample = readFileSync(
    new URL("../../../.env.example", import.meta.url),
    "utf8",
  );
  const apiDockerfile = readFileSync(
    new URL("../Dockerfile", import.meta.url),
    "utf8",
  );
  const runbook = readFileSync(
    new URL(
      "../../../docs/audit/22-production-runtime-db-credential-cutover.md",
      import.meta.url,
    ),
    "utf8",
  );
  const apiEnvironment = compose.slice(
    compose.indexOf("  api:"),
    compose.indexOf("  web:"),
  );

  it("keeps PostgreSQL init/admin credentials out of the API service", () => {
    expect(apiEnvironment).toContain(
      "DATABASE_URL: postgres://site_logbook_runtime:${PRODUCTION_RUNTIME_DATABASE_PASSWORD:?set the separate runtime database secret}@postgres:5432/${POSTGRES_DB}",
    );
    expect(apiEnvironment).toContain(
      "PRODUCTION_EXPECTED_DATABASE_USER: site_logbook_runtime",
    );
    expect(apiEnvironment).not.toContain("${POSTGRES_USER}");
    expect(apiEnvironment).not.toContain("${POSTGRES_PASSWORD}");
    expect(compose).toMatch(/POSTGRES_USER: \$\{POSTGRES_USER\}/);
    expect(compose).toMatch(/POSTGRES_PASSWORD: \$\{POSTGRES_PASSWORD\}/);
  });

  it("declares the separate runtime secret without a checked-in value", () => {
    expect(envExample).toMatch(/^PRODUCTION_RUNTIME_DATABASE_PASSWORD=$/m);
    expect(envExample).not.toMatch(
      /^PRODUCTION_RUNTIME_DATABASE_PASSWORD=.+$/m,
    );
  });

  it("source-pins the non-root control-plane uid used by attended evidence custody", () => {
    expect(apiDockerfile).toContain('test "$(id -u node)" = "1000"');
    expect(apiDockerfile).toContain('test "$(id -g node)" = "1000"');
    expect(apiDockerfile).toMatch(
      /FROM runtime AS control-plane[\s\S]*USER node/,
    );
    expect(runbook).toContain("--user 1000:1000");
    expect(runbook).toContain("chown 1000:1000");
    expect(runbook).toContain("chmod 0700");
    expect(runbook).toContain("install -m 0600 -o 1000 -g 1000");
    expect(runbook).toContain("do not solve a permission error");
  });

  it("forbids resolved Compose output that would expose the runtime secret", () => {
    expect(runbook).toContain("explicitly mark it **secret** in Coolify");
    expect(runbook).toContain("do **not** run or");
    expect(runbook).toContain("docker compose config");
    expect(runbook).toContain("docker inspect");
  });
});

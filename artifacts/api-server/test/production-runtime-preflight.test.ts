import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProductionRuntimePreflightError,
  projectProductionRuntimeHealth,
  resetProductionRuntimePreflightForTest,
  runAfterProductionRuntimePreflight,
  verifyProductionRuntimePreflight,
  type RuntimePreflightClient,
} from "../src/lib/production-runtime-preflight";

const BUILD_SHA = "a".repeat(40);
const REQUIRED_COLUMNS = [
  ["billing_settings", "advance_number_prefix"],
  ["billing_settings", "advance_number_format"],
  ["billing_settings", "advance_number_year"],
  ["billing_settings", "advance_number_next_seq"],
  ["invoice_lines", "row_type"],
  ["invoices", "document_type"],
  ["invoices", "customer_delivery_address"],
  ["invoices", "bank_account"],
  ["invoices", "iban"],
  ["invoices", "bic"],
] as const;

function productionEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    SITE_LOGBOOK_RUNTIME_ENVIRONMENT: "production",
    DATABASE_URL:
      "postgresql://site_logbook_runtime:runtime-password@postgres:5432/site_logbook",
    PRODUCTION_EXPECTED_DATABASE_USER: "site_logbook_runtime",
    ...overrides,
  };
}

function clientFixture(
  options: {
    connectError?: Error;
    missingObject?: boolean;
    missingColumn?: string;
    insufficientPrivileges?: boolean;
    superuser?: boolean;
  } = {},
) {
  const queries: string[] = [];
  let ended = false;
  const client: RuntimePreflightClient = {
    async connect() {
      if (options.connectError) throw options.connectError;
    },
    async query<Row extends object>(queryText: string) {
      queries.push(queryText);
      let rows: unknown[] = [];
      if (queryText.includes("current_database() AS database_name")) {
        rows = [
          {
            database_name: "site_logbook",
            current_user_name: "site_logbook_runtime",
            session_user_name: "site_logbook_runtime",
            is_superuser: options.superuser ?? false,
            can_create_role: false,
            can_create_database: false,
            can_replicate: false,
            bypasses_rls: false,
            member_of_migrator: false,
          },
        ];
      } else if (queryText.includes("to_regclass")) {
        rows = [
          {
            allocation_table: options.missingObject
              ? null
              : "invoice_source_allocations",
            allocation_sequence: "invoice_source_allocations_id_seq",
          },
        ];
      } else if (queryText.includes("information_schema.columns")) {
        rows = REQUIRED_COLUMNS.filter(
          ([table, column]) => `${table}.${column}` !== options.missingColumn,
        ).map(([table_name, column_name]) => ({ table_name, column_name }));
      } else if (queryText.includes("has_table_privilege")) {
        const allowed = !options.insufficientPrivileges;
        rows = [
          {
            allocation_select: allowed,
            allocation_insert: allowed,
            allocation_update: allowed,
            allocation_sequence_usage: allowed,
            settings_select: allowed,
            settings_update: allowed,
            invoice_lines_select: allowed,
            invoice_lines_insert: allowed,
            invoice_lines_update: allowed,
            invoices_select: allowed,
            invoices_insert: allowed,
            invoices_update: allowed,
          },
        ];
      }
      return { rows: rows as Row[] };
    },
    async end() {
      ended = true;
    },
  };
  return {
    client,
    queries,
    ended: () => ended,
    factory: () => client,
  };
}

beforeEach(() => resetProductionRuntimePreflightForTest());
afterEach(() => {
  resetProductionRuntimePreflightForTest();
  vi.restoreAllMocks();
});

describe("production runtime live 0108 preflight", () => {
  it("starts without an activation bundle and ignores invalid historical activation evidence", async () => {
    const fixture = clientFixture();
    const startRuntime = vi.fn(() => "started");
    const result = await runAfterProductionRuntimePreflight(
      productionEnv({
        PRODUCTION_ACTIVATION_BUNDLE: "invalid-historical-evidence",
        PRODUCTION_ACTIVATION_APPROVAL_EVIDENCE_B64: "missing",
      }),
      BUILD_SHA,
      startRuntime,
      { clientFactory: fixture.factory },
    );

    expect(result).toBe("started");
    expect(startRuntime).toHaveBeenCalledOnce();
    expect(fixture.queries).toContain("SELECT 1 AS readiness");
    expect(fixture.queries[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(fixture.queries.at(-1)).toBe("ROLLBACK");
    expect(fixture.ended()).toBe(true);
  });

  it("keeps the runtime locked when the database is unavailable", async () => {
    const fixture = clientFixture({
      connectError: new Error("connection refused"),
    });
    const startRuntime = vi.fn();
    await expect(
      runAfterProductionRuntimePreflight(
        productionEnv(),
        BUILD_SHA,
        startRuntime,
        { clientFactory: fixture.factory },
      ),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_PREFLIGHT_DATABASE_UNAVAILABLE",
      component: "database",
    });
    expect(startRuntime).not.toHaveBeenCalled();
    expect(fixture.ended()).toBe(true);
  });

  it("rejects a missing post-0108 object or column", async () => {
    const missingObject = clientFixture({ missingObject: true });
    await expect(
      verifyProductionRuntimePreflight(productionEnv(), BUILD_SHA, {
        clientFactory: missingObject.factory,
      }),
    ).rejects.toMatchObject({ component: "schema" });

    const missingColumn = clientFixture({
      missingColumn: "invoices.document_type",
    });
    await expect(
      verifyProductionRuntimePreflight(productionEnv(), BUILD_SHA, {
        clientFactory: missingColumn.factory,
      }),
    ).rejects.toMatchObject({ component: "schema" });
  });

  it("rejects a privileged or insufficient runtime role", async () => {
    const superuser = clientFixture({ superuser: true });
    await expect(
      verifyProductionRuntimePreflight(productionEnv(), BUILD_SHA, {
        clientFactory: superuser.factory,
      }),
    ).rejects.toBeInstanceOf(ProductionRuntimePreflightError);

    const insufficient = clientFixture({ insufficientPrivileges: true });
    await expect(
      verifyProductionRuntimePreflight(productionEnv(), BUILD_SHA, {
        clientFactory: insufficient.factory,
      }),
    ).rejects.toMatchObject({
      code: "PRODUCTION_RUNTIME_PREFLIGHT_ROLE_PRIVILEGES_INSUFFICIENT",
      component: "runtimeRole",
    });
  });

  it("does not let a backup warning block an otherwise ready API", async () => {
    const fixture = clientFixture();
    const ready = await verifyProductionRuntimePreflight(
      productionEnv(),
      BUILD_SHA,
      { clientFactory: fixture.factory },
    );
    const health = projectProductionRuntimeHealth(ready, "warning");

    expect(health).toMatchObject({
      httpStatus: 200,
      status: "ok",
      database: "ok",
      schema: "0108",
      runtimeRole: "ok",
      activationEvidence: "ignored-for-runtime",
      backup: { status: "warning", blocking: false },
    });
  });

  it("starts background work only after the live preflight succeeds", async () => {
    const unavailable = clientFixture({
      connectError: new Error("connection refused"),
    });
    const startWorkers = vi.fn();
    await expect(
      runAfterProductionRuntimePreflight(
        productionEnv(),
        BUILD_SHA,
        startWorkers,
        { clientFactory: unavailable.factory },
      ),
    ).rejects.toBeInstanceOf(ProductionRuntimePreflightError);
    expect(startWorkers).not.toHaveBeenCalled();

    resetProductionRuntimePreflightForTest();
    const ready = clientFixture();
    await runAfterProductionRuntimePreflight(
      productionEnv(),
      BUILD_SHA,
      startWorkers,
      { clientFactory: ready.factory },
    );
    expect(startWorkers).toHaveBeenCalledOnce();
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");

describe("isolated workflow DB suite runner", () => {
  const runner = read("lib/db/src/test-workflow-db-suite.ts");

  it("is explicit opt-in and refuses production or unconfirmed remote DBs", () => {
    expect(runner).toContain('WORKFLOW_DB_SUITE_ENABLED !== "true"');
    expect(runner).toContain('process.env.NODE_ENV === "production"');
    expect(runner).toContain('ALLOW_REMOTE_ISOLATED_DB_TEST !== "true"');
    expect(runner).toContain("test_workflow_suite_");
  });

  it("runs only the workflow DB tests against the generated URL", () => {
    expect(runner).toContain('"test/job-create-atomic-db.test.ts"');
    expect(runner).toContain('"test/job-status-db.test.ts"');
    expect(runner).toContain('"test/quote-job-group-invoice-db.test.ts"');
    expect(runner).toContain('DATABASE_URL: testDbUrl');
    expect(runner).toContain(
      'SESSION_SECRET: "workflow-db-suite-test-only-session-secret"',
    );
    expect(runner).toContain('ATOMIC_JOB_DB_TEST_ENABLED: "true"');
    expect(runner).toContain('JOB_STATUS_DB_TEST_ENABLED: "true"');
    expect(runner).toContain('NODE_ENV: "test"');
    expect(runner).toContain('"--maxWorkers=1"');
    expect(runner).toContain('"--no-file-parallelism"');
    expect(runner).not.toContain("DATABASE_URL: sourceUrl");
    expect(runner).not.toContain("runMigrations(sourceUrl");
  });

  it("migrates, verifies parity and always removes only the generated DB", () => {
    const guardAt = runner.indexOf("let databaseCreated = false");
    const outerTryAt = runner.indexOf("try {", guardAt);
    const createClientAt = runner.indexOf("const adminClient", guardAt);
    const cleanupAt = runner.indexOf("if (databaseCreated)", createClientAt);

    expect(runner).toContain("runMigrations(testDbUrl)");
    expect(runner).toContain("migration.appliedAfter !== migration.expectedCount");
    expect(outerTryAt).toBeGreaterThan(guardAt);
    expect(outerTryAt).toBeLessThan(createClientAt);
    expect(cleanupAt).toBeGreaterThan(createClientAt);
    expect(runner).toContain("Failed to close create connection");
    expect(runner).toContain("Failed to close cleanup connection");
    expect(runner).toContain("WHERE datname = $1");
    expect(runner).toContain("[testDbName]");
    expect(runner).toContain('DROP DATABASE IF EXISTS "${testDbName}"');
  });

  it("exposes the runner through the DB package", () => {
    const packageJson = JSON.parse(read("lib/db/package.json")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["test:workflow-db"]).toContain(
      "test-workflow-db-suite.ts",
    );
  });
});

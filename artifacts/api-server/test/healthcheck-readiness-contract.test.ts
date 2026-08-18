import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("container healthcheck contract", () => {
  it("keeps the public readiness probe independent of live S3 diagnostics", () => {
    const source = readFileSync(
      resolve(root, "artifacts/api-server/src/routes/health.ts"),
      "utf8",
    );
    const start = source.indexOf('router.get("/healthz"');
    const adminPath = source.indexOf('"/admin/health"', start);
    const end = source.lastIndexOf("router.get(", adminPath);
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(adminPath).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(start);
    expect(handler).toContain("checkDbLatency()");
    expect(handler).toContain("getCachedMigrationParity()");
    expect(handler).not.toContain("checkStorage()");
    expect(handler).not.toContain("diagnoseS3()");

    const dbProbe = handler.indexOf("await checkDbLatency()");
    const dbShortCircuit = handler.indexOf(
      'if (dbPing.status === "error")',
    );
    const secondaryDiagnostics = handler.indexOf("await Promise.all([");
    expect(dbProbe).toBeGreaterThanOrEqual(0);
    expect(dbShortCircuit).toBeGreaterThan(dbProbe);
    expect(secondaryDiagnostics).toBeGreaterThan(dbShortCircuit);
  });
});

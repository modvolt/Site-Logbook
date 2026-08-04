import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("R15-A operational snapshot contract", () => {
  it("keeps the endpoint authenticated, permission-scoped and free of active provider probes", () => {
    const healthRoute = source("artifacts/api-server/src/routes/health.ts");
    const start = healthRoute.indexOf('"/admin/health/operational"');
    const end = healthRoute.indexOf('"/admin/health/watchdog"', start);
    const route = healthRoute.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(route).toContain("requireAuth");
    expect(route).toContain('requirePermission("diagnostics.view")');
    expect(route).toContain("collectOperationalSnapshot");
    expect(route).not.toMatch(/diagnoseS3|checkStorage|resolveEmailConfig|sendMail|fetch\(/);
  });

  it("publishes only aggregate operational fields in OpenAPI", () => {
    const spec = source("lib/api-spec/openapi.yaml");
    const start = spec.indexOf("    OperationalSnapshot:");
    const end = spec.indexOf("    HealthLogEntry:", start);
    const schema = spec.slice(start, end);

    expect(spec).toContain("/admin/health/operational:");
    expect(schema).toContain("OperationalQueueSignal");
    expect(schema).toContain("OperationalBackupSignal");
    expect(schema).toContain("OperationalSecuritySignal");
    expect(schema).toContain("OperationalAlert");
    expect(schema).not.toMatch(
      /password|secret|recipient|emailAddress|objectPath|fileName|actorName|sessionId|ipAddress|userAgent/i,
    );
  });

  it("assigns unique stable advisory lock keys to watchdog work", () => {
    const scheduler = source("artifacts/api-server/src/lib/scheduler-lock.ts");
    const objectStart = scheduler.indexOf("export const SCHEDULER_LOCK_KEYS = {");
    const objectEnd = scheduler.indexOf("} as const", objectStart);
    const entries = [...scheduler.slice(objectStart, objectEnd).matchAll(/\w+:\s+([\d_]+)/g)].map(
      (match) => Number(match[1].replaceAll("_", "")),
    );

    expect(entries.length).toBeGreaterThanOrEqual(8);
    expect(new Set(entries).size).toBe(entries.length);
    expect(scheduler).toContain("healthWatchdog: 1_007");
    expect(scheduler).toContain("healthWatchdogPurge: 1_008");
  });

  it("marks unavailable DB-backed aggregates unknown instead of returning false zero health", () => {
    const signals = source("artifacts/api-server/src/lib/operational-signals.ts");
    const policy = source("artifacts/api-server/src/lib/operational-alert-policy.ts");

    expect(signals).toContain("available: false");
    expect(policy).toContain('? "unknown"');
    expect(policy).toContain("hasUnavailableMetric");
  });
});

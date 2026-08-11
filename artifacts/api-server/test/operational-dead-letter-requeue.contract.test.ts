import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");

function source(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("R15-D dead-letter operator recovery contract", () => {
  it("exposes only single-row authenticated diagnostics.manage routes", () => {
    const health = source("artifacts/api-server/src/routes/health.ts");
    const start = health.indexOf(
      '"/admin/health/operational-alert-outbox/dead-letters"',
    );
    const end = health.indexOf('"/admin/health/log"', start);
    const routes = health.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(routes.match(/requireAuth/g)).toHaveLength(2);
    expect(
      routes.match(/requirePermission\("diagnostics\.manage"\)/g),
    ).toHaveLength(2);
    expect(routes).toContain(
      '"/admin/health/operational-alert-outbox/:id/requeue"',
    );
    expect(routes).not.toMatch(/bulk|requeue-all|requeueAll/);
    expect(routes).toContain("Number.isSafeInteger(params.data.id)");
    expect(routes).toContain("hasExactRequeueBodyKeys(req.body)");
    expect(routes).not.toMatch(/sendOperational|deliverOperational|fetch\(/);
  });

  it("publishes a closed redacted OpenAPI contract with optimistic preconditions", () => {
    const spec = source("lib/api-spec/openapi.yaml");
    const pathStart = spec.indexOf(
      "  /admin/health/operational-alert-outbox/dead-letters:",
    );
    const pathEnd = spec.indexOf("  /admin/health/log:", pathStart);
    const schemaStart = spec.indexOf(
      "    OperationalAlertDeadLetterRequeueInput:",
    );
    const schemaEnd = spec.indexOf("    OperationalAlert:", schemaStart);
    const paths = spec.slice(pathStart, pathEnd);
    const schemas = spec.slice(schemaStart, schemaEnd);

    expect(pathStart).toBeGreaterThan(0);
    expect(paths).toContain(
      "/admin/health/operational-alert-outbox/{id}/requeue:",
    );
    expect(paths).toContain("bulk requeue is intentionally absent");
    expect(schemas).toContain("additionalProperties: false");
    expect(schemas).toContain("expectedAttemptCount");
    expect(schemas).toContain("expectedDeadLetteredAt");
    expect(schemas).toContain("receiver_configuration_corrected");
    expect(schemas).not.toMatch(
      /eventKey|fingerprint|payload|recipient|identity|owner|runbook|metric|observed|threshold|objectPath|secret/i,
    );
  });

  it("locks, compares, requeues and audits in one transaction without delivering", () => {
    const store = source(
      "artifacts/api-server/src/lib/operational-incident-store.ts",
    );
    const start = store.indexOf(
      "export async function requeueOperationalAlertDeadLetter",
    );
    const end = store.indexOf(
      "export interface OperationalAlertDeliverySummary",
      start,
    );
    const requeue = store.slice(start, end);

    expect(start).toBeGreaterThan(0);
    expect(requeue).toContain("db.transaction");
    expect(requeue).toContain("for update");
    expect(requeue).toContain('current.state !== "dead_letter"');
    expect(requeue).toContain(
      "current.attemptCount !== input.expectedAttemptCount",
    );
    expect(requeue).toContain(
      "current.deadLetteredAt !== input.expectedDeadLetteredAt",
    );
    expect(requeue).toContain('state: "pending"');
    expect(requeue).toContain("attemptCount: 0");
    expect(requeue).toContain("tx.insert(auditLogTable)");
    expect(requeue).toContain(
      'action: "operational_alert.dead_letter.requeued"',
    );
    expect(requeue).not.toMatch(
      /deliverOperational|markOperationalAlertDelivered|fetch\(/,
    );
  });

  it("uses the global durable idempotency gate before the router", () => {
    const app = source("artifacts/api-server/src/app.ts");
    const idempotency = source(
      "artifacts/api-server/src/middlewares/offline-idempotency.ts",
    );
    const gate = app.indexOf('app.use("/api", enforceDurableIdempotency)');
    const router = app.indexOf('app.use("/api", router)');

    expect(gate).toBeGreaterThan(0);
    expect(router).toBeGreaterThan(gate);
    expect(idempotency).toContain(
      "`${req.auth.userId}:${ledgerScope}:${method}:${path}:${idempotencyKey}`",
    );
    expect(idempotency).toContain('code: "idempotency_key_required"');
    expect(idempotency).toContain('code: "idempotency_key_reused"');
  });

  it("skips only the exact requeue route in generic audit middleware", () => {
    const audit = source("artifacts/api-server/src/middlewares/audit.ts");

    expect(audit).toContain(
      "/^\\/admin\\/health\\/operational-alert-outbox\\/\\d+\\/requeue$/",
    );
    expect(audit).toContain(
      "SKIP_PATTERNS.some((pattern) => pattern.test(relPath))",
    );
  });
});

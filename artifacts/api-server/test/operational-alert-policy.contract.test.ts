import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPERATIONAL_THRESHOLDS,
  OperationalAlertTracker,
  evaluateOperationalMetrics,
  loadOperationalThresholds,
  type OperationalMetrics,
  type OperationalQueueId,
} from "../src/lib/operational-alert-policy";

function healthyMetrics(): OperationalMetrics {
  return {
    generatedAt: "2026-08-04T00:00:00.000Z",
    providers: [
      { id: "database", state: "ok", required: true },
      { id: "storage", state: "ok", required: true },
      { id: "smtp", state: "not_configured", required: false },
    ],
    queues: (["extraction", "switchboard", "email_import"] as const).map((id) => ({
      id,
      available: true,
      readyDepth: 0,
      runningDepth: 0,
      failedDepth: 0,
      oldestReadyAgeSeconds: null,
    })),
    backup: {
      available: true,
      enabled: false,
      lastSuccessAt: null,
      lastSuccessAgeSeconds: null,
      lastAttemptStatus: null,
      lastRestoreTestAt: null,
      lastRestoreTestAgeSeconds: null,
      lastRestoreStatus: null,
    },
    security: {
      available: true,
      windowSeconds: 900,
      sensitiveEventCount: 0,
    },
  };
}

function staleQueue(id: OperationalQueueId): OperationalMetrics {
  const metrics = healthyMetrics();
  const queue = metrics.queues.find((candidate) => candidate.id === id)!;
  queue.readyDepth = 1;
  queue.oldestReadyAgeSeconds = DEFAULT_OPERATIONAL_THRESHOLDS.queueCriticalAgeSeconds;
  return metrics;
}

describe("operational alert policy", () => {
  it.each(["extraction", "switchboard", "email_import"] as const)(
    "turns a simulated stale %s queue into an actionable critical alert",
    (id) => {
      const snapshot = evaluateOperationalMetrics(staleQueue(id));
      const alert = snapshot.activeAlerts.find((candidate) => candidate.code === `queue.${id}.stale`);

      expect(snapshot.status).toBe("critical");
      expect(alert).toMatchObject({
        fingerprint: `queue.${id}.stale`,
        severity: "critical",
        metric: "oldest_ready_age_seconds",
      });
      expect(alert?.owner.length).toBeGreaterThan(0);
      expect(alert?.runbook).toContain("docs/runbooks/operational-alerts.md#fronty");
      expect(alert?.threshold).toBe(DEFAULT_OPERATIONAL_THRESHOLDS.queueCriticalAgeSeconds);
    },
  );

  it("escalates failed queue depth without exposing raw worker errors", () => {
    const metrics = healthyMetrics();
    metrics.queues[0].failedDepth = DEFAULT_OPERATIONAL_THRESHOLDS.failedDepthCritical;

    const snapshot = evaluateOperationalMetrics(metrics);
    const alert = snapshot.activeAlerts.find((candidate) => candidate.code === "queue.extraction.failed");

    expect(alert?.severity).toBe("critical");
    expect(JSON.stringify(alert)).not.toMatch(/lastError|errorMessage|documentId|objectPath/);
  });

  it("covers stale backups, failed restore tests and sensitive-event bursts", () => {
    const metrics = healthyMetrics();
    metrics.backup = {
      available: true,
      enabled: true,
      lastSuccessAt: "2026-07-30T00:00:00.000Z",
      lastSuccessAgeSeconds: DEFAULT_OPERATIONAL_THRESHOLDS.backupCriticalAgeSeconds,
      lastAttemptStatus: "failed",
      lastRestoreTestAt: "2026-07-20T00:00:00.000Z",
      lastRestoreTestAgeSeconds: DEFAULT_OPERATIONAL_THRESHOLDS.restoreCriticalAgeSeconds,
      lastRestoreStatus: "failed",
    };
    metrics.security.sensitiveEventCount =
      DEFAULT_OPERATIONAL_THRESHOLDS.securityCriticalEvents;

    const codes = evaluateOperationalMetrics(metrics).activeAlerts.map((alert) => alert.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "backup.success.stale",
        "backup.attempt.failed",
        "backup.restore.failed",
        "security.sensitive_events.burst",
      ]),
    );
  });

  it("alerts for failed required providers and ignores optional unconfigured providers", () => {
    const metrics = healthyMetrics();
    metrics.providers = [
      { id: "database", state: "error", required: true },
      { id: "storage", state: "ok", required: true },
      { id: "smtp", state: "not_configured", required: false },
    ];

    const snapshot = evaluateOperationalMetrics(metrics);
    expect(snapshot.activeAlerts).toEqual([
      expect.objectContaining({
        code: "provider.database.unhealthy",
        severity: "critical",
      }),
    ]);
  });

  it("reports unavailable DB-backed metrics as unknown rather than inventing healthy values", () => {
    const metrics = healthyMetrics();
    metrics.providers[0].state = "unknown";
    metrics.queues.forEach((queue) => {
      queue.available = false;
    });
    metrics.backup.available = false;
    metrics.security.available = false;

    const snapshot = evaluateOperationalMetrics(metrics);
    expect(snapshot.status).toBe("unknown");
    expect(snapshot.queues.every((queue) => queue.status === "unknown")).toBe(true);
    expect(snapshot.backup.status).toBe("unknown");
    expect(snapshot.security.status).toBe("unknown");
    expect(snapshot.activeAlerts).toEqual([]);
  });

  it("normalizes invalid or inverted environment thresholds", () => {
    const thresholds = loadOperationalThresholds({
      OPERATIONAL_QUEUE_WARNING_AGE_MINUTES: "60",
      OPERATIONAL_QUEUE_CRITICAL_AGE_MINUTES: "5",
      OPERATIONAL_FAILED_DEPTH_CRITICAL: "not-a-number",
      OPERATIONAL_SECURITY_WARNING_EVENTS_15M: "30",
      OPERATIONAL_SECURITY_CRITICAL_EVENTS_15M: "20",
    });

    expect(thresholds.queueCriticalAgeSeconds).toBeGreaterThan(
      thresholds.queueWarningAgeSeconds,
    );
    expect(thresholds.failedDepthCritical).toBe(5);
    expect(thresholds.securityCriticalEvents).toBe(31);
  });
});

describe("operational alert transition tracker", () => {
  it("deduplicates unchanged alerts, emits escalation and emits one recovery", () => {
    const warning = {
      fingerprint: "queue.extraction.stale",
      code: "queue.extraction.stale",
      severity: "warning" as const,
      owner: "Backend / doklady",
      runbook: "docs/runbooks/operational-alerts.md#fronty",
      summary: "Fronta je opožděná.",
      metric: "oldest_ready_age_seconds",
      observed: 900,
      threshold: 900,
    };
    const critical = { ...warning, severity: "critical" as const, observed: 3_600 };
    const tracker = new OperationalAlertTracker();

    expect(tracker.update([warning], "2026-08-04T00:00:00.000Z")).toEqual([
      expect.objectContaining({ kind: "triggered", alert: warning }),
    ]);
    expect(tracker.update([{ ...warning, observed: 1_200 }], "2026-08-04T00:05:00.000Z")).toEqual([]);
    expect(tracker.update([critical], "2026-08-04T00:10:00.000Z")).toEqual([
      expect.objectContaining({ kind: "escalated", alert: critical }),
    ]);
    expect(tracker.update([warning], "2026-08-04T00:15:00.000Z")).toEqual([
      expect.objectContaining({ kind: "deescalated", alert: warning }),
    ]);
    expect(tracker.update([], "2026-08-04T00:20:00.000Z")).toEqual([
      expect.objectContaining({ kind: "recovered", alert: warning }),
    ]);
    expect(tracker.update([], "2026-08-04T00:25:00.000Z")).toEqual([]);
  });
});

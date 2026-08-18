export type OperationalSeverity = "warning" | "critical";
export type OperationalStatus = "ok" | OperationalSeverity | "unknown" | "not_configured";
export type OperationalQueueId = "extraction" | "switchboard" | "email_import";
export type OperationalProviderId =
  | "database"
  | "storage"
  | "smtp"
  | "gmail"
  | "imap"
  | "ai";

export interface OperationalQueueMetric {
  id: OperationalQueueId;
  available: boolean;
  readyDepth: number;
  runningDepth: number;
  failedDepth: number;
  oldestReadyAgeSeconds: number | null;
}

export interface OperationalBackupMetric {
  available: boolean;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastSuccessAgeSeconds: number | null;
  lastAttemptStatus: string | null;
  lastRestoreTestAt: string | null;
  lastRestoreTestAgeSeconds: number | null;
  lastRestoreStatus: string | null;
}

export interface OperationalSecurityMetric {
  available: boolean;
  windowSeconds: number;
  sensitiveEventCount: number;
}

export interface OperationalProviderMetric {
  id: OperationalProviderId;
  state: "ok" | "error" | "degraded" | "not_configured" | "unknown";
  required: boolean;
}

export interface OperationalMetrics {
  generatedAt: string;
  queues: OperationalQueueMetric[];
  backup: OperationalBackupMetric;
  security: OperationalSecurityMetric;
  providers: OperationalProviderMetric[];
}

export interface OperationalThresholds {
  queueWarningAgeSeconds: number;
  queueCriticalAgeSeconds: number;
  failedDepthCritical: number;
  backupWarningAgeSeconds: number;
  backupCriticalAgeSeconds: number;
  restoreWarningAgeSeconds: number;
  restoreCriticalAgeSeconds: number;
  securityWarningEvents: number;
  securityCriticalEvents: number;
}

export interface OperationalAlert {
  fingerprint: string;
  code: string;
  severity: OperationalSeverity;
  owner: string;
  runbook: string;
  summary: string;
  metric: string;
  observed: number | null;
  threshold: number | null;
}

export interface EvaluatedOperationalQueue extends OperationalQueueMetric {
  status: Exclude<OperationalStatus, "not_configured">;
  warningAgeSeconds: number;
  criticalAgeSeconds: number;
}

export interface EvaluatedOperationalBackup extends OperationalBackupMetric {
  status: OperationalStatus;
  warningAgeSeconds: number;
  criticalAgeSeconds: number;
  restoreWarningAgeSeconds: number;
  restoreCriticalAgeSeconds: number;
}

export interface EvaluatedOperationalSecurity extends OperationalSecurityMetric {
  status: Exclude<OperationalStatus, "not_configured">;
  warningEvents: number;
  criticalEvents: number;
}

export interface OperationalSnapshot {
  generatedAt: string;
  status: Exclude<OperationalStatus, "not_configured">;
  alertTransport: "local_log_only" | "local_log_and_https_webhook";
  queues: EvaluatedOperationalQueue[];
  backup: EvaluatedOperationalBackup;
  security: EvaluatedOperationalSecurity;
  activeAlerts: OperationalAlert[];
}

const RUNBOOK = "docs/runbooks/operational-alerts.md";
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_OPERATIONAL_THRESHOLDS: OperationalThresholds = {
  queueWarningAgeSeconds: 15 * MINUTE,
  queueCriticalAgeSeconds: 60 * MINUTE,
  failedDepthCritical: 5,
  backupWarningAgeSeconds: 26 * HOUR,
  backupCriticalAgeSeconds: 48 * HOUR,
  restoreWarningAgeSeconds: 8 * DAY,
  restoreCriticalAgeSeconds: 14 * DAY,
  securityWarningEvents: 10,
  securityCriticalEvents: 25,
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadOperationalThresholds(
  env: NodeJS.ProcessEnv = process.env,
): OperationalThresholds {
  const queueWarningAgeSeconds =
    positiveInteger(env.OPERATIONAL_QUEUE_WARNING_AGE_MINUTES, 15) * MINUTE;
  const queueCriticalCandidate =
    positiveInteger(env.OPERATIONAL_QUEUE_CRITICAL_AGE_MINUTES, 60) * MINUTE;
  const backupWarningAgeSeconds =
    positiveInteger(env.OPERATIONAL_BACKUP_WARNING_AGE_HOURS, 26) * HOUR;
  const backupCriticalCandidate =
    positiveInteger(env.OPERATIONAL_BACKUP_CRITICAL_AGE_HOURS, 48) * HOUR;
  const restoreWarningAgeSeconds =
    positiveInteger(env.OPERATIONAL_RESTORE_WARNING_AGE_DAYS, 8) * DAY;
  const restoreCriticalCandidate =
    positiveInteger(env.OPERATIONAL_RESTORE_CRITICAL_AGE_DAYS, 14) * DAY;
  const securityWarningEvents = positiveInteger(
    env.OPERATIONAL_SECURITY_WARNING_EVENTS_15M,
    10,
  );
  const securityCriticalCandidate = positiveInteger(
    env.OPERATIONAL_SECURITY_CRITICAL_EVENTS_15M,
    25,
  );

  return {
    queueWarningAgeSeconds,
    queueCriticalAgeSeconds: Math.max(
      queueCriticalCandidate,
      queueWarningAgeSeconds + MINUTE,
    ),
    failedDepthCritical: positiveInteger(env.OPERATIONAL_FAILED_DEPTH_CRITICAL, 5),
    backupWarningAgeSeconds,
    backupCriticalAgeSeconds: Math.max(
      backupCriticalCandidate,
      backupWarningAgeSeconds + HOUR,
    ),
    restoreWarningAgeSeconds,
    restoreCriticalAgeSeconds: Math.max(
      restoreCriticalCandidate,
      restoreWarningAgeSeconds + DAY,
    ),
    securityWarningEvents,
    securityCriticalEvents: Math.max(
      securityCriticalCandidate,
      securityWarningEvents + 1,
    ),
  };
}

function severityForValue(
  observed: number,
  warningThreshold: number,
  criticalThreshold: number,
): OperationalSeverity | null {
  if (observed >= criticalThreshold) return "critical";
  if (observed >= warningThreshold) return "warning";
  return null;
}

function highestStatus(
  alerts: OperationalAlert[],
  prefix: string,
): Exclude<OperationalStatus, "not_configured"> {
  const relevant = alerts.filter((alert) => alert.code.startsWith(prefix));
  if (relevant.some((alert) => alert.severity === "critical")) return "critical";
  if (relevant.some((alert) => alert.severity === "warning")) return "warning";
  return "ok";
}

function queueLabel(id: OperationalQueueId): string {
  switch (id) {
    case "extraction":
      return "extrakce přijatých dokladů";
    case "switchboard":
      return "zpracování rozvaděčů";
    case "email_import":
      return "e-mailového importu";
  }
}

function queueOwner(id: OperationalQueueId): string {
  return id === "switchboard" ? "Backend / rozvaděče" : "Backend / doklady";
}

function evaluateQueue(
  queue: OperationalQueueMetric,
  thresholds: OperationalThresholds,
): OperationalAlert[] {
  if (!queue.available) return [];
  const alerts: OperationalAlert[] = [];
  const age = queue.oldestReadyAgeSeconds;
  if (queue.readyDepth > 0 && age !== null) {
    const severity = severityForValue(
      age,
      thresholds.queueWarningAgeSeconds,
      thresholds.queueCriticalAgeSeconds,
    );
    if (severity) {
      alerts.push({
        fingerprint: `queue.${queue.id}.stale`,
        code: `queue.${queue.id}.stale`,
        severity,
        owner: queueOwner(queue.id),
        runbook: `${RUNBOOK}#fronty`,
        summary: `Nejstarší úloha ve frontě ${queueLabel(queue.id)} překročila časový limit.`,
        metric: "oldest_ready_age_seconds",
        observed: age,
        threshold:
          severity === "critical"
            ? thresholds.queueCriticalAgeSeconds
            : thresholds.queueWarningAgeSeconds,
      });
    }
  }

  if (queue.failedDepth > 0) {
    const severity =
      queue.failedDepth >= thresholds.failedDepthCritical ? "critical" : "warning";
    alerts.push({
      fingerprint: `queue.${queue.id}.failed`,
      code: `queue.${queue.id}.failed`,
      severity,
      owner: queueOwner(queue.id),
      runbook: `${RUNBOOK}#fronty`,
      summary: `Fronta ${queueLabel(queue.id)} obsahuje nevyřešené trvalé chyby.`,
      metric: "failed_depth",
      observed: queue.failedDepth,
      threshold: severity === "critical" ? thresholds.failedDepthCritical : 1,
    });
  }
  return alerts;
}

function evaluateBackup(
  backup: OperationalBackupMetric,
  thresholds: OperationalThresholds,
): OperationalAlert[] {
  if (!backup.available) return [];
  if (!backup.enabled) return [];
  const alerts: OperationalAlert[] = [];

  if (backup.lastSuccessAgeSeconds === null) {
    alerts.push({
      fingerprint: "backup.success.missing",
      code: "backup.success.missing",
      severity: "critical",
      owner: "DevOps / databáze",
      runbook: `${RUNBOOK}#zalohy-a-obnova`,
      summary: "Automatické zálohy jsou zapnuté, ale neexistuje úspěšná záloha.",
      metric: "last_success_age_seconds",
      observed: null,
      threshold: thresholds.backupCriticalAgeSeconds,
    });
  } else {
    const severity = severityForValue(
      backup.lastSuccessAgeSeconds,
      thresholds.backupWarningAgeSeconds,
      thresholds.backupCriticalAgeSeconds,
    );
    if (severity) {
      alerts.push({
        fingerprint: "backup.success.stale",
        code: "backup.success.stale",
        severity,
        owner: "DevOps / databáze",
        runbook: `${RUNBOOK}#zalohy-a-obnova`,
        summary: "Poslední úspěšná záloha je starší než provozní limit.",
        metric: "last_success_age_seconds",
        observed: backup.lastSuccessAgeSeconds,
        threshold:
          severity === "critical"
            ? thresholds.backupCriticalAgeSeconds
            : thresholds.backupWarningAgeSeconds,
      });
    }
  }

  if (backup.lastAttemptStatus === "failed") {
    alerts.push({
      fingerprint: "backup.attempt.failed",
      code: "backup.attempt.failed",
      severity: "warning",
      owner: "DevOps / databáze",
      runbook: `${RUNBOOK}#zalohy-a-obnova`,
      summary: "Poslední pokus o zálohu selhal.",
      metric: "last_attempt_failed",
      observed: 1,
      threshold: 1,
    });
  }

  if (backup.lastRestoreStatus === "failed") {
    alerts.push({
      fingerprint: "backup.restore.failed",
      code: "backup.restore.failed",
      severity: "critical",
      owner: "DevOps / databáze",
      runbook: `${RUNBOOK}#zalohy-a-obnova`,
      summary: "Poslední ověřovací obnova zálohy selhala.",
      metric: "last_restore_failed",
      observed: 1,
      threshold: 1,
    });
  } else if (backup.lastRestoreTestAgeSeconds === null) {
    alerts.push({
      fingerprint: "backup.restore.missing",
      code: "backup.restore.missing",
      severity: "warning",
      owner: "DevOps / databáze",
      runbook: `${RUNBOOK}#zalohy-a-obnova`,
      summary: "Zatím není evidována úspěšná ověřovací obnova zálohy.",
      metric: "last_restore_age_seconds",
      observed: null,
      threshold: thresholds.restoreWarningAgeSeconds,
    });
  } else {
    const severity = severityForValue(
      backup.lastRestoreTestAgeSeconds,
      thresholds.restoreWarningAgeSeconds,
      thresholds.restoreCriticalAgeSeconds,
    );
    if (severity) {
      alerts.push({
        fingerprint: "backup.restore.stale",
        code: "backup.restore.stale",
        severity,
        owner: "DevOps / databáze",
        runbook: `${RUNBOOK}#zalohy-a-obnova`,
        summary: "Ověřovací obnova zálohy je starší než provozní limit.",
        metric: "last_restore_age_seconds",
        observed: backup.lastRestoreTestAgeSeconds,
        threshold:
          severity === "critical"
            ? thresholds.restoreCriticalAgeSeconds
            : thresholds.restoreWarningAgeSeconds,
      });
    }
  }
  return alerts;
}

function evaluateSecurity(
  security: OperationalSecurityMetric,
  thresholds: OperationalThresholds,
): OperationalAlert[] {
  if (!security.available) return [];
  const severity = severityForValue(
    security.sensitiveEventCount,
    thresholds.securityWarningEvents,
    thresholds.securityCriticalEvents,
  );
  if (!severity) return [];
  return [
    {
      fingerprint: "security.sensitive_events.burst",
      code: "security.sensitive_events.burst",
      severity,
      owner: "Bezpečnost / administrace",
      runbook: `${RUNBOOK}#bezpecnostni-udalosti`,
      summary: "Počet změn rolí, oprávnění, přihlašovacích údajů nebo session překročil limit.",
      metric: "sensitive_events_15m",
      observed: security.sensitiveEventCount,
      threshold:
        severity === "critical"
          ? thresholds.securityCriticalEvents
          : thresholds.securityWarningEvents,
    },
  ];
}

function evaluateProviders(providers: OperationalProviderMetric[]): OperationalAlert[] {
  return providers.flatMap((provider): OperationalAlert[] => {
    if (!provider.required || provider.state === "ok") return [];
    if (provider.state === "not_configured") {
      return [
        {
          fingerprint: `provider.${provider.id}.not_configured`,
          code: `provider.${provider.id}.not_configured`,
          severity: "critical",
          owner: "DevOps / integrace",
          runbook: `${RUNBOOK}#poskytovatele`,
          summary: `Povinný provider ${provider.id} není nakonfigurován.`,
          metric: "provider_state",
          observed: null,
          threshold: null,
        },
      ];
    }
    if (provider.state === "unknown") return [];
    return [
      {
        fingerprint: `provider.${provider.id}.unhealthy`,
        code: `provider.${provider.id}.unhealthy`,
        severity: provider.state === "error" ? "critical" : "warning",
        owner: "DevOps / integrace",
        runbook: `${RUNBOOK}#poskytovatele`,
        summary: `Povinný provider ${provider.id} hlásí provozní problém.`,
        metric: "provider_state",
        observed: provider.state === "error" ? 0 : 1,
        threshold: 1,
      },
    ];
  });
}

export function evaluateOperationalMetrics(
  metrics: OperationalMetrics,
  thresholds: OperationalThresholds = loadOperationalThresholds(),
  alertTransport: OperationalSnapshot["alertTransport"] = "local_log_only",
): OperationalSnapshot {
  const queueAlerts = metrics.queues.flatMap((queue) => evaluateQueue(queue, thresholds));
  const backupAlerts = evaluateBackup(metrics.backup, thresholds);
  const securityAlerts = evaluateSecurity(metrics.security, thresholds);
  const providerAlerts = evaluateProviders(metrics.providers);
  const activeAlerts = [...providerAlerts, ...queueAlerts, ...backupAlerts, ...securityAlerts].sort(
    (a, b) => {
      if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
      return a.code.localeCompare(b.code);
    },
  );
  const hasUnknownProvider = metrics.providers.some(
    (provider) => provider.required && provider.state === "unknown",
  );
  const hasUnavailableMetric =
    metrics.queues.some((queue) => !queue.available) ||
    !metrics.backup.available ||
    !metrics.security.available;

  return {
    generatedAt: metrics.generatedAt,
    status: activeAlerts.some((alert) => alert.severity === "critical")
      ? "critical"
      : activeAlerts.some((alert) => alert.severity === "warning")
        ? "warning"
        : hasUnknownProvider || hasUnavailableMetric
          ? "unknown"
          : "ok",
    alertTransport,
    queues: metrics.queues.map((queue) => ({
      ...queue,
      status: queue.available
        ? highestStatus(activeAlerts, `queue.${queue.id}.`)
        : "unknown",
      warningAgeSeconds: thresholds.queueWarningAgeSeconds,
      criticalAgeSeconds: thresholds.queueCriticalAgeSeconds,
    })),
    backup: {
      ...metrics.backup,
      status: !metrics.backup.available
        ? "unknown"
        : metrics.backup.enabled
          ? highestStatus(activeAlerts, "backup.")
          : "not_configured",
      warningAgeSeconds: thresholds.backupWarningAgeSeconds,
      criticalAgeSeconds: thresholds.backupCriticalAgeSeconds,
      restoreWarningAgeSeconds: thresholds.restoreWarningAgeSeconds,
      restoreCriticalAgeSeconds: thresholds.restoreCriticalAgeSeconds,
    },
    security: {
      ...metrics.security,
      status: metrics.security.available
        ? highestStatus(activeAlerts, "security.")
        : "unknown",
      warningEvents: thresholds.securityWarningEvents,
      criticalEvents: thresholds.securityCriticalEvents,
    },
    activeAlerts,
  };
}

export interface OperationalAlertTransition {
  kind: "triggered" | "escalated" | "deescalated" | "recovered";
  observedAt: string;
  alert: OperationalAlert;
}

export class OperationalAlertTracker {
  private readonly active = new Map<string, OperationalAlert>();

  update(alerts: OperationalAlert[], observedAt: string): OperationalAlertTransition[] {
    const next = new Map(alerts.map((alert) => [alert.fingerprint, alert]));
    const transitions: OperationalAlertTransition[] = [];

    for (const alert of alerts) {
      const previous = this.active.get(alert.fingerprint);
      if (!previous) {
        transitions.push({ kind: "triggered", observedAt, alert });
      } else if (previous.severity !== alert.severity) {
        transitions.push({
          kind: alert.severity === "critical" ? "escalated" : "deescalated",
          observedAt,
          alert,
        });
      }
    }
    for (const [fingerprint, alert] of this.active) {
      if (!next.has(fingerprint)) {
        transitions.push({ kind: "recovered", observedAt, alert });
      }
    }

    this.active.clear();
    for (const [fingerprint, alert] of next) this.active.set(fingerprint, alert);
    return transitions;
  }
}

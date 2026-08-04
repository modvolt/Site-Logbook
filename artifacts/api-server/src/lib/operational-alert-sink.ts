import { logger } from "./logger";
import type { OperationalAlertTransition } from "./operational-alert-policy";

/**
 * R15-A deliberately has no network transport. The local structured event is
 * redacted and stable so the platform log collector can index it without
 * receiving provider secrets, recipients, object paths or raw worker errors.
 */
export function emitLocalOperationalAlertTransitions(
  transitions: OperationalAlertTransition[],
): void {
  for (const transition of transitions) {
    const data = {
      event: "operational_alert_transition",
      kind: transition.kind,
      observedAt: transition.observedAt,
      fingerprint: transition.alert.fingerprint,
      code: transition.alert.code,
      severity: transition.alert.severity,
      owner: transition.alert.owner,
      runbook: transition.alert.runbook,
      metric: transition.alert.metric,
      observed: transition.alert.observed,
      threshold: transition.alert.threshold,
      transport: "local_log_only",
    } as const;

    if (transition.kind === "recovered" || transition.kind === "deescalated") {
      logger.info(
        data,
        transition.kind === "recovered"
          ? "Operational alert recovered"
          : "Operational alert severity decreased",
      );
    } else if (transition.alert.severity === "critical") {
      logger.error(data, "Operational alert active");
    } else {
      logger.warn(data, "Operational alert active");
    }
  }
}

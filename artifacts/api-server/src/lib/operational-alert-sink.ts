import { logger } from "./logger";
import type { OperationalAlertTransition } from "./operational-alert-policy";
import type { OperationalAlertTransportMode } from "./operational-alert-transport";

/**
 * The local structured event remains the always-on fallback. It is redacted
 * and stable so the platform log collector can index it without receiving
 * provider secrets, recipients, object paths or raw worker errors.
 */
export function emitLocalOperationalAlertTransitions(
  transitions: OperationalAlertTransition[],
  transport: OperationalAlertTransportMode = "local_log_only",
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
      transport,
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

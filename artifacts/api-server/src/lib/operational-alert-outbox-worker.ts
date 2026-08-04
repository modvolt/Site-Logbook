import { logger } from "./logger";
import {
  deliverOperationalAlertTransitionDurably,
  getOperationalAlertTransportMode,
} from "./operational-alert-transport";
import {
  claimOperationalAlert,
  markOperationalAlertDelivered,
  markOperationalAlertFailed,
} from "./operational-incident-store";

const POLL_INTERVAL_MS = 15_000;
const MAX_PER_TICK = 16;
let started = false;
let timer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;

export async function drainOperationalAlertOutbox(): Promise<void> {
  if (getOperationalAlertTransportMode() === "local_log_only") return;
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    const claim = await claimOperationalAlert();
    if (!claim) return;
    const result = await deliverOperationalAlertTransitionDurably(
      claim.transition,
      claim.eventKey,
    );
    if (result.state === "delivered") {
      const applied = await markOperationalAlertDelivered(claim);
      if (!applied) {
        logger.warn(
          { event: "operational_alert_outbox_lost_lease", outboxId: claim.outboxId },
          "Operational alert was delivered after its lease expired",
        );
      }
      continue;
    }
    if (result.state === "deferred" || result.state === "dropped") {
      const nextState = await markOperationalAlertFailed(claim, result.failure);
      logger.warn(
        {
          event: "operational_alert_outbox_delivery_failed",
          outboxId: claim.outboxId,
          category: result.failure.category,
          retryable: result.failure.retryable,
          nextState,
        },
        "Durable operational alert delivery failed",
      );
      continue;
    }
    throw new Error(`Unexpected durable alert delivery state: ${result.state}`);
  }
}

function tick(): void {
  if (running) return;
  running = drainOperationalAlertOutbox()
    .catch((error) =>
      logger.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Operational alert outbox tick failed",
      ),
    )
    .finally(() => {
      running = null;
    });
}

export function startOperationalAlertOutboxWorker(): void {
  if (started) return;
  started = true;
  timer = setInterval(tick, POLL_INTERVAL_MS);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  logger.info("Operational alert outbox worker started");
}

export async function stopOperationalAlertOutboxWorker(): Promise<void> {
  started = false;
  if (timer) clearInterval(timer);
  timer = null;
  await running;
}

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
let warmupTimer: NodeJS.Timeout | null = null;
let running: Promise<void> | null = null;
let abortController: AbortController | null = null;

export async function drainOperationalAlertOutbox(
  signal?: AbortSignal,
): Promise<void> {
  if (getOperationalAlertTransportMode() === "local_log_only") return;
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    if (signal?.aborted) return;
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
          {
            event: "operational_alert_outbox_lost_lease",
            outboxId: claim.outboxId,
          },
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

function tick(signal: AbortSignal): void {
  if (!started || signal.aborted || running) return;
  const run = drainOperationalAlertOutbox(signal)
    .catch((error) =>
      logger.warn(
        { errorName: error instanceof Error ? error.name : "unknown" },
        "Operational alert outbox tick failed",
      ),
    )
    .finally(() => {
      if (running === run) running = null;
    });
  running = run;
}

export function startOperationalAlertOutboxWorker(): void {
  if (started) return;
  started = true;
  const controller = new AbortController();
  abortController = controller;
  const tickCurrent = (): void => tick(controller.signal);
  timer = setInterval(tickCurrent, POLL_INTERVAL_MS);
  timer.unref();
  warmupTimer = setTimeout(tickCurrent, 5_000);
  warmupTimer.unref();
  logger.info("Operational alert outbox worker started");
}

export async function stopOperationalAlertOutboxWorker(): Promise<void> {
  started = false;
  abortController?.abort();
  abortController = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (warmupTimer) clearTimeout(warmupTimer);
  warmupTimer = null;
  const pending = running;
  await pending;
}

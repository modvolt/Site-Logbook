import {
  failProductionRuntimeReadiness,
  refreshProductionRuntimeReadiness,
} from "./production-runtime-state";

export const PRODUCTION_RUNTIME_PARITY_INTERVAL_MS = 60_000;
export const PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_MS = 5_000;
export const PRODUCTION_RUNTIME_PARITY_LOST = "PRODUCTION_RUNTIME_PARITY_LOST";

export type ProductionRuntimeFailStopState = "armed" | "tripped" | "stopped";

export interface ProductionRuntimeFailStopController {
  checkNow(): Promise<ProductionRuntimeFailStopState>;
  readState(): ProductionRuntimeFailStopState;
  stop(): void;
  stopAndWaitForVerdict(
    timeoutMs?: number,
  ): Promise<ProductionRuntimeFailStopState>;
}

interface ProductionRuntimeFailStopOptions {
  refreshLiveReadiness?: () => Promise<boolean>;
  failReadiness?: () => boolean;
  onTrip: (
    reason: typeof PRODUCTION_RUNTIME_PARITY_LOST,
  ) => void | Promise<void>;
  onTripError?: (error: unknown) => void;
  intervalMs?: number;
}

/**
 * Revalidates the exact live DB/schema binding accepted at startup. A
 * recursive timeout is scheduled only after the previous check completes, so
 * slow checks can never overlap. The first false result or exception trips the
 * process-wide readiness latch synchronously and permanently before shutdown
 * work begins.
 */
export function startProductionRuntimeFailStop(
  options: ProductionRuntimeFailStopOptions,
): ProductionRuntimeFailStopController {
  const intervalMs =
    options.intervalMs ?? PRODUCTION_RUNTIME_PARITY_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(
      "PRODUCTION_RUNTIME_FAIL_STOP_INTERVAL_INVALID: interval must be a positive safe integer.",
    );
  }

  const verify =
    options.refreshLiveReadiness ?? refreshProductionRuntimeReadiness;
  const failReadiness = options.failReadiness ?? failProductionRuntimeReadiness;
  let state: ProductionRuntimeFailStopState = "armed";
  let stopRequested = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<ProductionRuntimeFailStopState> | null = null;
  let tripNotification: Promise<void> | null = null;

  const trip = (): Promise<void> => {
    if (state !== "armed") return tripNotification ?? Promise.resolve();
    state = "tripped";
    failReadiness();
    try {
      tripNotification = Promise.resolve(
        options.onTrip(PRODUCTION_RUNTIME_PARITY_LOST),
      ).catch((error: unknown) => {
        options.onTripError?.(error);
      });
    } catch (error) {
      options.onTripError?.(error);
      tripNotification = Promise.resolve();
    }
    return tripNotification;
  };

  const schedule = (): void => {
    if (state !== "armed" || stopRequested || timer || inFlight) return;
    timer = setTimeout(() => {
      timer = null;
      void checkNow();
    }, intervalMs);
    timer.unref();
  };

  const checkNow = (): Promise<ProductionRuntimeFailStopState> => {
    if (state !== "armed") return Promise.resolve(state);
    if (inFlight) return inFlight;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    const check = (async (): Promise<ProductionRuntimeFailStopState> => {
      let ready = false;
      try {
        ready = await verify();
      } catch {
        ready = false;
      }

      if (state === "armed" && !ready) {
        await trip();
      } else if (state === "armed" && stopRequested) {
        state = "stopped";
      }
      return state;
    })();
    inFlight = check;
    void check.finally(() => {
      if (inFlight === check) inFlight = null;
      schedule();
    });
    return check;
  };

  schedule();

  const stop = (): void => {
    stopRequested = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (state === "armed" && !inFlight) state = "stopped";
  };

  const stopAndWaitForVerdict = async (
    timeoutMs = PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_MS,
  ): Promise<ProductionRuntimeFailStopState> => {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(
        "PRODUCTION_RUNTIME_SHUTDOWN_DRAIN_INVALID: timeout must be a positive safe integer.",
      );
    }
    const pending = inFlight;
    stop();
    if (!pending) return state;

    const timedOut = Symbol("production-runtime-parity-timeout");
    let timeout: NodeJS.Timeout | null = null;
    const timeoutResult = new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => resolve(timedOut), timeoutMs);
      timeout.unref();
    });
    const verdict = await Promise.race([pending, timeoutResult]);
    if (timeout) clearTimeout(timeout);
    if (verdict === timedOut) {
      // An unverifiable in-flight check is itself a fail-closed verdict. Trip
      // synchronously; notification/shutdown work is not allowed to extend the
      // bounded drain.
      void trip();
    }
    return state;
  };

  return Object.freeze({
    checkNow,
    readState: () => state,
    stop,
    stopAndWaitForVerdict,
  });
}

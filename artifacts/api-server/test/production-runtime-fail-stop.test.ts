import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_RUNTIME_PARITY_INTERVAL_MS,
  startProductionRuntimeFailStop,
} from "../src/lib/production-runtime-fail-stop";

afterEach(() => {
  vi.useRealTimers();
});

describe("production runtime parity fail-stop", () => {
  it("trips readiness and shutdown exactly once on the first false result", async () => {
    const failReadiness = vi.fn(() => true);
    const onTrip = vi.fn(async () => undefined);
    const refresh = vi.fn(async () => false);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: refresh,
      failReadiness,
      onTrip,
    });

    await expect(controller.checkNow()).resolves.toBe("tripped");
    await expect(controller.checkNow()).resolves.toBe("tripped");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(failReadiness).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledWith("PRODUCTION_RUNTIME_PARITY_LOST");
  });

  it("coalesces concurrent checks and treats verifier throws as parity loss", async () => {
    let reject: ((error: Error) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<boolean>((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const onTrip = vi.fn(async () => undefined);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: refresh,
      failReadiness: () => true,
      onTrip,
    });

    const first = controller.checkNow();
    const second = controller.checkNow();
    expect(refresh).toHaveBeenCalledTimes(1);
    reject?.(new Error("database unavailable"));
    await expect(first).resolves.toBe("tripped");
    await expect(second).resolves.toBe("tripped");
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("uses a recursive 60-second timeout and never overlaps slow checks", async () => {
    vi.useFakeTimers();
    let release: ((ready: boolean) => void) | undefined;
    const refresh = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: refresh,
      failReadiness: () => true,
      onTrip: async () => undefined,
    });

    expect(PRODUCTION_RUNTIME_PARITY_INTERVAL_MS).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    release?.(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    controller.stop();
  });

  it("stops idempotently without invoking the verifier", async () => {
    const refresh = vi.fn(async () => true);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: refresh,
      failReadiness: () => true,
      onTrip: async () => undefined,
    });
    controller.stop();
    controller.stop();
    await expect(controller.checkNow()).resolves.toBe("stopped");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("preserves an in-flight parity failure after graceful stop is requested", async () => {
    let release: ((ready: boolean) => void) | undefined;
    const onTrip = vi.fn(async () => undefined);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
      failReadiness: () => true,
      onTrip,
    });

    const check = controller.checkNow();
    controller.stop();
    release?.(false);
    await expect(check).resolves.toBe("tripped");
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it("waits for a healthy in-flight verdict before allowing graceful exit", async () => {
    let release: ((ready: boolean) => void) | undefined;
    const onTrip = vi.fn(async () => undefined);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
      failReadiness: () => true,
      onTrip,
    });

    void controller.checkNow();
    const drain = controller.stopAndWaitForVerdict(5_000);
    release?.(true);
    await expect(drain).resolves.toBe("stopped");
    expect(onTrip).not.toHaveBeenCalled();
  });

  it("fails closed when an in-flight verdict exceeds the bounded drain", async () => {
    vi.useFakeTimers();
    const failReadiness = vi.fn(() => true);
    const onTrip = vi.fn(async () => undefined);
    const controller = startProductionRuntimeFailStop({
      refreshLiveReadiness: () => new Promise<boolean>(() => undefined),
      failReadiness,
      onTrip,
    });

    void controller.checkNow();
    const drain = controller.stopAndWaitForVerdict(5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(controller.readState()).toBe("armed");
    await vi.advanceTimersByTimeAsync(1);
    await expect(drain).resolves.toBe("tripped");
    expect(failReadiness).toHaveBeenCalledTimes(1);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });
});

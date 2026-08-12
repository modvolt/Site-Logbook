import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  deliver: vi.fn(),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../src/lib/operational-alert-transport", () => ({
  getOperationalAlertTransportMode: () => "webhook",
  deliverOperationalAlertTransitionDurably: mocks.deliver,
}));

vi.mock("../src/lib/operational-incident-store", () => ({
  claimOperationalAlert: mocks.claim,
  markOperationalAlertDelivered: mocks.markDelivered,
  markOperationalAlertFailed: mocks.markFailed,
}));

import {
  startOperationalAlertOutboxWorker,
  stopOperationalAlertOutboxWorker,
} from "../src/lib/operational-alert-outbox-worker";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("operational alert outbox fail-stop", () => {
  beforeEach(async () => {
    await stopOperationalAlertOutboxWorker();
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await stopOperationalAlertOutboxWorker();
    vi.useRealTimers();
  });

  it("clears the warmup timer before it can claim work", async () => {
    startOperationalAlertOutboxWorker();
    await stopOperationalAlertOutboxWorker();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("finishes a claim that resolves after stop but never claims another", async () => {
    const claim = deferred<any>();
    mocks.claim.mockReturnValueOnce(claim.promise);
    mocks.deliver.mockResolvedValueOnce({ state: "delivered" });
    mocks.markDelivered.mockResolvedValueOnce(true);

    startOperationalAlertOutboxWorker();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mocks.claim).toHaveBeenCalledTimes(1);

    const stopping = stopOperationalAlertOutboxWorker();
    claim.resolve({ outboxId: 1, transition: {}, eventKey: "event-1" });
    await stopping;

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.markDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  it("marks an in-flight delivery after stop but never claims another", async () => {
    const delivery = deferred<any>();
    mocks.claim.mockResolvedValueOnce({
      outboxId: 1,
      transition: {},
      eventKey: "event-1",
    });
    mocks.deliver.mockReturnValueOnce(delivery.promise);
    mocks.markDelivered.mockResolvedValueOnce(true);

    startOperationalAlertOutboxWorker();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(1));

    const stopping = stopOperationalAlertOutboxWorker();
    delivery.resolve({ state: "delivered" });
    await stopping;

    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.markDelivered).toHaveBeenCalledTimes(1);
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let resolveConnect!: () => void;
  const connect = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolveConnect = resolve;
      }),
  );
  const query = vi.fn(async () => undefined);
  const end = vi.fn(async () => undefined);
  const on = vi.fn();
  return {
    connect,
    query,
    end,
    on,
    resolveConnect: () => resolveConnect(),
  };
});

vi.mock("pg", () => ({
  default: {
    Client: class {
      connect = mocks.connect;
      query = mocks.query;
      end = mocks.end;
      on = mocks.on;
    },
  },
}));

vi.mock("../src/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@workspace/live-events", () => ({
  parseLiveEventPayload: vi.fn(),
}));

vi.mock("../src/lib/live-updates", () => ({
  publishToLocalClients: vi.fn(),
}));

import {
  shutdownLiveEventsService,
  startLiveEventsService,
} from "../src/lib/live-events-service";

describe("live-events shutdown race", () => {
  afterEach(async () => {
    await shutdownLiveEventsService();
    vi.clearAllMocks();
  });

  it("closes a client whose connect resolves after shutdown without LISTEN", async () => {
    const starting = startLiveEventsService();
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));

    await shutdownLiveEventsService();
    mocks.resolveConnect();
    await starting;

    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.on).toHaveBeenCalledTimes(1);
  });

  it("does not attach handlers when LISTEN resolves after shutdown", async () => {
    const query = deferred<void>();
    mocks.connect.mockResolvedValueOnce(undefined);
    mocks.query.mockReturnValueOnce(query.promise);

    const starting = startLiveEventsService();
    await vi.waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1));

    await shutdownLiveEventsService();
    query.resolve();
    await starting;

    expect(mocks.end).toHaveBeenCalled();
    // The only handler belongs to createListenerClient's mandatory no-throw
    // socket error listener; notification/end/reconnect handlers stay absent.
    expect(mocks.on).toHaveBeenCalledTimes(1);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

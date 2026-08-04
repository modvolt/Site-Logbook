import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const listeners = new Set<(error: Error) => void>();
  const query = vi.fn();
  const release = vi.fn();
  const client = {
    query,
    release,
    on(event: string, listener: (error: Error) => void) {
      if (event === "error") listeners.add(listener);
      return client;
    },
    removeListener(event: string, listener: (error: Error) => void) {
      if (event === "error") listeners.delete(listener);
      return client;
    },
  };
  return {
    listeners,
    query,
    release,
    client,
    poolOn: vi.fn(),
    loggerWarn: vi.fn(),
  };
});

vi.mock("pg", () => ({
  default: {
    Pool: class {
      on = mocks.poolOn;
      async connect() {
        return mocks.client;
      }
    },
  },
}));

vi.mock("../src/lib/logger", () => ({
  logger: { warn: mocks.loggerWarn },
}));

import { tryAcquireSchedulerLock } from "../src/lib/scheduler-lock";

describe("explicit scheduler lock lease", () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.loggerWarn.mockReset();
    mocks.listeners.clear();
  });

  it("handles a checked-out client error, invalidates the lease and destroys the session", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ acquired: true }] });
    const lease = await tryAcquireSchedulerLock(42_424);
    expect(lease?.isValid()).toBe(true);
    expect(mocks.listeners.size).toBe(1);

    for (const listener of [...mocks.listeners]) {
      listener(new Error("connection reset with sensitive host details"));
    }

    expect(lease?.isValid()).toBe(false);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { errorName: "Error", lockKey: 42_424 },
      "Scheduler lock lease connection failed",
    );
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain(
      "sensitive host details",
    );

    await lease?.release();
    expect(mocks.release).toHaveBeenCalledWith(true);
    expect(mocks.listeners.size).toBe(0);
  });
});

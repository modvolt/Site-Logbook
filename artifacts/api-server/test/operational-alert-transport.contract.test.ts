import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  OperationalAlertTransportConfigError,
  OperationalAlertWebhookTransport,
  deliverOperationalAlertTransitions,
  loadOperationalAlertTransportConfig,
} from "../src/lib/operational-alert-transport";
import type { OperationalAlertTransition } from "../src/lib/operational-alert-policy";

const TOKEN = "A".repeat(43);
const root = resolve(import.meta.dirname, "..", "..", "..");

function config() {
  return {
    mode: "https_webhook" as const,
    url: "https://alerts.example.com/site-logbook",
    bearerToken: TOKEN,
    timeoutMs: 4_000,
    cooldownMs: 900_000,
  };
}

function transition(
  fingerprint = "queue.extraction.stale",
  observedAt = "2026-08-04T00:00:00.000Z",
): OperationalAlertTransition {
  return {
    kind: "triggered",
    observedAt,
    alert: {
      fingerprint,
      code: fingerprint,
      severity: "critical",
      owner: "Backend / doklady",
      runbook: "docs/runbooks/operational-alerts.md#fronty",
      summary: "attacker@example.invalid objectPath=/private/do-not-send",
      metric: "oldest_ready_age_seconds",
      observed: 3_600,
      threshold: 3_600,
    },
  };
}

describe("operational alert transport configuration", () => {
  it("stays disabled even when dormant URL and token values are present", async () => {
    expect(
      loadOperationalAlertTransportConfig({
        OPERATIONAL_ALERT_WEBHOOK_URL: "http://127.0.0.1/ignored",
        OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN: "invalid",
      }),
    ).toEqual({ mode: "disabled" });
    await expect(
      deliverOperationalAlertTransitions([transition()]),
    ).resolves.toEqual({
      state: "disabled",
      pendingCount: 0,
    });
  });

  it("fails closed for incomplete, insecure or private enabled targets", () => {
    const enabled = {
      OPERATIONAL_ALERT_TRANSPORT: "https_webhook",
      OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN: TOKEN,
    };

    expect(() => loadOperationalAlertTransportConfig(enabled)).toThrow(
      OperationalAlertTransportConfigError,
    );
    for (const url of [
      "http://alerts.example.com/hook",
      "https://127.0.0.1/hook",
      "https://10.0.0.8/hook",
      "https://alerts.local/hook",
      "https://local/hook",
      "https://[::ffff:7f00:1]/hook",
      "https://[ff02::1]/hook",
      "https://alerts.example.com/hook?secret=value",
    ]) {
      expect(() =>
        loadOperationalAlertTransportConfig({
          ...enabled,
          OPERATIONAL_ALERT_WEBHOOK_URL: url,
          OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS: new URL(url).hostname,
        }),
      ).toThrow(OperationalAlertTransportConfigError);
    }
  });

  it("accepts an explicit public HTTPS target and bounded settings", () => {
    expect(
      loadOperationalAlertTransportConfig({
        OPERATIONAL_ALERT_TRANSPORT: "https_webhook",
        OPERATIONAL_ALERT_WEBHOOK_URL: config().url,
        OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS: "alerts.example.com",
        OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN: TOKEN,
        OPERATIONAL_ALERT_WEBHOOK_TIMEOUT_MS: "2500",
        OPERATIONAL_ALERT_WEBHOOK_COOLDOWN_SECONDS: "600",
      }),
    ).toEqual({
      ...config(),
      timeoutMs: 2_500,
      cooldownMs: 600_000,
    });
  });

  it("requires the enabled URL host to match an explicit exact allowlist", () => {
    expect(() =>
      loadOperationalAlertTransportConfig({
        OPERATIONAL_ALERT_TRANSPORT: "https_webhook",
        OPERATIONAL_ALERT_WEBHOOK_URL: config().url,
        OPERATIONAL_ALERT_WEBHOOK_ALLOWED_HOSTS: "other.example.com",
        OPERATIONAL_ALERT_WEBHOOK_BEARER_TOKEN: TOKEN,
      }),
    ).toThrow(OperationalAlertTransportConfigError);
  });

  it("fails before listen when an enabled startup configuration is incomplete", () => {
    const tsx = resolve(root, "scripts", "node_modules", "tsx", "dist", "cli.mjs");
    const result = spawnSync(
      process.execPath,
      [
        tsx,
        "-e",
        'import("./artifacts/api-server/src/lib/operational-alert-transport.ts")',
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          PORT: "65432",
          SESSION_SECRET: "isolated-startup-test-session-secret",
          DATABASE_URL: "postgresql://test:test@127.0.0.1:1/isolated_unit_test",
          OPERATIONAL_ALERT_TRANSPORT: "https_webhook",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "OperationalAlertTransportConfigError",
    );
    expect(`${result.stdout}${result.stderr}`).not.toContain("Server listening");
  });
});

describe("operational alert HTTPS webhook", () => {
  it("posts an allowlisted redacted payload with auth and idempotency headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
    });

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "delivered",
      transitionCount: 1,
      pendingCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(config().url);
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(init.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "idempotency-key": expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(init.body).toEqual(expect.any(String));
    const body = String(init.body);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(16 * 1_024);
    expect(body).not.toMatch(
      /summary|attacker@example|objectPath|private\/do-not-send/i,
    );
    expect(JSON.parse(body).transitions).toEqual([
      expect.objectContaining({
        fingerprint: "queue.extraction.stale",
        kind: "triggered",
        severity: "critical",
      }),
    ]);
  });

  it("uses the durable event key unchanged across transport retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      sleep: vi.fn(),
    });
    const durableKey = "b".repeat(64);

    await expect(
      transport.deliverDurable(transition(), durableKey),
    ).resolves.toMatchObject({ state: "delivered", transitionCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({
        "idempotency-key": durableKey,
      });
    }
  });

  it("retries retryable statuses with fixed bounded backoff", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 202 });
    const sleepMock = vi.fn().mockResolvedValue(undefined);
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: sleepMock,
    });

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "delivered",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleepMock.mock.calls).toEqual([[250], [1_000]]);
    const keys = fetchMock.mock.calls.map(
      ([, init]) =>
        (init as RequestInit).headers &&
        (init as any).headers["idempotency-key"],
    );
    expect(new Set(keys).size).toBe(1);
  });

  it("drops permanent 4xx failures without retrying or exposing response bodies", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      status: 401,
      text: () => Promise.resolve("provider secret response"),
    });
    const failureMock = vi.fn();
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
      onFailure: failureMock,
    });

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "dropped",
      pendingCount: 0,
      failure: {
        category: "http_permanent",
        retryable: false,
        status: 401,
        attemptCount: 1,
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(failureMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        body: expect.anything(),
        url: expect.anything(),
      }),
    );
  });

  it("refuses redirects and cancels the unused response stream", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue({ status: 302, body: { cancel } });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
    });

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "dropped",
      failure: { category: "redirect_refused", status: 302 },
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts each timed-out attempt and leaves the transition queued", async () => {
    const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("redacted timeout");
          error.name = "AbortError";
          reject(error);
        });
      }),
    );
    const transport = new OperationalAlertWebhookTransport(
      { ...config(), timeoutMs: 5 },
      { fetch: fetchMock, now: () => 1_000, sleep: vi.fn() },
    );

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "deferred",
      pendingCount: 1,
      failure: { category: "timeout", attemptCount: 3 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps retryable failures in memory and retries them on the next watchdog tick", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("network details"))
      .mockRejectedValueOnce(new TypeError("network details"))
      .mockRejectedValueOnce(new TypeError("network details"))
      .mockResolvedValueOnce({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    await expect(transport.deliver([transition()])).resolves.toMatchObject({
      state: "deferred",
      pendingCount: 1,
    });
    await expect(transport.deliver([])).resolves.toMatchObject({
      state: "delivered",
      pendingCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("drains bursts in 32-item batches without a global cooldown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
    });

    const queued = Array.from({ length: 40 }, (_, index) =>
      transition(
        `queue.test.${index}`,
        `2026-08-04T00:${String(index).padStart(2, "0")}:00.000Z`,
      ),
    );
    await expect(transport.deliver(queued)).resolves.toMatchObject({
      state: "delivered",
      transitionCount: 40,
      pendingCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).transitions).toHaveLength(32);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).transitions).toHaveLength(8);
  });

  it("suppresses only the same transition key while critical and recovery remain immediate", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
    });
    const warning = transition("queue.extraction.stale");
    warning.alert.severity = "warning";
    const duplicate = { ...warning, observedAt: "2026-08-04T00:05:00.000Z" };
    const critical = {
      ...transition("queue.extraction.stale", "2026-08-04T00:06:00.000Z"),
      kind: "escalated" as const,
    };
    const recovery = {
      ...transition("queue.extraction.stale", "2026-08-04T00:07:00.000Z"),
      kind: "recovered" as const,
    };

    await expect(transport.deliver([warning])).resolves.toMatchObject({ state: "delivered" });
    await expect(transport.deliver([duplicate])).resolves.toEqual({
      state: "cooldown",
      pendingCount: 0,
    });
    await expect(transport.deliver([critical])).resolves.toMatchObject({ state: "delivered" });
    await expect(transport.deliver([recovery])).resolves.toMatchObject({ state: "delivered" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("drains a recovery enqueued while another delivery is in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstResponse = new Promise<{ status: number }>((resolve) => {
      releaseFirst = () => resolve({ status: 204 });
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValue({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
    });

    const active = transport.deliver([transition()]);
    const recovered = transport.deliver([
      { ...transition(), kind: "recovered", observedAt: "2026-08-04T00:10:00.000Z" },
    ]);
    releaseFirst?.();

    await expect(active).resolves.toMatchObject({
      state: "delivered",
      transitionCount: 2,
    });
    await expect(recovered).resolves.toMatchObject({ transitionCount: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caps the in-memory queue and emits only a redacted overflow signal", async () => {
    const failureMock = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ status: 204 });
    const transport = new OperationalAlertWebhookTransport(config(), {
      fetch: fetchMock,
      now: () => 1_000,
      sleep: vi.fn(),
      onFailure: failureMock,
    });
    const transitions = Array.from({ length: 130 }, (_, index) =>
      transition(`queue.overflow.${index}`),
    );

    await expect(transport.deliver(transitions)).resolves.toMatchObject({
      state: "delivered",
      transitionCount: 128,
      pendingCount: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(failureMock).toHaveBeenCalledTimes(2);
    expect(failureMock).toHaveBeenLastCalledWith({
      category: "queue_overflow",
      retryable: false,
      status: null,
      attemptCount: 0,
      pendingCount: 128,
    });
    expect(JSON.stringify(failureMock.mock.calls)).not.toMatch(
      /summary|token|url|attacker@example|objectPath/i,
    );
  });
});

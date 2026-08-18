import { describe, expect, it, vi } from "vitest";
import { probeDatabaseReadiness } from "../src/lib/db-health-probe";

function resolvedClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ rows: [{ ok: 1 }] }),
    end: vi.fn().mockResolvedValue(undefined),
  };
}

describe("database readiness probe", () => {
  it("uses an isolated client with bounded connection and query settings", async () => {
    const client = resolvedClient();
    const clientFactory = vi.fn(() => client);

    const latencyMs = await probeDatabaseReadiness({
      connectionString: "postgresql://readiness.invalid/app",
      timeoutMs: 250,
      clientFactory,
    });

    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(clientFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeoutMillis: 250,
        query_timeout: 250,
        statement_timeout: 250,
        application_name: "site-logbook-readiness",
      }),
    );
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith("SELECT 1");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("fails within the configured deadline and closes the client", async () => {
    const client = {
      ...resolvedClient(),
      connect: vi.fn(() => new Promise<void>(() => undefined)),
    };
    const startedAt = Date.now();

    await expect(
      probeDatabaseReadiness({
        connectionString: "postgresql://readiness.invalid/app",
        timeoutMs: 30,
        clientFactory: () => client,
      }),
    ).rejects.toThrow("timed out after 30 ms");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(client.end).toHaveBeenCalledOnce();
  });

  it("rejects invalid timeout configuration before opening a client", async () => {
    const clientFactory = vi.fn(() => resolvedClient());

    await expect(
      probeDatabaseReadiness({
        connectionString: "postgresql://readiness.invalid/app",
        timeoutMs: 0,
        clientFactory,
      }),
    ).rejects.toThrow("positive number");
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

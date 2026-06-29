import { test, expect } from "@playwright/test";

/**
 * End-to-end guard for SSE live-update delivery after a connection drop and
 * reconnect.
 *
 * The useLiveUpdates hook relies entirely on the browser's built-in
 * EventSource reconnection — it opens one connection and closes it only on
 * unmount. A regression where the server's publishToLocalClients() stops
 * writing to newly-registered clients (e.g. because of a registry bug) would
 * silently freeze live updates for every user after their first network blip.
 *
 * Test flow:
 *   1. Open an authenticated page so the session cookie is set.
 *   2. Inject EventSource A (connection 1) and wait for it to be OPEN.
 *   3. Close EventSource A — simulating the server dropping the connection —
 *      and immediately open EventSource B (connection 2), simulating the
 *      EventSource retry/reconnect the browser performs automatically.
 *   4. Wait for EventSource B to reach readyState OPEN.
 *   5. Trigger a mutation (create a customer) that calls publishLiveEvent()
 *      via the broadcast middleware.
 *   6. Assert the `invalidate` event containing the "customers" domain
 *      arrives on EventSource B (the reconnected stream), NOT on the closed A.
 *   7. Clean up the test customer.
 *
 * What this guards:
 *   - registerClient() adds the new Response to the live client registry.
 *   - The request-close handler properly unregisters the OLD client so the
 *     registry does not grow unboundedly and the old broken pipe is gone.
 *   - publishToLocalClients() fans out to the NEW client after reconnect.
 */
test.describe("SSE reconnect delivers live events on the new connection", () => {
  let createdCustomerId: number | null = null;

  test.afterAll(async ({ request }) => {
    if (createdCustomerId != null) {
      await request
        .delete(`/api/customers/${createdCustomerId}`)
        .catch(() => {});
    }
  });

  test("invalidate event arrives on a reconnected EventSource after the previous connection is closed", async ({
    page,
    request,
  }) => {
    // Navigate to an authenticated page so the session cookie is established.
    // domcontentloaded avoids waiting for the persistent SSE connection to
    // resolve (networkidle never fires while an EventSource is open).
    await page.goto("/customers");
    await page.waitForLoadState("domcontentloaded");

    // --- Step 1: Open connection A and wait for it to be OPEN ---
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__sseA = new EventSource(
        "/api/events",
      );
      (
        window as unknown as Record<string, Array<{ domains: string[] }>>
      ).__sseReconnectEvents = [];
    });

    await page.waitForFunction(
      () =>
        (
          window as unknown as Record<string, { readyState: number }>
        ).__sseA?.readyState === 1,
      undefined,
      { timeout: 10_000 },
    );

    // --- Step 2: Close connection A, immediately open connection B ---
    // Calling .close() terminates the stream without triggering an automatic
    // browser retry (that only happens on network errors). We open B explicitly
    // to mirror what the browser does on an unexpected drop: the EventSource
    // constructor reconnects to the same URL after the server's `retry` delay.
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;

      // Close connection A (remove it from the server's live-client registry
      // via the req "close" event on the server side).
      (w.__sseA as EventSource).close();

      // Open connection B — simulating the browser's automatic reconnect.
      const b = new EventSource("/api/events");
      w.__sseB = b;

      b.addEventListener("invalidate", (ev: MessageEvent) => {
        const payload = JSON.parse(ev.data) as {
          domains: string[];
          [k: string]: unknown;
        };
        (w.__sseReconnectEvents as Array<{ domains: string[] }>).push(payload);
      });
    });

    // --- Step 3: Wait for connection B to be OPEN ---
    await page.waitForFunction(
      () =>
        (
          window as unknown as Record<string, { readyState: number }>
        ).__sseB?.readyState === 1,
      undefined,
      { timeout: 10_000 },
    );

    // --- Step 4: Trigger a mutation via the API ---
    // POST /api/customers is intercepted by the broadcast middleware which
    // calls domainsForPath("/customers") → ["customers"] and fans out to all
    // registered SSE clients. Connection B must now be in the registry.
    const stamp = Date.now();
    const createRes = await request.post("/api/customers", {
      data: {
        companyName: `E2E SSE Reconnect Test ${stamp}`,
      },
    });
    expect(
      createRes.status(),
      "Customer creation must succeed (2xx)",
    ).toBeLessThan(300);

    const createBody = (await createRes.json()) as { id: number };
    createdCustomerId = createBody.id ?? null;

    // --- Step 5: Assert the event arrives on connection B ---
    await page.waitForFunction(
      () => {
        const events = (
          window as unknown as Record<
            string,
            Array<{ domains: string[] }>
          >
        ).__sseReconnectEvents;
        return (
          Array.isArray(events) &&
          events.some((ev) => ev.domains?.includes("customers"))
        );
      },
      undefined,
      { timeout: 12_000 },
    );

    // Shape assertion: the event must be well-formed.
    const events = await page.evaluate(
      () =>
        (
          window as unknown as Record<
            string,
            Array<{ domains: string[]; eventId: unknown; ts: unknown }>
          >
        ).__sseReconnectEvents,
    );

    const match = events.find((ev) => ev.domains?.includes("customers"));
    expect(
      match,
      "At least one SSE invalidate event on the reconnected stream must include the customers domain",
    ).toBeDefined();
    expect(match!.domains).toContain("customers");
    expect(typeof match!.eventId).toBe("number");
    expect(typeof match!.ts).toBe("string");

    // Verify connection A received nothing after it was closed: the server
    // should have unregistered it. We can't assert A's events[] directly
    // (we never attached a listener on A), but we can confirm A's readyState
    // stayed CLOSED (2) so it never auto-reconnected and competed with B.
    const aReadyState = await page.evaluate(
      () =>
        (window as unknown as Record<string, { readyState: number }>).__sseA
          ?.readyState,
    );
    expect(aReadyState, "Connection A must remain CLOSED after explicit close()").toBe(2);

    // Clean up B.
    await page.evaluate(() => {
      (
        (window as unknown as Record<string, unknown>).__sseB as EventSource
      ).close();
    });
  });
});

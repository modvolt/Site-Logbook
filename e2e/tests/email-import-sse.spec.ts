import { test, expect } from "@playwright/test";

/**
 * End-to-end guard for the email-import → SSE broadcast chain.
 *
 * The IMAP sync worker calls:
 *   publishLiveEvent(["emailImport", "billingDocuments", "reviewQueue"])
 * after each completed poll (via pollAndRecord in email-import.ts).
 *
 * This test exercises the full broadcast chain by triggering the manual
 * "Poll Now" endpoint (POST /api/email-import/poll) and asserting that the
 * "emailImport" domain arrives in the browser's SSE stream:
 *
 *   pollAndRecord() → publishLiveEvent() → pg_notify → PG LISTEN client
 *     → publishToLocalClients() → SSE write → browser EventSource.
 *
 * The poll endpoint succeeds even when IMAP is not configured (pollOnce
 * returns an empty result rather than throwing), so no external IMAP
 * credentials are required in the dev/e2e environment. The SSE is always
 * published after a successful poll because lastPolledAt changes regardless
 * of whether messages were imported.
 *
 * A silent break anywhere in this chain — e.g. removing the publishLiveEvent
 * call from pollAndRecord, a regression in the PG LISTEN reconnect, or a
 * broken SSE write — would cause this test to time out and catch the
 * regression before it reaches users seeing stale counts on
 * /billing/email-import.
 *
 * Relevant source paths:
 *   - artifacts/api-server/src/lib/email-import.ts  (pollOnce, pollAndRecord)
 *   - artifacts/api-server/src/routes/email-import-settings.ts (POST /email-import/poll)
 *   - artifacts/api-server/src/lib/live-events-service.ts
 */
test.describe("Email import SSE broadcast", () => {
  test("SSE invalidate event with emailImport domain reaches the browser after pollAndRecord completes", async ({
    page,
    request,
  }) => {
    // Navigate to /billing/email-import so the session cookie is attached and
    // the app's own SSE connection confirms the endpoint is live. Use
    // domcontentloaded rather than networkidle — the app holds a persistent
    // SSE connection that prevents networkidle from ever resolving.
    await page.goto("/billing/email-import");
    await page.waitForLoadState("domcontentloaded");

    // Inject a dedicated EventSource listener that records every `invalidate`
    // event payload. We open a fresh EventSource (not the app's own) so we
    // capture events regardless of whether the app's clientId filter suppresses
    // them for its own stream.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__sseEmailEvents =
        [] as Array<{ domains: string[]; [k: string]: unknown }>;
      const es = new EventSource("/api/events");
      es.addEventListener("invalidate", (ev: MessageEvent) => {
        const payload = JSON.parse(ev.data) as {
          domains: string[];
          [k: string]: unknown;
        };
        (
          window as unknown as Record<
            string,
            Array<{ domains: string[]; [k: string]: unknown }>
          >
        ).__sseEmailEvents.push(payload);
      });
      (window as unknown as Record<string, unknown>).__sseEmailSource = es;
    });

    // Wait until the injected EventSource is OPEN (readyState === 1) before
    // triggering the poll, so we cannot miss the event.
    await page.waitForFunction(
      () =>
        (window as unknown as Record<string, { readyState: number }>)
          .__sseEmailSource?.readyState === 1,
      undefined,
      { timeout: 10_000 },
    );

    // Trigger a manual email-import poll. pollAndRecord() calls publishLiveEvent
    // with ["emailImport", "billingDocuments", "reviewQueue"] after every
    // successful poll — even when IMAP is not configured and 0 messages are
    // imported, because lastPolledAt always changes and the page should refresh.
    const pollRes = await request.post("/api/email-import/poll");
    expect(
      pollRes.status(),
      "Manual poll must succeed (2xx) — pollAndRecord should complete cleanly even without IMAP configured",
    ).toBeLessThan(300);

    // Wait for the SSE event. Allow up to 10 s for the full cycle:
    // pg_notify round-trip + LISTEN client delivery + SSE write.
    await page.waitForFunction(
      () => {
        const events = (
          window as unknown as Record<
            string,
            Array<{ domains: string[] }>
          >
        ).__sseEmailEvents;
        return (
          Array.isArray(events) &&
          events.some((ev) => ev.domains?.includes("emailImport"))
        );
      },
      undefined,
      { timeout: 10_000 },
    );

    // Final shape assertion — confirm the payload is well-formed.
    const events = await page.evaluate(
      () =>
        (
          window as unknown as Record<
            string,
            Array<{ domains: string[]; eventId: number; ts: string }>
          >
        ).__sseEmailEvents,
    );

    const match = events.find((ev) => ev.domains?.includes("emailImport"));
    expect(
      match,
      "At least one SSE invalidate event must include the emailImport domain",
    ).toBeDefined();
    expect(match!.domains).toContain("emailImport");
    expect(typeof match!.eventId).toBe("number");
    expect(typeof match!.ts).toBe("string");
  });
});

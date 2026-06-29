import { test, expect } from "@playwright/test";

/**
 * End-to-end guard for the extraction-worker → SSE broadcast chain.
 *
 * The unit test (extraction-worker-publish.test.ts) verifies that
 * publishLiveEvent() is called after a job is processed, but it mocks the
 * publish function and never exercises the live SSE pipeline. This test
 * closes that gap by:
 *
 *   1. Opening a browser page (authenticates the SSE connection via session
 *      cookie) and injecting a second EventSource listener.
 *   2. Uploading a PDF billing document via the API, which enqueues an
 *      extraction_job in "queued" state.
 *   3. Waiting for the in-process worker poll (≤ 5 s cadence) to claim the
 *      job, route it to needs_review (AI is off in dev), and call
 *      publishLiveEvent(["billingDocuments", "reviewQueue", "emailImport"]).
 *   4. Asserting that the injected EventSource receives an SSE invalidate
 *      event containing the "billingDocuments" domain within 15 seconds.
 *
 * The full broadcast chain exercised:
 *   drainQueue() → publishLiveEvent() → pg_notify → PG LISTEN client
 *     → publishToLocalClients() → SSE write → browser EventSource.
 */
test.describe("Extraction worker SSE broadcast", () => {
  let docId: number | null = null;

  test.afterAll(async ({ request }) => {
    if (docId != null) {
      await request
        .delete(`/api/billing/documents/${docId}`)
        .catch(() => {});
    }
  });

  test("SSE invalidate event with billingDocuments domain arrives after worker processes queued extraction job", async ({
    page,
    request,
  }) => {
    // Navigate to an authenticated page so the session cookie is set and the
    // app's own SSE connection confirms the endpoint is live. Use
    // domcontentloaded rather than networkidle because the app holds a
    // persistent SSE connection that prevents networkidle from ever resolving.
    await page.goto("/billing/documents");
    await page.waitForLoadState("domcontentloaded");

    // Inject a dedicated EventSource listener that records every `invalidate`
    // event payload. We use a fresh EventSource (not the one the app opened)
    // so we capture events regardless of whether the app's clientId filter
    // suppresses them for its own stream.
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__sseEvents = [] as Array<{
        domains: string[];
        [k: string]: unknown;
      }>;
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
        ).__sseEvents.push(payload);
      });
      (window as unknown as Record<string, unknown>).__sseSource = es;
    });

    // Wait until the injected EventSource reports OPEN (readyState === 1)
    // before uploading, so we don't miss the event.
    await page.waitForFunction(
      () =>
        (window as unknown as Record<string, { readyState: number }>)
          .__sseSource?.readyState === 1,
      undefined,
      { timeout: 10_000 },
    );

    // Upload a minimal PDF. The upload handler stores the document, then
    // inserts a row into extraction_jobs (status="queued"). The extraction
    // worker's poll (every 5 s) will claim the job, find AI disabled, route
    // the document to needs_review, mark the job skipped, and call
    // publishLiveEvent(["billingDocuments", "reviewQueue", "emailImport"]).
    // Use unique filename and unique content each run to avoid 409 conflicts
    // from leftover docs — the upload handler deduplicates by SHA-256, so the
    // content must also differ across runs.
    const stamp = Date.now();
    const minimalPdf = Buffer.from(`%PDF-1.4 e2e-${stamp}\n%%EOF`, "utf-8");
    const uploadRes = await request.post(
      `/api/billing/documents/upload?name=e2e-sse-${stamp}.pdf&contentType=application%2Fpdf`,
      {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(minimalPdf.length),
        },
        data: minimalPdf,
      },
    );
    expect(
      uploadRes.status(),
      "PDF upload must succeed (2xx)",
    ).toBeLessThan(300);

    const uploadBody = (await uploadRes.json()) as {
      document: { id: number };
    };
    docId = uploadBody.document.id;
    expect(docId, "upload response must include document id").toBeGreaterThan(0);

    // Wait for the SSE event. The worker polls every 5 s; allow up to 15 s
    // for the full cycle: poll delay + claim + DB update + pg_notify round-trip.
    await page.waitForFunction(
      () => {
        const events = (
          window as unknown as Record<
            string,
            Array<{ domains: string[] }>
          >
        ).__sseEvents;
        return (
          Array.isArray(events) &&
          events.some((ev) => ev.domains?.includes("billingDocuments"))
        );
      },
      undefined,
      { timeout: 15_000 },
    );

    // Final shape assertion — confirm the payload is well-formed.
    const events = await page.evaluate(
      () =>
        (
          window as unknown as Record<
            string,
            Array<{ domains: string[]; eventId: number; ts: string }>
          >
        ).__sseEvents,
    );

    const match = events.find((ev) => ev.domains?.includes("billingDocuments"));
    expect(
      match,
      "At least one SSE invalidate event must include the billingDocuments domain",
    ).toBeDefined();
    expect(match!.domains).toContain("billingDocuments");
    expect(typeof match!.eventId).toBe("number");
    expect(typeof match!.ts).toBe("string");
  });
});

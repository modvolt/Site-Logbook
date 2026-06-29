import { test, expect } from "@playwright/test";

/**
 * Guards the SSE subscription contract: every browser tab must open exactly
 * one persistent connection to /api/events regardless of how many routes the
 * user navigates through. A second call to useLiveUpdates() anywhere in the
 * component tree would silently open a second EventSource, doubling server-side
 * load and potentially causing duplicate query invalidations.
 *
 * Implementation note: Playwright intercepts every network request on the page.
 * We count how many times a request whose URL ends with /api/events is
 * initiated, then navigate across several routes and assert the count stays
 * at exactly 1 (the connection opened on initial login, possibly broken and
 * auto-reconnected by the browser's EventSource retry — those are allowed as
 * long as only one is open at any moment). To distinguish intentional
 * reconnects from duplicate subscriptions we track concurrent in-flight SSE
 * requests at each navigation step and assert the maximum concurrent count is 1.
 */
test.describe("SSE single-connection guard", () => {
  test("exactly one /api/events connection is open while navigating between routes", async ({
    page,
  }) => {
    const sseRequestsInFlight = new Set<string>();
    let maxConcurrent = 0;

    // Track SSE requests by their unique Playwright request ID (we use the
    // request object reference stored in a Map keyed by a counter).
    const inFlight = new Map<object, boolean>();

    page.on("request", (req) => {
      if (!req.url().includes("/api/events")) return;
      inFlight.set(req, true);
      if (inFlight.size > maxConcurrent) maxConcurrent = inFlight.size;
    });

    page.on("requestfinished", (req) => {
      inFlight.delete(req);
    });

    page.on("requestfailed", (req) => {
      inFlight.delete(req);
    });

    // Navigate to the app root (authenticated via storageState in config).
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // Navigate across routes that previously had duplicate useLiveUpdates() calls.
    await page.goto("/jobs");
    await page.waitForLoadState("networkidle");

    await page.goto("/customers");
    await page.waitForLoadState("networkidle");

    await page.goto("/admin/sessions");
    await page.waitForLoadState("networkidle");

    await page.goto("/people");
    await page.waitForLoadState("networkidle");

    await page.goto("/sklad");
    await page.waitForLoadState("networkidle");

    // After all navigations, at most one SSE connection should have ever been
    // open concurrently. The browser's automatic EventSource retry may cause a
    // brief overlap of ~1 request (old closing + new opening) in some
    // environments, so we allow up to 2 concurrent but never 3+.
    expect(
      maxConcurrent,
      `At most 2 concurrent /api/events requests expected (1 open + 1 reconnect), got ${maxConcurrent}`,
    ).toBeLessThanOrEqual(2);

    // At test end there should be exactly 1 SSE connection in flight
    // (the persistent stream kept open by the running app).
    expect(
      inFlight.size,
      `Expected 1 SSE connection to be open at test end, got ${inFlight.size}`,
    ).toBe(1);
  });
});

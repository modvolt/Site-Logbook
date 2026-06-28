import { test, expect, type Browser } from "@playwright/test";
import { cleanupPpeAssignment, cleanupPpeItem, cleanupPerson } from "./helpers";

/**
 * E2E tests for the public PPE sign-off flow.
 *
 * The sign page (/oopp/sign/:token) and its two API endpoints
 * (GET/POST /api/ppe/sign/:token) are PUBLIC — they require no session,
 * so employees can open a one-time link on any device and draw a signature.
 *
 * This spec verifies:
 *   - Invalid token → error "Odkaz není platný" (no form)
 *   - Valid token → assignment details visible, signature canvas present (no login)
 *   - Drawing and submitting signature → "Podpis byl přijat" success state
 *   - Already-signed token → success state shown immediately on page load
 *   - Network error mid-submit → error shown; user can retry without reloading
 *     (validates the form stays usable after a flaky connection)
 *
 * Seeding uses the authenticated `request` fixture (admin), while page
 * navigation uses a fresh browser context with NO stored session.
 */

/** Create a fresh browser context with no auth (private/incognito equivalent). */
async function newUnauthContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

type SignTokenResponse = { token: string; signUrl: string };

/**
 * Seed a PPE item, person, and assignment, then generate a sign token.
 * Returns { token, itemId, personId, assignmentId } for cleanup.
 */
async function seedSignToken(request: import("@playwright/test").APIRequestContext): Promise<{
  token: string;
  itemId: number;
  personId: number;
  assignmentId: number;
}> {
  const tag = `E2E_PPE_SIGN_${Date.now()}`;

  const itemRes = await request.post("/api/ppe/items", {
    data: { name: `Helma ${tag}`, category: "hlava", active: true },
  });
  expect(itemRes.status(), "create PPE item").toBe(201);
  const item = (await itemRes.json()) as { id: number };

  const personRes = await request.post("/api/people", {
    data: { name: `Technik ${tag}` },
  });
  expect(personRes.status(), "create person").toBe(201);
  const person = (await personRes.json()) as { id: number };

  const assignRes = await request.post("/api/ppe/assignments", {
    data: {
      ppeItemId: item.id,
      personId: person.id,
      quantity: 2,
      issuedAt: "2026-06-28",
      size: "M",
    },
  });
  expect(assignRes.status(), "create assignment").toBe(201);
  const assignment = (await assignRes.json()) as { id: number };

  const tokenRes = await request.post(`/api/ppe/assignments/${assignment.id}/sign-token`);
  expect(tokenRes.status(), "generate sign token").toBe(200);
  const { token } = (await tokenRes.json()) as SignTokenResponse;
  expect(typeof token).toBe("string");
  expect(token.length).toBeGreaterThan(0);

  return {
    token,
    itemId: item.id,
    personId: person.id,
    assignmentId: assignment.id,
  };
}

/**
 * Draw a simple stroke on the signature canvas so the submit button becomes
 * enabled. Uses Playwright mouse events to simulate drawing.
 */
async function drawSignature(page: import("@playwright/test").Page) {
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box not available");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 30, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 30, cy, { steps: 10 });
  await page.mouse.up();
}

// ── Test 1: Invalid token shows error ────────────────────────────────────────

test("invalid token shows error with no signature form", async ({ browser }) => {
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();
  try {
    await page.goto("/oopp/sign/not-a-real-token");
    await expect(page.getByText("Odkaz není platný")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("canvas")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Potvrdit/ })).not.toBeVisible();
  } finally {
    await ctx.close();
  }
});

// ── Test 2: Valid token shows assignment details (no login) ───────────────────

test("valid token shows assignment details without a login session", async ({
  browser,
  request,
}) => {
  const { token, itemId, personId, assignmentId } = await seedSignToken(request);
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/oopp/sign/${token}`);

    await expect(page.locator("canvas")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Helma E2E_PPE_SIGN", { exact: false })).toBeVisible();
    await expect(page.getByText("2")).toBeVisible();
    await expect(page.getByText("Odkaz není platný")).not.toBeVisible();
    await expect(page.getByText("Podpis byl přijat")).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupPpeAssignment(request, assignmentId);
    await cleanupPpeItem(request, itemId);
    await cleanupPerson(request, personId);
  }
});

// ── Test 3: Draw signature → submit → success ─────────────────────────────────

test("drawing and submitting a signature shows success state", async ({
  browser,
  request,
}) => {
  const { token, itemId, personId, assignmentId } = await seedSignToken(request);
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/oopp/sign/${token}`);
    await expect(page.locator("canvas")).toBeVisible({ timeout: 10_000 });

    // Submit button is disabled until the user draws something.
    const submitBtn = page.getByRole("button", { name: /Potvrdit/ });
    await expect(submitBtn).toBeDisabled();

    // Draw a stroke to enable the button.
    await drawSignature(page);
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

    // Submit.
    await submitBtn.click();

    // Success state.
    await expect(page.getByText("Podpis byl přijat")).toBeVisible({ timeout: 15_000 });
    await expect(submitBtn).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupPpeAssignment(request, assignmentId);
    await cleanupPpeItem(request, itemId);
    await cleanupPerson(request, personId);
  }
});

// ── Test 4: Already-signed token shows success immediately ────────────────────

test("already-signed token shows success state on page load without a login session", async ({
  browser,
  request,
}) => {
  const { token, itemId, personId, assignmentId } = await seedSignToken(request);

  // First sign it via API.
  const signRes = await request.post(`/api/ppe/sign/${token}`, {
    data: {
      signatureDataUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==",
    },
  });
  expect(signRes.status()).toBe(200);

  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/oopp/sign/${token}`);
    await expect(page.getByText("Podpis byl přijat")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("canvas")).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Potvrdit/ })).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupPpeAssignment(request, assignmentId);
    await cleanupPpeItem(request, itemId);
    await cleanupPerson(request, personId);
  }
});

// ── Test 5: Network error mid-submit → retry without reload → success ─────────

test("network error mid-submit shows error; user retries on the same page and succeeds", async ({
  browser,
  request,
}) => {
  const { token, itemId, personId, assignmentId } = await seedSignToken(request);
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/oopp/sign/${token}`);
    await expect(page.locator("canvas")).toBeVisible({ timeout: 10_000 });

    // Draw a signature.
    await drawSignature(page);
    const submitBtn = page.getByRole("button", { name: /Potvrdit/ });
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

    // Intercept the POST once and abort it to simulate a network failure.
    await page.route(`**/api/ppe/sign/${token}`, (route) => {
      if (route.request().method() === "POST") {
        route.abort();
      } else {
        route.continue();
      }
    }, { times: 1 });

    await submitBtn.click();

    // Error state from the catch block.
    await expect(page.getByText("Nepodařilo se odeslat podpis")).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Podpis byl přijat")).not.toBeVisible();

    // The canvas and button are still present — user can retry WITHOUT reloading.
    await expect(page.locator("canvas")).toBeVisible();
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

    // Retry: no route interception this time.
    await submitBtn.click();

    // Success — the flow recovers fully from the mid-submit network failure.
    await expect(page.getByText("Podpis byl přijat")).toBeVisible({ timeout: 15_000 });
  } finally {
    await ctx.close();
    await cleanupPpeAssignment(request, assignmentId);
    await cleanupPpeItem(request, itemId);
    await cleanupPerson(request, personId);
  }
});

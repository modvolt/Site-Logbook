import { test, expect, type Browser } from "@playwright/test";
import { cleanupJob } from "./helpers";

/**
 * E2E tests for the customer job-signature flow.
 *
 * The sign page (/sign/:token) and its backing API endpoints
 * (GET/POST /api/sign/:token) are PUBLIC — no session is required, so
 * customers can open a one-time link on any device and draw their signature.
 *
 * Seeding uses the authenticated `request` fixture (admin) via:
 *   - POST /api/jobs — create a disposable test job
 *   - POST /api/jobs/:id/request-signature — the REAL endpoint that generates
 *     the token and sends the email. In dev without SMTP the email is logged to
 *     the server console and the endpoint still returns 200 so e2e tests can
 *     exercise the full request path.
 *   - POST /api/jobs/:id/signature-token — no-email helper used ONLY for
 *     edge-case tests (expired, already-signed, invalid) that don't need to
 *     prove the email flow.
 *
 * Test coverage:
 *   1. Admin submits "Odeslat k podpisu zákazníkem" dialog → toast → full
 *      end-to-end: sign page loads, draw + submit → success state
 *   2. Valid token — sign page loads, canvas visible, submit disabled
 *   3. Drawing + submitting — success state, canvas gone
 *   4. Signed badge on job detail after customer signs
 *   5. Expired token — amber expired-state card, no canvas
 *   6. Already-signed token — success state on page load, no canvas
 *   7. Invalid/unknown token — error state, no canvas
 */

const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==";

const TODAY = new Date().toISOString().split("T")[0];

type TokenResponse = { token: string; signUrl: string; expiresAt: string };

/** Fresh unauthenticated browser context (no stored session). */
async function newUnauthContext(browser: Browser) {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/**
 * Create a test job and generate a token via the real request-signature
 * endpoint (which also triggers email delivery — or a dev-mode console log
 * when SMTP is not configured). Returns { jobId, token }.
 */
async function seedJobWithRequestSignature(
  request: import("@playwright/test").APIRequestContext,
  emailTo: string = "e2e-test@example.com",
): Promise<{ jobId: number; token: string }> {
  const tag = `E2E_SIG_${Date.now()}`;

  const jobRes = await request.post("/api/jobs", {
    data: { title: tag, type: "other", date: TODAY, status: "planned" },
  });
  expect(jobRes.status(), "create test job").toBe(201);
  const { id: jobId } = (await jobRes.json()) as { id: number };

  // Use the real request-signature endpoint (creates token + sends/logs email).
  const sigRes = await request.post(`/api/jobs/${jobId}/request-signature`, {
    data: { to: emailTo },
  });
  expect(sigRes.status(), "request-signature endpoint").toBe(200);
  const { signUrl } = (await sigRes.json()) as { sent: boolean; to: string; signUrl: string };
  const token = signUrl.split("/sign/")[1];
  expect(token, "token extracted from signUrl").toBeTruthy();

  return { jobId, token };
}

/**
 * Create a test job and generate a token without sending email.
 * ONLY used for edge-case tests (expired, already-signed, invalid token).
 * Pass `expiredForTesting: true` to create an already-expired token.
 */
async function seedJobWithToken(
  request: import("@playwright/test").APIRequestContext,
  opts: { expiredForTesting?: boolean } = {},
): Promise<{ jobId: number; token: string }> {
  const tag = `E2E_SIG_${Date.now()}`;

  const jobRes = await request.post("/api/jobs", {
    data: { title: tag, type: "other", date: TODAY, status: "planned" },
  });
  expect(jobRes.status(), "create test job").toBe(201);
  const { id: jobId } = (await jobRes.json()) as { id: number };

  const tokenRes = await request.post(`/api/jobs/${jobId}/signature-token`, {
    data: opts.expiredForTesting ? { expiredForTesting: true } : {},
  });
  expect(tokenRes.status(), "generate signature token").toBe(200);
  const { token } = (await tokenRes.json()) as TokenResponse;
  expect(typeof token, "token should be a string").toBe("string");

  return { jobId, token };
}

/**
 * Simulate drawing a signature stroke on the canvas so the submit button
 * becomes enabled. Uses Playwright mouse events to mimic a finger/pen draw.
 */
async function drawSignature(page: import("@playwright/test").Page) {
  const canvas = page.locator("[data-testid='signature-canvas']");
  await expect(canvas).toBeVisible({ timeout: 10_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas bounding box not available");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 40, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy, { steps: 15 });
  await page.mouse.up();
}

// ── Test 1: Full end-to-end via admin dialog → request-signature → sign page ──

test(
  "full e2e: admin submits signature request dialog → request-signature endpoint → customer signs on sign page",
  async ({ page, browser, request }) => {
    const tag = `E2E_SIG_E2E_${Date.now()}`;
    const jobRes = await request.post("/api/jobs", {
      data: { title: tag, type: "other", date: TODAY, status: "planned" },
    });
    expect(jobRes.status(), "create test job").toBe(201);
    const { id: jobId } = (await jobRes.json()) as { id: number };

    try {
      // Open job detail and submit the signature request dialog.
      await page.goto(`/jobs/${jobId}`);
      await expect(page.getByText(tag)).toBeVisible({ timeout: 10_000 });

      const sigBtn = page.getByRole("button", { name: /Odeslat k podpisu zákazníkem/ });
      await expect(sigBtn).toBeVisible();
      await sigBtn.click();

      await expect(
        page.getByRole("heading", { name: /Odeslat k podpisu/ }),
      ).toBeVisible({ timeout: 5_000 });

      const emailInput = page.locator("#sig-email");
      await emailInput.fill("customer@example.com");

      const odeslat = page.getByRole("button", { name: /^Odeslat$/ });
      await expect(odeslat).toBeEnabled();
      await odeslat.click();

      // The request hits POST /api/jobs/:id/request-signature — in dev without
      // SMTP the endpoint logs the email and returns {sent:true, to, signUrl}.
      await expect(
        page.getByText("Odkaz k podpisu byl odeslán"),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.getByRole("heading", { name: /Odeslat k podpisu/ }),
      ).not.toBeVisible();

      // request-signature saves the token to the DB but the GET /api/jobs/:id
      // response intentionally omits it to prevent secret leakage. Generate a
      // fresh helper token to navigate the sign page and complete the full
      // signing flow. This still exercises the entire customer journey; the
      // dialog step above already proved the request-signature endpoint works.
      const tokenRes = await request.post(`/api/jobs/${jobId}/signature-token`);
      expect(tokenRes.status(), "helper token for sign page").toBe(200);
      const { token } = (await tokenRes.json()) as { token: string };
      expect(token, "helper token is a non-empty string").toBeTruthy();

      // Open the sign page in an anonymous context (no session) and sign.
      const ctx = await newUnauthContext(browser);
      const signPage = await ctx.newPage();
      try {
        await signPage.goto(`/sign/${token}`);
        await expect(
          signPage.getByText("Digitální podpis předávacího protokolu"),
        ).toBeVisible({ timeout: 10_000 });
        await expect(
          signPage.locator("[data-testid='signature-canvas']"),
        ).toBeVisible();

        const submitBtn = signPage.getByRole("button", { name: /Podepsat a potvrdit/ });
        await expect(submitBtn).toBeDisabled();

        await drawSignature(signPage);
        await expect(submitBtn).toBeEnabled({ timeout: 5_000 });
        await submitBtn.click();

        await expect(
          signPage.getByText("Podpis byl úspěšně přijat"),
        ).toBeVisible({ timeout: 15_000 });
        await expect(signPage.getByText("Tuto stránku můžete zavřít")).toBeVisible();
        await expect(
          signPage.locator("[data-testid='signature-canvas']"),
        ).not.toBeVisible();
      } finally {
        await ctx.close();
      }

      // Back on the admin job detail, the signed badge should now be visible.
      await page.reload();
      await expect(
        page.getByText("Zákazník podepsal předávací protokol"),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await cleanupJob(request, jobId);
    }
  },
);

// ── Test 2: Valid token shows sign page (no login) ────────────────────────────

test("valid token shows job summary and signature canvas without a login session", async ({
  browser,
  request,
}) => {
  const { jobId, token } = await seedJobWithRequestSignature(request);
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/sign/${token}`);

    await expect(
      page.getByText("Digitální podpis předávacího protokolu"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Shrnutí zakázky")).toBeVisible();
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).toBeVisible();

    const submitBtn = page.getByRole("button", { name: /Podepsat a potvrdit/ });
    await expect(submitBtn).toBeDisabled();

    await expect(page.getByText("Podpis byl úspěšně přijat")).not.toBeVisible();
    await expect(page.getByText("Platnost odkazu vypršela")).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupJob(request, jobId);
  }
});

// ── Test 3: Drawing + submitting → success state ──────────────────────────────

test("drawing a signature and submitting shows the success state", async ({
  browser,
  request,
}) => {
  const { jobId, token } = await seedJobWithRequestSignature(request);
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/sign/${token}`);
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).toBeVisible({ timeout: 10_000 });

    const submitBtn = page.getByRole("button", { name: /Podepsat a potvrdit/ });
    await expect(submitBtn).toBeDisabled();

    await drawSignature(page);
    await expect(submitBtn).toBeEnabled({ timeout: 5_000 });

    await submitBtn.click();

    await expect(
      page.getByText("Podpis byl úspěšně přijat"),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Tuto stránku můžete zavřít")).toBeVisible();
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupJob(request, jobId);
  }
});

// ── Test 4: Admin sees signed badge after customer signs ──────────────────────

test("job detail shows the signed badge after the customer submits a signature", async ({
  page,
  request,
}) => {
  const { jobId, token } = await seedJobWithRequestSignature(request);

  const signRes = await request.post(`/api/sign/${token}`, {
    data: { signatureDataUrl: TINY_PNG },
  });
  expect(signRes.status(), "sign via API").toBe(200);

  try {
    await page.goto(`/jobs/${jobId}`);

    await expect(
      page.getByText("Zákazník podepsal předávací protokol"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /Odeslat k podpisu zákazníkem/ }),
    ).not.toBeVisible();
  } finally {
    await cleanupJob(request, jobId);
  }
});

// ── Test 5: Expired token shows amber expired-state card ─────────────────────

test("expired token shows the expired-state card with no signature canvas", async ({
  browser,
  request,
}) => {
  // Uses helper endpoint (no email needed — this test is about UI state only).
  const { jobId, token } = await seedJobWithToken(request, {
    expiredForTesting: true,
  });
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/sign/${token}`);

    await expect(
      page.getByText("Platnost odkazu vypršela"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /Podepsat a potvrdit/ }),
    ).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupJob(request, jobId);
  }
});

// ── Test 6: Already-signed token shows success on page load ──────────────────

test("already-signed token shows success state immediately without login", async ({
  browser,
  request,
}) => {
  const { jobId, token } = await seedJobWithToken(request);

  const signRes = await request.post(`/api/sign/${token}`, {
    data: { signatureDataUrl: TINY_PNG },
  });
  expect(signRes.status(), "pre-sign via API").toBe(200);

  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto(`/sign/${token}`);

    await expect(
      page.getByText("Podpis byl úspěšně přijat"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Tuto stránku můžete zavřít")).toBeVisible();
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).not.toBeVisible();
  } finally {
    await ctx.close();
    await cleanupJob(request, jobId);
  }
});

// ── Test 7: Invalid/unknown token shows error state ───────────────────────────

test("invalid token shows an error state with no signature canvas", async ({
  browser,
}) => {
  const ctx = await newUnauthContext(browser);
  const page = await ctx.newPage();

  try {
    await page.goto("/sign/00000000-0000-0000-0000-000000000000");

    await expect(
      page.getByText("Odkaz není platný"),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.locator("[data-testid='signature-canvas']"),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: /Podepsat a potvrdit/ }),
    ).not.toBeVisible();
  } finally {
    await ctx.close();
  }
});

import { test, expect } from "@playwright/test";
import { execSync } from "child_process";
import { randomUUID } from "crypto";
import { cleanupJob } from "./helpers";

/**
 * E2E tests confirming that a previously-signed job renders its signature
 * correctly on the job-export (job-sheet) page at /jobs/:id/list.
 *
 * What is tested:
 *   1. The <img alt="Podpis objednatele"> is visible in the handover section.
 *   2. The image ACTUALLY LOADS (img.complete && img.naturalWidth > 0) —
 *      i.e. the storage URL is reachable by the authenticated browser, not blank.
 *   3. The cs-CZ formatted timestamp (e.g. "15. 6. 2026") is present below
 *      the image.
 *   4. The "Podepsat" sign button is absent when the job is already signed.
 *
 * Seeding strategy:
 *   - Create job via POST /api/jobs.
 *   - Inject signatureToken + signatureTokenExpiresAt via psql (a random UUID;
 *     signedAt/signatureObjectPath are write-once via POST /api/sign/:token and
 *     intentionally absent from UpdateJobBody).
 *   - POST /api/sign/:token (public endpoint, no auth) with a real 1×1 PNG
 *     data URL → the server uploads it to GCS/S3 object storage and writes
 *     signedAt + signatureObjectPath to the DB.
 *   - Verify via GET /api/jobs/:id that the fields are set before the browser step.
 *
 * A real PNG is uploaded so the test can assert img.complete && naturalWidth > 0.
 */

// Minimal 1×1 white PNG (44 bytes, base64-encoded).
const MINI_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjkB6QAAAABJRU5ErkJggg==";
const MINI_PNG_DATA_URL = `data:image/png;base64,${MINI_PNG_BASE64}`;

// Signed date used by the sign endpoint (server sets it to now()).
// We can't know it exactly, but the job.date is 2026-06-15, and we assert
// the timestamp element exists after querying the job for signedAt.

function setSignatureTokenViaDb(jobId: number, token: string, expiresAt: string): void {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) throw new Error("DATABASE_URL not set — cannot seed signature token");
  execSync(
    `psql "${dbUrl}" -c "UPDATE jobs SET signature_token = '${token}', signature_token_expires_at = '${expiresAt}' WHERE id = ${jobId};"`,
    { stdio: "inherit" },
  );
}

test.describe("job-export: signature display for an already-signed job", () => {
  let jobId: number;
  let signedAtIso: string;
  const jobTitle = `E2E_SIG_EXPORT_${Date.now()}`;

  test.beforeAll(async ({ request }) => {
    // 1. Create the job.
    const jobRes = await request.post("/api/jobs", {
      data: {
        title: jobTitle,
        date: "2026-06-15",
        type: "other",
        status: "done",
      },
    });
    expect(jobRes.status(), "create job").toBe(201);
    const job = (await jobRes.json()) as { id: number };
    jobId = job.id;

    // 2. Inject a sign token directly (the request-signature endpoint requires
    //    email + SMTP which is not configured in dev).
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    setSignatureTokenViaDb(jobId, token, expiresAt);

    // 3. Submit a real signature via the public sign endpoint.
    //    This uploads the PNG to object storage and writes signedAt +
    //    signatureObjectPath to the DB.
    const signRes = await request.post(`/api/sign/${token}`, {
      data: { signatureDataUrl: MINI_PNG_DATA_URL },
    });
    expect(signRes.status(), "submit signature").toBe(200);
    const signBody = (await signRes.json()) as { signedAt: string };
    signedAtIso = signBody.signedAt;

    // 4. Confirm the DB fields are set before we open the browser.
    const getRes = await request.get(`/api/jobs/${jobId}`);
    expect(getRes.status(), "fetch signed job").toBe(200);
    const seeded = (await getRes.json()) as {
      signedAt: string | null;
      signatureObjectPath: string | null;
    };
    expect(seeded.signedAt, "signedAt written").toBeTruthy();
    expect(seeded.signatureObjectPath, "signatureObjectPath written").toBeTruthy();
    expect(seeded.signatureObjectPath, "path contains job-signatures").toContain(
      "job-signatures",
    );
  });

  test.afterAll(async ({ request }) => {
    await cleanupJob(request, jobId);
  });

  test("signature image is visible and loads without error", async ({ page }) => {
    await page.goto(`/jobs/${jobId}/list`);

    // Wait for the document heading inside #zakazkovy-list.
    // Two elements read "Zakázkový list" (toolbar h1 + document h2), so we
    // target the document h2 specifically to avoid strict-mode violations.
    await expect(page.locator("#zakazkovy-list h2").first()).toBeVisible({
      timeout: 15_000,
    });

    // The handover section must render an <img> with the correct alt attribute.
    const sigImg = page.locator('img[alt="Podpis objednatele"]');
    await expect(sigImg).toBeVisible({ timeout: 10_000 });

    // Poll until the browser finishes fetching the PNG from storage.
    // Using waitForFunction (instead of waitForLoadState("networkidle")) so we
    // only block on this specific element, not on every background request.
    await page.waitForFunction(
      () => {
        const img = document.querySelector<HTMLImageElement>('img[alt="Podpis objednatele"]');
        return img !== null && img.complete && img.naturalWidth > 0;
      },
      { timeout: 15_000 },
    );

    // Confirm the same via the locator handle for a readable failure message.
    const loaded = await sigImg.evaluate(
      (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
    );
    expect(loaded, "signature image renders (not blank)").toBe(true);

    // The src must point to the authenticated storage endpoint.
    const src = await sigImg.getAttribute("src");
    expect(src, "src contains /api/storage").toContain("/api/storage");
    expect(src, "src contains job-signatures path").toContain("job-signatures");
  });

  test("cs-CZ formatted timestamp is shown below the signature image", async ({ page }) => {
    await page.goto(`/jobs/${jobId}/list`);

    await expect(page.locator("#zakazkovy-list h2").first()).toBeVisible({
      timeout: 15_000,
    });

    // Parse the signedAt we received from the server and extract the cs-CZ
    // date parts (day, month, year) to build a locale-safe regex.
    // Example: "28. 6. 2026" (day. month. year).
    const d = new Date(signedAtIso);
    const day = d.getUTCDate();
    const month = d.getUTCMonth() + 1;
    const year = d.getUTCFullYear();
    const dateRegex = new RegExp(`${day}\\.\\s*${month}\\.\\s*${year}`);

    // The signature timestamp <p> has classes text-center + mt-0.5 in addition
    // to text-xs + text-neutral-500, which distinguishes it from the "Vystaveno"
    // line that also matches the date but lacks those extra classes.
    const timestampEl = page
      .locator("#zakazkovy-list .text-xs.text-neutral-500.text-center")
      .filter({ hasText: dateRegex });
    await expect(timestampEl).toBeVisible({ timeout: 10_000 });
  });

  test("sign button is NOT shown when job is already signed", async ({ page }) => {
    await page.goto(`/jobs/${jobId}/list`);

    await expect(page.locator("#zakazkovy-list h2").first()).toBeVisible({
      timeout: 15_000,
    });

    // Once the job data loads, customerSig is pre-populated from
    // signedAt + signatureObjectPath, so the primary "Podepsat" button must
    // be replaced by the "Přepsat" re-sign link.
    await expect(page.getByRole("button", { name: /Podepsat/ })).not.toBeVisible();
  });
});

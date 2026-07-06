import { test, expect } from "@playwright/test";
import { cleanupJob } from "./helpers";

/**
 * E2E coverage for the "Analyzovat doklady" double-click guard (Task #684).
 *
 * Task #677 made concurrent/duplicate document creation safe at the service
 * layer (`createDocumentSafe`, `analyzeJobDocuments`'s advisory lock) and has
 * a DB-backed unit test that calls the service functions directly
 * (cost-document-sha256-dedup.test.ts). This test drives the same scenario
 * from a real browser: it double-clicks the actual "Analyzovat doklady"
 * button on the job detail page and asserts exactly one billing document
 * (and no error) results, plus fires two truly concurrent HTTP requests at
 * the endpoint the button calls to rule out a network-timing race the
 * client-side `disabled` guard alone might miss.
 */

// A `%`-prefixed line is a PDF comment, so this stays a structurally valid
// minimal PDF while making the sha256 unique per test run — the analyze
// endpoint dedupes by content hash, so identical bytes across test runs
// (or across the two specs below) would otherwise be skipped as duplicates
// of an earlier run's document instead of exercising the double-click guard.
function makeMinimalPdf(uniqueTag: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n%unique-${uniqueTag}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF`,
    "utf-8",
  );
}

async function createJobWithDoklad(
  request: import("@playwright/test").APIRequestContext,
  titleSuffix: string,
): Promise<{ jobId: number }> {
  const today = new Date().toISOString().split("T")[0];
  const jobRes = await request.post("/api/jobs", {
    data: {
      title: `E2E_Test_AnalyzeDoubleClick_${titleSuffix}`,
      type: "other",
      date: today,
      status: "planned",
    },
  });
  expect(jobRes.status(), "job creation must succeed").toBe(201);
  const job = (await jobRes.json()) as { id: number };

  const pdf = makeMinimalPdf(`${titleSuffix}-${Date.now()}-${Math.random()}`);
  const uploadRes = await request.post(
    `/api/storage/uploads?name=doklad-${titleSuffix}.pdf&contentType=application%2Fpdf`,
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(pdf.length),
      },
      data: pdf,
    },
  );
  expect(uploadRes.status(), "raw file upload must succeed").toBe(200);
  const { objectPath } = (await uploadRes.json()) as { objectPath: string };

  const attRes = await request.post(`/api/jobs/${job.id}/attachments`, {
    data: { type: "invoice", fileName: `doklad-${titleSuffix}.pdf`, url: objectPath },
  });
  expect(attRes.status(), "attachment creation must succeed").toBe(201);

  return { jobId: job.id };
}

async function countBillingDocuments(
  request: import("@playwright/test").APIRequestContext,
  jobId: number,
): Promise<number> {
  const res = await request.get(`/api/billing/documents?jobId=${jobId}`);
  expect(res.status()).toBe(200);
  const docs = (await res.json()) as unknown[];
  return docs.length;
}

test.describe("Analyzovat doklady — double-click guard", () => {
  test("UI: double-clicking the button on the job page creates exactly one document", async ({
    page,
    request,
  }) => {
    const { jobId } = await createJobWithDoklad(request, "ui");

    try {
      await page.goto(`/jobs/${jobId}?section=doklady&testMode=1`);
      await expect(
        page.getByText(`E2E_Test_AnalyzeDoubleClick_ui`, { exact: false }),
      ).toBeVisible({ timeout: 15_000 });

      const analyzeBtn = page.getByRole("button", { name: /Analyzovat doklady/ });
      await expect(analyzeBtn).toBeVisible({ timeout: 10_000 });

      // Fire both clicks back-to-back with no awaited gap, mirroring a real
      // accidental double-click before React can commit the `isPending`
      // disabled state.
      await Promise.all([analyzeBtn.click(), analyzeBtn.click({ force: true })]);

      // At least one success toast must appear; no error toast. Both the toast
      // title and a screen-reader aria-live mirror match the text, so scope
      // to the actual toast title element and take the first match.
      await expect(
        page
          .getByTestId("toast-title")
          .filter({ hasText: /Zařazeno ke zpracování|Žádné nové doklady k analýze/ })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("toast-title").filter({ hasText: "Analýza se nezdařila" })).toHaveCount(0);

      // Give any trailing async work (second click, if it landed) time to settle.
      await page.waitForTimeout(1_500);

      const count = await countBillingDocuments(request, jobId);
      expect(count, "double-click must create exactly one billing document, not two").toBe(1);
    } finally {
      await cleanupJob(request, jobId);
    }
  });

  test("API: two truly concurrent requests to the same endpoint the button calls create exactly one document", async ({
    request,
  }) => {
    const { jobId } = await createJobWithDoklad(request, "api");

    try {
      const [a, b] = await Promise.all([
        request.post(`/api/jobs/${jobId}/analyze-documents`),
        request.post(`/api/jobs/${jobId}/analyze-documents`),
      ]);

      expect(a.status(), "first concurrent request must succeed").toBe(200);
      expect(b.status(), "second concurrent request must succeed (not an error)").toBe(200);

      const bodyA = (await a.json()) as { createdCount?: number; skipped?: number };
      const bodyB = (await b.json()) as { createdCount?: number; skipped?: number };
      const totalCreated = (bodyA.createdCount ?? 0) + (bodyB.createdCount ?? 0);
      expect(totalCreated, "exactly one of the two concurrent runs creates the document").toBe(1);

      const count = await countBillingDocuments(request, jobId);
      expect(count, "concurrent requests must create exactly one billing document").toBe(1);
    } finally {
      await cleanupJob(request, jobId);
    }
  });
});

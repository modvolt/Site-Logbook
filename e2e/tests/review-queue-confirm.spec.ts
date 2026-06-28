import { test, expect } from "@playwright/test";

/**
 * E2E coverage for the review-queue bulk-confirm dry-run → confirm dialog flow.
 *
 * Covers:
 *   - POST /api/billing/review-queue/bulk-confirm with dryRun:true returns
 *     a valid BulkReviewDiff shape WITHOUT persisting any changes
 *   - POST /api/billing/review-queue/bulk-confirm with dryRun:false sets
 *     matchConfirmed=true on the selected lines
 *   - UI: "Vybrat vše" → "Potvrdit (N)" opens the ConfirmDiffDialog
 *     with a summary showing total and toConfirm counts
 *   - UI: clicking the dialog's "Potvrdit" button performs the real confirm
 *     and shows a success toast ("Potvrzeno N řádků.")
 *   - UI: the dialog closes after confirmation
 *
 * Data setup: uploads a minimal ISDOC XML document containing one material
 * line. Any line in a "needs_review" document automatically surfaces in the
 * queue (computeReasons adds the "needs_review" reason to every line).
 *
 * Note: bulk-confirm sets matchConfirmed=1 on lines but does NOT necessarily
 * remove them from the queue — lines with persisting reasons (needs_review doc
 * status, missing_warehouse_item, etc.) stay visible. The test therefore checks
 * matchConfirmed state directly rather than asserting the queue shrinks.
 */

const MINIMAL_ISDOC = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice>
  <InvoiceLines>
    <InvoiceLine>
      <ID>1</ID>
      <InvoicedQuantity unitCode="ks">2</InvoicedQuantity>
      <LineExtensionAmount>250.00</LineExtensionAmount>
      <UnitPrice>125.00</UnitPrice>
      <Item>
        <Description>E2E Review Queue Test Material</Description>
      </Item>
    </InvoiceLine>
  </InvoiceLines>
</Invoice>`;

type QueueItem = { lineId: number; documentId: number; matchConfirmed: boolean };
type QueueResponse = { items: QueueItem[]; total: number };
type BulkReviewDiff = {
  total: number;
  toConfirm: number;
  alreadyConfirmed: number;
  priceJumps: number;
  missingJobCount: number;
  missingWarehouseItemCount: number;
  stillUnresolved: number;
  withJobAssigned: number;
  affectedJobIds: number[];
};

/** Upload a minimal ISDOC and return { docId, lineIds }. */
async function seedReviewQueueDoc(
  request: import("@playwright/test").APIRequestContext,
): Promise<{ docId: number; lineIds: number[] }> {
  const xmlBody = Buffer.from(MINIMAL_ISDOC, "utf-8");
  const res = await request.post(
    "/api/billing/documents/upload?name=e2e-rq-test.isdoc&contentType=application%2Fxml",
    {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(xmlBody.length),
      },
      data: xmlBody,
    },
  );
  expect(res.status(), "ISDOC upload must succeed (200 or 201)").toBeLessThan(300);

  const body = (await res.json()) as { document: { id: number; status: string }; lines: Array<{ id: number }> };
  expect(body.document.status).toBe("needs_review");

  const docId = body.document.id;
  const lineIds = body.lines.map((l) => l.id);
  expect(lineIds.length, "ISDOC must create at least one line").toBeGreaterThan(0);

  // Verify lines surface in the review queue before the test uses them.
  const qRes = await request.get("/api/billing/review-queue?pageSize=200");
  expect(qRes.status()).toBe(200);
  const q = (await qRes.json()) as QueueResponse;
  const found = q.items.filter((i) => i.documentId === docId);
  expect(found.length, "seeded lines must appear in review queue").toBeGreaterThan(0);

  return { docId, lineIds: found.map((i) => i.lineId) };
}

test.describe("Review-queue bulk-confirm flow", () => {
  // -------------------------------------------------------------------------
  // API test: dry-run → confirm
  // -------------------------------------------------------------------------

  test.describe("API-level dry-run and confirm", () => {
    let docId = 0;
    let lineIds: number[] = [];

    test.beforeAll(async ({ request }) => {
      ({ docId, lineIds } = await seedReviewQueueDoc(request));
    });

    test.afterAll(async ({ request }) => {
      if (docId) {
        await request.delete(`/api/billing/documents/${docId}`).catch(() => {});
      }
    });

    test("dry-run returns a complete BulkReviewDiff without mutating line state", async ({
      request,
    }) => {
      const res = await request.post("/api/billing/review-queue/bulk-confirm", {
        data: { lineIds, dryRun: true },
      });
      expect(res.status()).toBe(200);

      const diff = (await res.json()) as BulkReviewDiff;

      // Shape validation
      expect(typeof diff.total).toBe("number");
      expect(typeof diff.toConfirm).toBe("number");
      expect(typeof diff.alreadyConfirmed).toBe("number");
      expect(typeof diff.priceJumps).toBe("number");
      expect(typeof diff.missingJobCount).toBe("number");
      expect(typeof diff.missingWarehouseItemCount).toBe("number");
      expect(typeof diff.stillUnresolved).toBe("number");
      expect(typeof diff.withJobAssigned).toBe("number");
      expect(Array.isArray(diff.affectedJobIds)).toBe(true);

      // Our seeded line(s) must be counted
      expect(diff.total).toBeGreaterThanOrEqual(lineIds.length);
      expect(diff.toConfirm).toBeGreaterThanOrEqual(lineIds.length);
      expect(diff.alreadyConfirmed).toBe(0);

      // Dry-run must NOT set matchConfirmed on the line(s)
      const queueAfter = await request.get("/api/billing/review-queue?pageSize=200");
      const qAfter = (await queueAfter.json()) as QueueResponse;
      const myItems = qAfter.items.filter((i) => lineIds.includes(i.lineId));
      expect(myItems.length, "dry-run must not remove lines from queue").toBe(lineIds.length);
      const anyConfirmed = myItems.some((i) => i.matchConfirmed);
      expect(anyConfirmed, "dry-run must not set matchConfirmed on any line").toBe(false);
    });

    test("actual confirm sets matchConfirmed=true on selected lines", async ({
      request,
    }) => {
      expect(lineIds.length, "need seeded line ids").toBeGreaterThan(0);

      const res = await request.post("/api/billing/review-queue/bulk-confirm", {
        data: { lineIds, dryRun: false },
      });
      expect(res.status()).toBe(200);

      const diff = (await res.json()) as BulkReviewDiff;
      // toConfirm reflects how many were newly confirmed
      expect(diff.toConfirm).toBeGreaterThanOrEqual(lineIds.length);
      expect(diff.alreadyConfirmed).toBe(0);

      // A second dry-run on the same IDs must now show alreadyConfirmed = count
      const dryRes = await request.post("/api/billing/review-queue/bulk-confirm", {
        data: { lineIds, dryRun: true },
      });
      expect(dryRes.status()).toBe(200);
      const dryDiff = (await dryRes.json()) as BulkReviewDiff;
      expect(dryDiff.alreadyConfirmed, "re-confirming same lines must show them as already confirmed").toBe(lineIds.length);
      expect(dryDiff.toConfirm, "no new lines to confirm on re-run").toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // UI test: select-all → dry-run dialog → confirm → toast
  // -------------------------------------------------------------------------

  test("UI: select-all → Potvrdit opens diff dialog → dialog confirm shows toast", async ({
    page,
    request,
  }) => {
    // Seed a fresh document so the queue has at least one unconfirmed line.
    const { docId: uiDocId } = await seedReviewQueueDoc(request);

    try {
      // Navigate to the review queue page with testMode (extends toast duration).
      await page.goto("/billing/review-queue?testMode=1");
      await expect(page.getByRole("heading", { name: "K vyřízení" })).toBeVisible({
        timeout: 15_000,
      });

      // Confirm the queue has items (our seed + possibly others).
      const qRes = await request.get("/api/billing/review-queue");
      const q = (await qRes.json()) as QueueResponse;
      test.skip(q.total === 0, "Queue is empty; seeding may have failed — skip");

      // "Vybrat vše" selects all unconfirmed lines on this page.
      const selectAllBtn = page.getByRole("button", { name: /Vybrat vše/i });
      await expect(selectAllBtn).toBeVisible({ timeout: 10_000 });
      await selectAllBtn.click();

      // Bulk-confirm button ("Potvrdit (N)") should appear in the action bar.
      // There may be two buttons with this pattern (toolbar + dialog); target
      // the one in the toolbar (outside any dialog).
      const toolbar = page.locator("[class*='flex'][class*='items-center'][class*='gap']").filter({
        has: page.getByRole("button", { name: /^Potvrdit \(\d+\)/ }),
        hasNot: page.getByRole("dialog"),
      });
      const bulkConfirmBtn = page.getByRole("button", { name: /^Potvrdit \(\d+\)/ }).first();
      await expect(bulkConfirmBtn).toBeVisible({ timeout: 8_000 });

      // Read how many lines are selected (for later assertion).
      const btnLabel = await bulkConfirmBtn.textContent();
      const selectedCount = parseInt((btnLabel ?? "0").match(/\d+/)?.[0] ?? "0", 10);
      expect(selectedCount, "at least one line must be selected").toBeGreaterThan(0);

      // Clicking fires a dry-run POST and opens the ConfirmDiffDialog.
      await bulkConfirmBtn.click();

      // The dialog must open with the heading and description.
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await expect(
        dialog.getByRole("heading", { name: "Hromadné potvrzení", exact: true }),
      ).toBeVisible();
      await expect(dialog.getByText("Souhrn změn, které budou provedeny")).toBeVisible();

      // Diff summary rows must be visible.
      await expect(dialog.getByText("Celkem vybraných")).toBeVisible();
      await expect(dialog.getByText("Ke potvrzení")).toBeVisible();

      // "Ke potvrzení" value must be a positive number.
      const confirmRow = dialog
        .locator("div")
        .filter({ has: dialog.getByText("Ke potvrzení", { exact: true }) })
        .last();
      const confirmValueText = await confirmRow.locator("span.font-medium").last().textContent();
      const confirmValue = parseInt(confirmValueText ?? "0", 10);
      expect(confirmValue, "toConfirm must be > 0 in the dialog").toBeGreaterThan(0);

      // Click the "Potvrdit (N)" button inside the dialog to execute the real confirm.
      const dialogConfirmBtn = dialog.getByRole("button", { name: /^Potvrdit \(\d+\)/ });
      await expect(dialogConfirmBtn).toBeEnabled();
      await dialogConfirmBtn.click();

      // Dialog must close after confirmation.
      await expect(dialog).not.toBeVisible({ timeout: 10_000 });

      // Success toast: "Potvrzeno N řádků." must appear.
      await expect(
        page.getByText(/Potvrzeno \d+ řádků\./, { exact: false }),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      if (uiDocId) {
        await request.delete(`/api/billing/documents/${uiDocId}`).catch(() => {});
      }
    }
  });
});

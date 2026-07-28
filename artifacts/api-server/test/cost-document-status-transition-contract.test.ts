import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../..");

describe("cost-document status transition contract", () => {
  it("does not run material or warehouse reconciliation for an open document marked reviewed", () => {
    const source = readFileSync(
      resolve(root, "artifacts/api-server/src/lib/cost-document-service.ts"),
      "utf8",
    );
    const start = source.indexOf("export async function setDocumentStatus(");
    const end = source.indexOf(
      "async function removeWarehousePriceHistoryForDocument(",
      start,
    );
    const handler = source.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(handler).toMatch(
      /if \(currentDoc\.status === "approved"\) \{[\s\S]*await syncJobMaterialsForDocument\(tx, id, actor\);[\s\S]*await reconcileDocumentStockMovements\(tx, id, actor\);[\s\S]*\}/,
    );
  });
});

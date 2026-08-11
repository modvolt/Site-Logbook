import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_WRITE_SEAM_INVENTORY_V1,
  type AccountingWriteSymbol,
} from "../src/lib/accounting-write-seam-policy";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("../src", import.meta.url)));

const SYMBOLS: readonly AccountingWriteSymbol[] = [
  "issueInvoice",
  "cancelInvoice",
  "updateInvoiceStatus",
  "confirmBankPayments",
  "approveDocument",
  "updateWarehousePricesFromDocument",
  "disposeCostDocument",
  "setDocumentStatus",
  "updateDocument",
  "updateLine",
  "splitLine",
  "deleteDocument",
  "addReference",
  "updateReference",
  "deleteReference",
  "setDocumentDeliveryNoteResolution",
  "applyAiSuggestion",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

function count(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function key(value: { file: string; symbol: string }): string {
  return `${value.file}|${value.symbol}`;
}

function scannedInventory() {
  return sourceFiles(SOURCE_ROOT)
    .flatMap((file) => {
      const source = withoutComments(readFileSync(file, "utf8"));
      const relativeFile = relative(SOURCE_ROOT, file).replaceAll("\\", "/");
      return SYMBOLS.flatMap((symbol) => {
        const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const invocation = new RegExp(`\\b${escaped}\\s*\\(`, "g");
        const declaration = new RegExp(
          `\\b(?:async\\s+)?function\\s+${escaped}\\s*\\(`,
          "g",
        );
        const occurrences =
          count(source, invocation) - count(source, declaration);
        return occurrences > 0
          ? [{ file: relativeFile, symbol, occurrences }]
          : [];
      });
    })
    .sort((left, right) => key(left).localeCompare(key(right)));
}

function normalizedInventory() {
  return ACCOUNTING_WRITE_SEAM_INVENTORY_V1.map((entry) => ({
    file: entry.file,
    symbol: entry.symbol,
    occurrences: entry.occurrences,
  })).sort((left, right) => key(left).localeCompare(key(right)));
}

describe("accounting write seam inventory", () => {
  it("matches every registered accounting writer invocation", () => {
    expect(scannedInventory()).toEqual(normalizedInventory());
  });

  it("keeps terminal accounting writes behind feature-flagged atomic persistence seams", () => {
    const terminal = ACCOUNTING_WRITE_SEAM_INVENTORY_V1.filter((entry) =>
      ["issue-or-approve", "lifecycle", "payment"].includes(entry.boundary),
    );
    expect(terminal).toHaveLength(7);
    const atomic = terminal.filter((entry) =>
      [
        "issueInvoice",
        "cancelInvoice",
        "updateInvoiceStatus",
        "confirmBankPayments",
        "approveDocument",
      ].includes(entry.symbol),
    );
    expect(atomic).toHaveLength(5);
    for (const entry of atomic) {
      expect(entry.currentControl).toMatch(
        /^feature-flagged-(?:version|lifecycle)-event-outbox$/,
      );
    }
    expect(terminal.filter((entry) => !atomic.includes(entry))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "disposeCostDocument",
          currentControl:
            "split-operational-discard-feature-flagged-reviewed-version-event-outbox",
          requiredPersistence: "version-event-outbox",
        }),
        expect.objectContaining({
          symbol: "setDocumentStatus",
          currentControl: "mixed-feature-flagged-reopen-unpersisted-ignore",
          requiredPersistence: "lifecycle-event-outbox",
        }),
      ]),
    );
  });

  it("locks the exact R13-D1 coverage totals and classifications", () => {
    const keys = ACCOUNTING_WRITE_SEAM_INVENTORY_V1.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ACCOUNTING_WRITE_SEAM_INVENTORY_V1).toHaveLength(17);
    expect(
      ACCOUNTING_WRITE_SEAM_INVENTORY_V1.filter(
        (entry) => entry.currentControl === "row-locked-approved-content-guard",
      ),
    ).toHaveLength(8);
    expect(
      ACCOUNTING_WRITE_SEAM_INVENTORY_V1.filter(
        (entry) => entry.currentControl === "row-locked-terminal-content-guard",
      ),
    ).toHaveLength(1);
    expect(
      ACCOUNTING_WRITE_SEAM_INVENTORY_V1.reduce(
        (sum, entry) => sum + entry.occurrences,
        0,
      ),
    ).toBe(17);
    expect(ACCOUNTING_WRITE_SEAM_INVENTORY_V1).toContainEqual(
      expect.objectContaining({
        symbol: "updateWarehousePricesFromDocument",
        boundary: "price",
        currentControl: "feature-flagged-price-observation-outbox",
        requiredPersistence: "warehouse-price-observation-outbox",
      }),
    );
  });

  it("keeps header edits and forced AI behind row-locked approved/terminal guards", () => {
    const service = readFileSync(
      resolve(SOURCE_ROOT, "lib/cost-document-service.ts"),
      "utf8",
    );
    const updateHeader = service.slice(
      service.indexOf("export async function updateDocument"),
      service.indexOf("// Line operations (matching / splitting)"),
    );
    expect(updateHeader).toContain("await db.transaction(async (tx) =>");
    expect(updateHeader).toContain('.for("update")');
    expect(updateHeader.indexOf('.for("update")')).toBeLessThan(
      updateHeader.indexOf('doc.status === "approved"'),
    );
    expect(updateHeader).toContain("await tx");
    expect(updateHeader).not.toMatch(/await\s+db\s*\.update/);

    const aiSuggestion = service.slice(
      service.indexOf("export async function applyAiSuggestion"),
      service.indexOf("export async function listReviewQueue"),
    );
    expect(aiSuggestion).toMatch(/for update/i);
    expect(aiSuggestion).toContain(
      "AI_SUGGESTION_TERMINAL_STATUSES.has(doc.status)",
    );
    expect(
      aiSuggestion.indexOf("AI_SUGGESTION_TERMINAL_STATUSES"),
    ).toBeLessThan(aiSuggestion.indexOf(".update(billingDocumentsTable)"));

    const worker = readFileSync(
      resolve(SOURCE_ROOT, "lib/extraction-worker.ts"),
      "utf8",
    );
    const moveToReview = worker.slice(
      worker.indexOf("async function moveDocumentToNeedsReview"),
      worker.indexOf("async function processOne"),
    );
    expect(moveToReview).toContain("db.transaction");
    expect(moveToReview).toContain('.for("update")');
    expect(moveToReview).toContain(
      "TERMINAL_DOC_STATUSES.has(document.status)",
    );
    expect(worker).not.toContain("setDocumentStatus");
    expect(worker).toContain(
      'const forcedDuplicate = job.force === true && doc.status === "duplicate"',
    );
    expect(worker).toContain(
      "TERMINAL_DOC_STATUSES.has(doc.status) && !forcedDuplicate",
    );
  });
});

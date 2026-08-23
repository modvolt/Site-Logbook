import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  readFileSync(resolve(workspaceRoot, path), "utf8").replace(/\r\n/g, "\n");

describe("invoice customer presentation contract", () => {
  const service = read("artifacts/api-server/src/lib/invoice-service.ts");
  const editor = read("artifacts/stavba/src/pages/billing-invoice-edit.tsx");

  it("keeps operational allocations intact during line and presentation edits", () => {
    const sourceReplacement = service.slice(
      service.indexOf("if (input.lines !== undefined)"),
      service.indexOf("} else if (\n      input.vatModeDefault"),
    );
    const presentationUpdate = service.slice(
      service.indexOf("if (\n      input.materialDisplayMode !== undefined"),
      service.indexOf("  });\n  return getInvoiceDetail(id);"),
    );

    expect(sourceReplacement).toContain("syncDraftLines");
    expect(sourceReplacement).toContain("invoiceSourceAllocationsTable");
    expect(sourceReplacement).toContain("raw source records");
    expect(sourceReplacement).not.toContain("releaseInvoicedLines(tx, id)");
    expect(sourceReplacement).not.toContain("releaseInvoicedMaterials(tx, id)");
    expect(presentationUpdate).toContain("encodeInvoicePresentation");
    expect(presentationUpdate).not.toContain("releaseInvoicedLines");
    expect(presentationUpdate).not.toContain("releaseInvoicedMaterials");
    expect(presentationUpdate).not.toContain("delete(invoiceLinesTable)");
  });

  it("sends source lines only after a real source edit", () => {
    expect(editor).toContain("...(linesDirty ? { lines } : {})");
    expect(editor).toContain(
      'materialDisplayMode === "custom" ? { presentationGroups } : {}',
    );
    expect(editor).not.toContain(
      "notes: header.notes.trim() || null,\n          lines,",
    );
  });

  it("retains stable line ids and makes removed-source settlement explicit", () => {
    expect(service).toContain("existingId: l.id ?? null");
    expect(service).toContain("forcedSettlementAllocationIds");
    expect(service).toContain("přišel o svou položku");
    expect(editor).toContain("id: r.lineId");
    expect(editor).toContain("Zdrojová data zůstala zachována");
    expect(editor).toContain('"included_in_lump_sum"');
    expect(editor).toContain('"deferred"');
  });

  it("uses the stored custom envelope for both detail and PDF projection", () => {
    expect(
      service.match(
        /presentInvoiceLines\(\s*lines,\s*invoice\.materialDisplayMode,?\s*\)/g,
      ),
    ).toHaveLength(2);
  });
});

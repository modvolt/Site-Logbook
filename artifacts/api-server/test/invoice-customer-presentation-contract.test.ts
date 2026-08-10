import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const read = (path: string) =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

describe("invoice customer presentation contract", () => {
  const service = read("artifacts/api-server/src/lib/invoice-service.ts");
  const editor = read("artifacts/stavba/src/pages/billing-invoice-edit.tsx");

  it("keeps presentation-only saves out of the source replacement branch", () => {
    const sourceReplacement = service.slice(
      service.indexOf("if (input.lines !== undefined)"),
      service.indexOf("} else if (\n      input.vatModeDefault"),
    );
    const presentationUpdate = service.slice(
      service.indexOf("if (\n      input.materialDisplayMode !== undefined"),
      service.indexOf("  });\n  return getInvoiceDetail(id);"),
    );

    expect(sourceReplacement).toContain("releaseInvoicedLines(tx, id)");
    expect(sourceReplacement).toContain("releaseInvoicedMaterials(tx, id)");
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
    expect(editor).not.toContain("notes: header.notes.trim() || null,\n          lines,");
  });

  it("uses the stored custom envelope for both detail and PDF projection", () => {
    expect(
      service.match(
        /presentInvoiceLines\(\s*lines,\s*invoice\.materialDisplayMode,?\s*\)/g,
      ),
    ).toHaveLength(2);
  });
});

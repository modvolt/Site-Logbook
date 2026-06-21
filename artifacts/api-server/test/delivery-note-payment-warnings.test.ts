import { describe, expect, it } from "vitest";
import {
  DEFAULT_SYSTEM_PROMPT,
  normalizeResult,
  type ExtractionResult,
} from "../src/lib/openai-extraction.js";

function baseResult(overrides: Partial<ExtractionResult>): ExtractionResult {
  return {
    docType: "delivery_note",
    supplierName: null,
    supplierIc: null,
    supplierDic: null,
    supplierAddress: null,
    documentNumber: null,
    variableSymbol: null,
    issueDate: null,
    taxableSupplyDate: null,
    dueDate: null,
    currency: "CZK",
    subtotalWithoutVat: null,
    totalVat: null,
    totalWithVat: null,
    bankAccount: null,
    iban: null,
    constantSymbol: null,
    orderNumber: null,
    relatedDocuments: [],
    lines: [],
    confidence: 0.9,
    warnings: [],
    ...overrides,
  };
}

describe("DEFAULT_SYSTEM_PROMPT delivery-note rule", () => {
  it("instructs the model not to warn about missing payment fields on delivery notes", () => {
    const lower = DEFAULT_SYSTEM_PROMPT.toLowerCase();
    expect(lower).toContain("delivery_note");
    // The rule explicitly tells the model to skip variable symbol, due date
    // and amount-to-pay warnings on delivery notes.
    expect(lower).toContain("variabilní symbol");
    expect(lower).toContain("datum splatnosti");
    expect(lower).toContain("k úhradě");
  });
});

describe("normalizeResult on delivery notes", () => {
  it("does not add payment-field warnings of its own", () => {
    const result = normalizeResult(baseResult({}), 0.7);
    expect(result.warnings).toEqual([]);
  });

  it("preserves only the warnings the model returned", () => {
    const result = normalizeResult(
      baseResult({ warnings: ["Dodavatel je nečitelný"] }),
      0.7,
    );
    expect(result.warnings).toEqual(["Dodavatel je nečitelný"]);
  });
});

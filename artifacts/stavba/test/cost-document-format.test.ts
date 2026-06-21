import { describe, expect, it } from "vitest";
import {
  filterWarningsForDocType,
  isPaymentDocument,
} from "../src/lib/cost-document-format";

const PAYMENT_FIELD_WARNINGS = [
  "Chybí variabilní symbol",
  "Nečitelné datum splatnosti",
  "Chybí částka k úhradě (s DPH)",
];

const NON_PAYMENT_WARNINGS = [
  "Dodavatel je nečitelný",
  "Položka 3 má nejasné množství",
];

describe("isPaymentDocument", () => {
  it("returns false only for delivery notes", () => {
    expect(isPaymentDocument("delivery_note")).toBe(false);
  });

  it("returns true for every other document type", () => {
    expect(isPaymentDocument("invoice")).toBe(true);
    expect(isPaymentDocument("receipt")).toBe(true);
    expect(isPaymentDocument("credit_note")).toBe(true);
  });

  it("treats unknown / missing types as payment documents", () => {
    expect(isPaymentDocument(null)).toBe(true);
    expect(isPaymentDocument(undefined)).toBe(true);
    expect(isPaymentDocument("")).toBe(true);
    expect(isPaymentDocument("something_else")).toBe(true);
  });
});

describe("filterWarningsForDocType", () => {
  it("strips payment-field warnings for delivery notes", () => {
    const result = filterWarningsForDocType(
      PAYMENT_FIELD_WARNINGS,
      "delivery_note",
    );
    expect(result).toEqual([]);
  });

  it("keeps non-payment warnings for delivery notes", () => {
    const result = filterWarningsForDocType(
      [...PAYMENT_FIELD_WARNINGS, ...NON_PAYMENT_WARNINGS],
      "delivery_note",
    );
    expect(result).toEqual(NON_PAYMENT_WARNINGS);
  });

  it("keeps payment-field warnings for invoices", () => {
    const result = filterWarningsForDocType(PAYMENT_FIELD_WARNINGS, "invoice");
    expect(result).toEqual(PAYMENT_FIELD_WARNINGS);
  });

  it("keeps payment-field warnings for receipts", () => {
    const result = filterWarningsForDocType(PAYMENT_FIELD_WARNINGS, "receipt");
    expect(result).toEqual(PAYMENT_FIELD_WARNINGS);
  });

  it("keeps payment-field warnings for credit notes", () => {
    const result = filterWarningsForDocType(
      PAYMENT_FIELD_WARNINGS,
      "credit_note",
    );
    expect(result).toEqual(PAYMENT_FIELD_WARNINGS);
  });

  it("keeps payment-field warnings for unknown / missing types", () => {
    expect(filterWarningsForDocType(PAYMENT_FIELD_WARNINGS, null)).toEqual(
      PAYMENT_FIELD_WARNINGS,
    );
    expect(filterWarningsForDocType(PAYMENT_FIELD_WARNINGS, undefined)).toEqual(
      PAYMENT_FIELD_WARNINGS,
    );
  });

  it("matches payment hints case-insensitively", () => {
    const result = filterWarningsForDocType(
      ["CHYBÍ VARIABILNÍ SYMBOL", "Datum SPLATNOSTI nečitelné"],
      "delivery_note",
    );
    expect(result).toEqual([]);
  });

  it("returns an empty array unchanged", () => {
    expect(filterWarningsForDocType([], "delivery_note")).toEqual([]);
    expect(filterWarningsForDocType([], "invoice")).toEqual([]);
  });
});

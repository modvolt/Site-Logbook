import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  canDirectlyCancelInvoiceStatus,
  INVOICE_CANCELLATION_REASONS,
} from "../src/lib/invoice-cancellation";

const detailSource = readFileSync(
  new URL("../src/pages/billing-invoice-detail.tsx", import.meta.url),
  "utf8",
);

describe("invoice cancellation containment", () => {
  it("offers only the registered bounded cancellation reasons", () => {
    expect(INVOICE_CANCELLATION_REASONS.map(({ value }) => value)).toEqual([
      "customer_complaint",
      "incorrect_job",
      "billing_error",
      "duplicate_invoice",
      "order_cancelled",
    ]);
    expect(
      new Set(INVOICE_CANCELLATION_REASONS.map(({ label }) => label)).size,
    ).toBe(INVOICE_CANCELLATION_REASONS.length);
  });

  it("never exposes direct cancellation for a paid invoice", () => {
    expect(canDirectlyCancelInvoiceStatus("issued")).toBe(true);
    expect(canDirectlyCancelInvoiceStatus("sent")).toBe(true);
    expect(canDirectlyCancelInvoiceStatus("paid")).toBe(false);
    expect(canDirectlyCancelInvoiceStatus("cancelled")).toBe(false);
    expect(canDirectlyCancelInvoiceStatus("draft")).toBe(false);
  });

  it("wires the registered reason and paid-state guards into the invoice detail", () => {
    expect(detailSource).toContain("reasonCode: cancelReasonCode");
    expect(detailSource).toContain(
      "canDirectlyCancelInvoiceStatus(inv.status)",
    );
    expect(detailSource).toContain('inv.status !== "paid"');
    expect(detailSource).toContain("Vyberte povinný důvod storna.");
  });
});

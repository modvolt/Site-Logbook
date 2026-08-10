import { describe, expect, it } from "vitest";
import {
  buildBillingLocation,
  clearBillingScroll,
  readBillingReturnTo,
  readBillingScroll,
  sanitizeBillingReturnTo,
  saveBillingScroll,
  withBillingReturnTo,
} from "../src/lib/billing-navigation";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("billing return navigation", () => {
  it("keeps the complete list query in the detail return target", () => {
    const list = buildBillingLocation(
      "/billing/documents",
      "docType=invoice&status=needs_review",
    );

    const detail = withBillingReturnTo("/billing/documents/42", list);

    expect(detail).toBe(
      "/billing/documents/42?returnTo=%2Fbilling%2Fdocuments%3FdocType%3Dinvoice%26status%3Dneeds_review",
    );
    expect(
      readBillingReturnTo(detail.split("?")[1], "/billing/documents"),
    ).toBe(list);
  });

  it("preserves an existing target query while adding the return target", () => {
    expect(
      withBillingReturnTo(
        "/billing/invoices/7?preview=1",
        "/billing/invoices?status=overdue",
      ),
    ).toBe(
      "/billing/invoices/7?preview=1&returnTo=%2Fbilling%2Finvoices%3Fstatus%3Doverdue",
    );
  });

  it("rejects external, protocol-relative and non-billing return targets", () => {
    const fallback = "/billing/invoices";
    expect(sanitizeBillingReturnTo("https://example.com", fallback)).toBe(
      fallback,
    );
    expect(sanitizeBillingReturnTo("//example.com/billing", fallback)).toBe(
      fallback,
    );
    expect(sanitizeBillingReturnTo("/jobs/12", fallback)).toBe(fallback);
  });

  it("accepts nested billing details as a safe return target", () => {
    const nested =
      "/billing/recurring-templates/3?returnTo=%2Fbilling%2Frecurring-templates";
    expect(sanitizeBillingReturnTo(nested, "/billing")).toBe(nested);
  });
});

describe("billing list scroll snapshots", () => {
  it("stores, reads and clears an exact list position", () => {
    const storage = new MemoryStorage();
    const location = "/billing/invoices?status=overdue";

    saveBillingScroll(storage, location, 812.4, 1_000);
    expect(readBillingScroll(storage, location, 2_000)).toBe(812);

    clearBillingScroll(storage, location);
    expect(readBillingScroll(storage, location, 2_000)).toBeNull();
  });

  it("expires stale and malformed snapshots without throwing", () => {
    const storage = new MemoryStorage();
    const location = "/billing/documents";
    saveBillingScroll(storage, location, 250, 1_000);

    expect(readBillingScroll(storage, location, 20_000_000)).toBeNull();
    storage.setItem("stavba:billing-scroll:%2Fbilling%2Fdocuments", "not-json");
    expect(readBillingScroll(storage, location, 20_000_001)).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { UpdateActivityBody } from "@workspace/api-zod";

/**
 * Invariant: an activity can never be marked billed by a client.
 *
 * The PATCH /api/activities/:id handler validates its body with the
 * `UpdateActivityBody` Zod schema before touching the database. The only
 * editable billing intents are `billable`, `not_billable`, and null — the
 * authoritative "billed" state is derived solely from the invoice link
 * (invoice_source_links / billedInvoiceId) and is set server-side by
 * invoice-service when an invoice is issued (cleared on storno).
 *
 * These tests pin the schema so another client or a future refactor can't
 * silently re-open a manual `billingStatus: "billed"` write path. They run as a
 * pure unit test against the generated validator (no DB) — the legitimate
 * issue/storno path that flips and clears the cosmetic flag is covered by
 * activity-invoice-double-bill.test.ts.
 */

describe("UpdateActivityBody billingStatus validator", () => {
  it("rejects a manual billingStatus: \"billed\" (the PATCH handler returns 400)", () => {
    const result = UpdateActivityBody.safeParse({ billingStatus: "billed" });
    expect(result.success).toBe(false);
  });

  it("accepts billingStatus: \"billable\"", () => {
    const result = UpdateActivityBody.safeParse({ billingStatus: "billable" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.billingStatus).toBe("billable");
  });

  it("accepts billingStatus: \"not_billable\"", () => {
    const result = UpdateActivityBody.safeParse({ billingStatus: "not_billable" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.billingStatus).toBe("not_billable");
  });

  it("accepts billingStatus: null (untracked)", () => {
    const result = UpdateActivityBody.safeParse({ billingStatus: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.billingStatus).toBeNull();
  });

  it("accepts an omitted billingStatus (other fields can be updated alone)", () => {
    const result = UpdateActivityBody.safeParse({ name: "Akce" });
    expect(result.success).toBe(true);
  });

  it("rejects an arbitrary unknown billingStatus value", () => {
    const result = UpdateActivityBody.safeParse({ billingStatus: "paid" });
    expect(result.success).toBe(false);
  });
});

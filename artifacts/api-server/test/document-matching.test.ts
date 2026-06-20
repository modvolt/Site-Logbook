import { describe, it, expect } from "vitest";
import {
  strengthFromScore,
  scoreDeliveryNoteToInvoice,
  scoreReferenceToJob,
  rankJobsForReference,
  type MatchableDocument,
  type MatchableJob,
} from "../src/lib/document-matching";

/**
 * Tests for the deterministic scoring helpers linking delivery notes ↔ invoices
 * ↔ jobs. Scores only order candidates; nothing is auto-confirmed.
 */

describe("strengthFromScore", () => {
  it("buckets scores into strong / medium / weak / none", () => {
    expect(strengthFromScore(0.9)).toBe("strong");
    expect(strengthFromScore(0.8)).toBe("strong");
    expect(strengthFromScore(0.6)).toBe("medium");
    expect(strengthFromScore(0.1)).toBe("weak");
    expect(strengthFromScore(0)).toBe("none");
  });
});

describe("scoreDeliveryNoteToInvoice", () => {
  it("hard-fails on different supplier IČO", () => {
    const dn: MatchableDocument = { supplierIc: "111", deliveryNoteNumber: "DL1" };
    const inv: MatchableDocument = {
      supplierIc: "222",
      references: [{ referenceType: "delivery_note", referenceNumber: "DL1" }],
    };
    const r = scoreDeliveryNoteToInvoice(dn, inv);
    expect(r.score).toBe(0);
    expect(r.strength).toBe("none");
  });

  it("scores strongly when the invoice references the delivery-note number", () => {
    const dn: MatchableDocument = {
      supplierIc: "12345678",
      deliveryNoteNumber: "DL2024001",
      totalWithoutVat: 1000,
      issueDate: "2024-05-01",
    };
    const inv: MatchableDocument = {
      supplierIc: "12345678",
      totalWithoutVat: 1000,
      issueDate: "2024-05-05",
      references: [
        { referenceType: "delivery_note", referenceNumber: "DL2024001" },
      ],
    };
    const r = scoreDeliveryNoteToInvoice(dn, inv);
    expect(r.score).toBeGreaterThanOrEqual(0.8);
    expect(r.strength).toBe("strong");
    expect(r.reasons).toContain("Faktura odkazuje číslo dodacího listu");
  });

  it("gives a weak/medium score on shared order number alone", () => {
    const dn: MatchableDocument = { orderNumber: "OBJ-1" };
    const inv: MatchableDocument = { orderNumber: "OBJ-1" };
    const r = scoreDeliveryNoteToInvoice(dn, inv);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reasons).toContain("Shodné číslo objednávky");
  });
});

describe("scoreReferenceToJob / rankJobsForReference", () => {
  const jobs: MatchableJob[] = [
    { id: 1, title: "Rekonstrukce ZAK-2024-12", customerId: 7 },
    { id: 2, title: "Jiná zakázka", notes: "nesouvisí" },
    { id: 3, title: "Stavba", address: "ZAK-2024-12 ulice" },
  ];

  it("matches a reference number found in the job title", () => {
    const r = scoreReferenceToJob("ZAK-2024-12", jobs[0]);
    expect(r.score).toBeGreaterThan(0);
    expect(r.reasons[0]).toContain("názvu zakázky");
  });

  it("boosts the score when the customer matches", () => {
    const without = scoreReferenceToJob("ZAK-2024-12", jobs[0]);
    const withCust = scoreReferenceToJob("ZAK-2024-12", jobs[0], {
      documentCustomerId: 7,
    });
    expect(withCust.score).toBeGreaterThan(without.score);
    expect(withCust.reasons).toContain("Shodný zákazník");
  });

  it("ranks matching jobs strongest-first and drops non-matches", () => {
    const ranked = rankJobsForReference("ZAK-2024-12", jobs);
    expect(ranked.map((c) => c.job.id)).toEqual([1, 3]);
    expect(ranked[0].match.score).toBeGreaterThanOrEqual(ranked[1].match.score);
  });

  it("returns no candidates for an unknown reference", () => {
    expect(rankJobsForReference("NEEXISTUJE-999", jobs)).toEqual([]);
  });
});

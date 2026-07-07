import { describe, it, expect } from "vitest";
import {
  strengthFromScore,
  scoreDeliveryNoteToInvoice,
  scoreDocumentSimilarity,
  scoreReferenceToJob,
  rankJobsForReference,
  selectAutomaticDocumentMatches,
  type MatchableDocument,
  type MatchableLine,
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

  it("keeps a strong match when an invoice arrives a week later", () => {
    const result = scoreDeliveryNoteToInvoice(
      {
        supplierIc: "12345678",
        documentNumber: "DL-2026-071",
        issueDate: "2026-07-01",
      },
      {
        supplierIc: "12345678",
        issueDate: "2026-07-08",
        references: [
          { referenceType: "delivery_note", referenceNumber: "DL-2026-071" },
        ],
      },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps an explicit delivery-note match even after two months", () => {
    const result = scoreDeliveryNoteToInvoice(
      {
        supplierIc: "12345678",
        documentNumber: "DL-2026-071",
        issueDate: "2026-07-01",
      },
      {
        supplierIc: "12345678",
        issueDate: "2026-09-01",
        references: [
          { referenceType: "delivery_note", referenceNumber: "DL-2026-071" },
        ],
      },
    );
    expect(result.score).toBeGreaterThanOrEqual(0.7);
  });
});

describe("selectAutomaticDocumentMatches", () => {
  it("keeps multiple explicitly referenced delivery notes", () => {
    const selected = selectAutomaticDocumentMatches(
      [
        { documentId: 10, score: 0.95, exactReferenceMatch: true },
        { documentId: 11, score: 0.9, exactReferenceMatch: true },
        { documentId: 12, score: 0.85, exactReferenceMatch: false },
      ],
      0.6,
    );
    expect(selected.map((candidate) => candidate.documentId)).toEqual([10, 11]);
  });

  it("rejects similarly scored candidates without an exact reference", () => {
    expect(
      selectAutomaticDocumentMatches(
        [
          { documentId: 10, score: 0.8, exactReferenceMatch: false },
          { documentId: 11, score: 0.78, exactReferenceMatch: false },
        ],
        0.6,
      ),
    ).toEqual([]);
  });

  it("accepts one unambiguous candidate above the threshold", () => {
    expect(
      selectAutomaticDocumentMatches(
        [
          { documentId: 10, score: 0.85, exactReferenceMatch: false },
          { documentId: 11, score: 0.65, exactReferenceMatch: false },
        ],
        0.6,
      ).map((candidate) => candidate.documentId),
    ).toEqual([10]);
  });
});

describe("scoreDocumentSimilarity", () => {
  it("hard-fails on different supplier IČO", () => {
    const a: MatchableDocument = { supplierIc: "111" };
    const b: MatchableDocument = { supplierIc: "222" };
    const r = scoreDocumentSimilarity(a, b);
    expect(r.score).toBe(0);
    expect(r.strength).toBe("none");
  });

  it("never guesses a match when either side lacks a supplier IČO", () => {
    const a: MatchableDocument = { supplierIc: null, totalWithVat: 1000, issueDate: "2024-05-01" };
    const b: MatchableDocument = { supplierIc: "12345678", totalWithVat: 1000, issueDate: "2024-05-01" };
    const r = scoreDocumentSimilarity(a, b);
    expect(r.score).toBe(0);
  });

  it("scores high (auto-merge range) for same IČO, total, date, and matching lines", () => {
    const lines: MatchableLine[] = [
      { description: "Cement 25kg" },
      { description: "Trubka PVC" },
    ];
    const a: MatchableDocument & { lines: MatchableLine[] } = {
      supplierIc: "12345678",
      totalWithVat: 1815,
      issueDate: "2024-05-01",
      lines,
    };
    const b: MatchableDocument & { lines: MatchableLine[] } = {
      supplierIc: "12345678",
      totalWithVat: 1815,
      issueDate: "2024-05-01",
      lines,
    };
    const r = scoreDocumentSimilarity(a, b);
    expect(r.score).toBeGreaterThanOrEqual(0.85);
    expect(r.strength).toBe("strong");
  });

  it("scores in the middling (needs-review) range with no line overlap", () => {
    const a: MatchableDocument & { lines: MatchableLine[] } = {
      supplierIc: "12345678",
      totalWithVat: 2000,
      issueDate: "2024-06-01",
      lines: [{ description: "Sádrokarton" }],
    };
    const b: MatchableDocument & { lines: MatchableLine[] } = {
      supplierIc: "12345678",
      totalWithVat: 2000,
      issueDate: "2024-06-01",
      lines: [{ description: "Úplně jiná položka XYZ" }],
    };
    const r = scoreDocumentSimilarity(a, b);
    expect(r.score).toBeGreaterThanOrEqual(0.55);
    expect(r.score).toBeLessThan(0.85);
  });

  it("scores low when only the IČO matches (different total/date, no lines)", () => {
    const a: MatchableDocument = { supplierIc: "12345678", totalWithVat: 100, issueDate: "2024-01-01" };
    const b: MatchableDocument = { supplierIc: "12345678", totalWithVat: 9999, issueDate: "2024-09-09" };
    const r = scoreDocumentSimilarity(a, b);
    expect(r.score).toBeLessThan(0.55);
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

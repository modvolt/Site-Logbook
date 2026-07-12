import { describe, it, expect } from "vitest";
import { isProtectedObjectPath } from "../src/routes/storage";

// Regression guard for the broken-access-control (IDOR) fix: the generic
// `GET /api/storage/objects/*` route is reachable by ANY authenticated user
// (including guests), so admin-only sensitive objects must be treated as
// nonexistent there. Invoice PDFs live under a path guessable from the invoice
// number (`invoices/<number>.pdf`); without this guard a non-admin could
// download them directly, bypassing the admin-gated billing endpoint.
describe("isProtectedObjectPath (generic /storage/objects/* guard)", () => {
  it("blocks issued invoice PDFs (path is guessable from the invoice number)", () => {
    expect(isProtectedObjectPath("invoices/2025-0001.pdf")).toBe(true);
    expect(isProtectedObjectPath("invoices/2025-0001.isdoc")).toBe(true);
    expect(isProtectedObjectPath("invoices")).toBe(true);
  });

  it("blocks database backups", () => {
    expect(isProtectedObjectPath("backups/2025-01-01.dump")).toBe(true);
    expect(isProtectedObjectPath("backups")).toBe(true);
  });

  it("blocks private switchboard documentation from the generic storage route", () => {
    expect(isProtectedObjectPath("switchboards/42/documents/source.pdf")).toBe(true);
    expect(isProtectedObjectPath("switchboards")).toBe(true);
  });

  it("allows ordinary team-shared uploads (UUID keys, intentionally shared)", () => {
    expect(isProtectedObjectPath("uploads/abc-123.jpg")).toBe(false);
    expect(isProtectedObjectPath("uploads/some-doc.pdf")).toBe(false);
  });

  it("does not block look-alike prefixes that merely share leading characters", () => {
    expect(isProtectedObjectPath("invoices-archive/x.pdf")).toBe(false);
    expect(isProtectedObjectPath("backups-old/x.dump")).toBe(false);
  });
});

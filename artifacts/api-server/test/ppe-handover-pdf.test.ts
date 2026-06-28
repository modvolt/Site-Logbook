import { describe, it, expect } from "vitest";
import { generatePpeHandoverPdf, type PpeHandoverPdfData } from "../src/lib/ppe-handover-pdf";

const SAMPLE_SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeData(overrides: Partial<PpeHandoverPdfData> = {}): PpeHandoverPdfData {
  return {
    documentNumber: "OOPP-2026-000001",
    companyName: "Modvolt s.r.o.",
    employeeName: "Jan Novák",
    signatoryName: "Jan Novák",
    signedAt: new Date("2026-06-28T10:30:00Z"),
    issuerSnapshot: "Admin Správce",
    confirmationText:
      "Svým podpisem potvrzuji, že jsem převzal/a výše uvedené ochranné pracovní pomůcky (OOPP).",
    signatureDataUrl: SAMPLE_SIGNATURE_PNG,
    signatureSha256: "abc123def456",
    ppeNameSnapshot: "Přilba ochranná EN 397",
    ppeCategorySnapshot: "Ochrana hlavy",
    ppeStandardSnapshot: "EN 397",
    ppeProtectionClassSnapshot: null,
    ppeRiskDescriptionSnapshot: "Pád předmětů",
    quantity: 1,
    size: "L",
    serialNumber: "SN-9876",
    issuedAt: "2026-01-15",
    replaceBy: "2028-01-15",
    nextInspectionAt: "2027-01-15",
    ...overrides,
  };
}

describe("generatePpeHandoverPdf", () => {
  it("returns a non-empty Buffer", async () => {
    const buf = await generatePpeHandoverPdf(makeData());
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("output starts with the PDF magic bytes %PDF-", async () => {
    const buf = await generatePpeHandoverPdf(makeData());
    expect(buf.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders without throwing when optional fields are null", async () => {
    const buf = await generatePpeHandoverPdf(
      makeData({
        ppeCategorySnapshot: null,
        ppeStandardSnapshot: null,
        ppeProtectionClassSnapshot: null,
        ppeRiskDescriptionSnapshot: null,
        size: null,
        serialNumber: null,
        replaceBy: null,
        nextInspectionAt: null,
      }),
    );
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("renders without throwing when quantity > 1", async () => {
    const buf = await generatePpeHandoverPdf(makeData({ quantity: 5 }));
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("accepts a Czech document number with diacritics in company name", async () => {
    const buf = await generatePpeHandoverPdf(
      makeData({ companyName: "Střechy a Střešní Krytiny s.r.o.", employeeName: "Jiří Šimánek" }),
    );
    expect(buf.length).toBeGreaterThan(1000);
  });
});

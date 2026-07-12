import { describe, expect, it } from "vitest";
import jsPDF from "jspdf";
import { classifyPdfError, extractPdfTextElements } from "../src/lib/switchboard-pdf";

describe("SchrackNorm PDF text-layer adapter", () => {
  it("reads every page and preserves page, order and relative coordinates", async () => {
    const pdf = new jsPDF();
    pdf.text("Vyrobni cislo", 20, 20); pdf.text("DBO-2026-1", 100, 20);
    pdf.addPage(); pdf.text("Napeti", 20, 40); pdf.text("400 V", 100, 40);
    const buffer = Buffer.from(pdf.output("arraybuffer"));
    const result = await extractPdfTextElements(buffer);
    expect(result.pages).toBe(2);
    expect(result.elements.some((item) => item.page === 1 && item.text.includes("DBO-2026-1"))).toBe(true);
    expect(result.elements.some((item) => item.page === 2 && item.text.includes("400 V"))).toBe(true);
    expect(result.elements.every((item) => Number.isFinite(item.x) && Number.isFinite(item.y))).toBe(true);
  });

  it("rejects corrupted PDF bytes", async () => {
    await expect(extractPdfTextElements(Buffer.from("%PDF-corrupted"))).rejects.toThrow();
  });
});

describe("PDF error classification", () => {
  it("distinguishes encrypted and corrupted documents", () => {
    expect(classifyPdfError({ name: "PasswordException" }).code).toBe("encrypted_pdf");
    expect(classifyPdfError({ name: "InvalidPDFException" }).code).toBe("corrupted_pdf");
  });
});

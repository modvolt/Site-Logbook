import { describe, expect, it, vi } from "vitest";
import jsPDF from "jspdf";
import { createCanvas } from "@napi-rs/canvas";
import { classifyPdfError, extractPdfOcrElements, extractPdfTextElements, shouldUseOcrFallback } from "../src/lib/switchboard-pdf";
import { parseSwitchboardLabel, type FieldDefinition } from "../src/lib/switchboard-parser";

vi.mock("tesseract.js", () => ({
  createWorker: vi.fn(async () => ({
    recognize: vi.fn(async () => ({ data: { blocks: [{ paragraphs: [{ lines: [{ text: "Serial number DBO-2026-42", bbox: { x0: 10, y0: 20, x1: 250, y1: 45 } }] }] }] } })),
    terminate: vi.fn(async () => undefined),
  })),
}));

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

  it("detects an image-only PDF and runs the OCR adapter fallback", async () => {
    const image = createCanvas(600, 300);
    const context = image.getContext("2d");
    context.fillStyle = "white"; context.fillRect(0, 0, 600, 300);
    context.fillStyle = "black"; context.font = "32px Arial"; context.fillText("Serial number DBO-2026-42", 20, 80);
    const pdf = new jsPDF();
    pdf.addImage(image.toDataURL("image/png"), "PNG", 10, 10, 180, 90);
    const buffer = Buffer.from(pdf.output("arraybuffer"));
    const textLayer = await extractPdfTextElements(buffer);
    expect(textLayer.elements).toHaveLength(0);
    expect(shouldUseOcrFallback(parseSwitchboardLabel(textLayer.elements, []).status)).toBe(true);
    const ocr = await extractPdfOcrElements(buffer);
    expect(ocr.elements).toEqual([expect.objectContaining({ text: "Serial number DBO-2026-42", method: "ocr", page: 1 })]);
  });

  it("does not run OCR when the parser found a usable named-field block", () => {
    expect(shouldUseOcrFallback("complete")).toBe(false);
    expect(shouldUseOcrFallback("needs_review")).toBe(false);
  });

  it("extracts and parses a moved label from a later page without page or coordinate mapping", async () => {
    const pdf = new jsPDF({ unit: "pt", format: [900, 1200] });
    pdf.text("Unrelated technical report", 40, 40);
    pdf.addPage([1600, 1000], "landscape");
    const rows = [
      ["Serial number", "DBO-2026-42"],
      ["Voltage", "400 V"],
      ["Frequency", "50 Hz"],
      ["Protection", "IP40"],
    ];
    rows.forEach(([label, value], index) => {
      const y = 520 + index * 45;
      pdf.text(label, 920, y);
      pdf.text(value, 1120, y);
    });
    const registry: FieldDefinition[] = [
      { fieldKey: "serialNumber", canonicalNameCs: "Serial number", aliases: [], dataType: "text", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
      { fieldKey: "ratedVoltage", canonicalNameCs: "Voltage", aliases: [], dataType: "voltage", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
      { fieldKey: "ratedFrequency", canonicalNameCs: "Frequency", aliases: [], dataType: "frequency", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
      { fieldKey: "ipRating", canonicalNameCs: "Protection", aliases: [], dataType: "ip_rating", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
    ];
    const extracted = await extractPdfTextElements(Buffer.from(pdf.output("arraybuffer")));
    const parsed = parseSwitchboardLabel(extracted.elements, registry);
    expect(extracted.pages).toBe(2);
    expect(parsed.status).toBe("complete");
    expect(parsed.selectedPage).toBe(2);
    expect(parsed.fields.find((field) => field.fieldKey === "ratedVoltage")?.normalizedValue).toBe("400 V");
  });
});

describe("PDF error classification", () => {
  it("distinguishes encrypted and corrupted documents", () => {
    expect(classifyPdfError({ name: "PasswordException" }).code).toBe("encrypted_pdf");
    expect(classifyPdfError({ name: "InvalidPDFException" }).code).toBe("corrupted_pdf");
  });
});

import { describe, expect, it } from "vitest";
import { loadImage } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { generateSwitchboardLabel, validateLabelSnapshot, type SwitchboardLabelSnapshot } from "../src/lib/switchboard-label";

const snapshot: SwitchboardLabelSnapshot = { designation: "R1", serialNumber: "SN-2026-001", productionDate: "2026-07-13", typeDesignation: "DBO", manufacturer: "Modvolt s.r.o.", standards: ["ČSN EN 61439-1", "ČSN EN 61439-3"], networkSystem: "TN-C-S", ratedVoltage: "400 V", ratedFrequency: "50 Hz", ratedCurrent: "63 A", dimensions: "600 × 800 × 250 mm", weight: "35 kg", ipRating: "IP40", ikRating: "IK08", companyAddress: "Praha", companyPhone: "+420 123 456 789" };

describe("versioned Modvolt switchboard label", () => {
  it("requires every safety-critical label field", () => {
    expect(validateLabelSnapshot({ ...snapshot, ratedCurrent: "" })).toContain("ratedCurrent");
    expect(validateLabelSnapshot(snapshot)).toEqual([]);
  });
  it("renders a 300 DPI PNG and an exact 100 × 60 mm PDF", async () => {
    const output = await generateSwitchboardLabel(snapshot, "https://modvoltapp.cz/q/board/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789");
    const image = await loadImage(output.png); expect(image.width).toBe(1181); expect(image.height).toBe(709);
    const pdf = await getDocument({ data: new Uint8Array(output.pdf) }).promise; const page = await pdf.getPage(1); const viewport = page.getViewport({ scale: 1 });
    expect(viewport.width * 25.4 / 72).toBeCloseTo(100, 1); expect(viewport.height * 25.4 / 72).toBeCloseTo(60, 1);
  });
});

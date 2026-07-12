import { describe, expect, it } from "vitest";
import { normalizeFieldLabel, parseSwitchboardLabel, validateSwitchboardValue, type FieldDefinition, type TextElement } from "../src/lib/switchboard-parser";

const registry: FieldDefinition[] = [
  { fieldKey: "serialNumber", canonicalNameCs: "Výrobní číslo", aliases: ["Výrobní č."], dataType: "text", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
  { fieldKey: "ratedVoltage", canonicalNameCs: "Napětí", aliases: ["Un"], dataType: "voltage", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
  { fieldKey: "ratedFrequency", canonicalNameCs: "Frekvence", aliases: [], dataType: "frequency", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
  { fieldKey: "ipRating", canonicalNameCs: "IP", aliases: ["Stupeň krytí"], dataType: "ip_rating", required: false, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order"] },
];

function el(text: string, order: number, x: number, y: number, page = 1): TextElement { return { text, order, x, y, page, width: Math.max(20, text.length * 6), height: 10, blockId: `p${page}`, method: "text_layer" }; }
function fixture(offsetX = 0, offsetY = 0, page = 1) { return [
  el("Výrobní číslo", 1, offsetX, offsetY, page), el("DBO-2026-000123", 2, offsetX + 150, offsetY, page),
  el("Napětí", 3, offsetX, offsetY + 25, page), el("400 V", 4, offsetX + 150, offsetY + 25, page),
  el("Frekvence", 5, offsetX, offsetY + 50, page), el("50 Hz", 6, offsetX + 150, offsetY + 50, page),
  el("IP", 7, offsetX, offsetY + 75, page), el("IP40", 8, offsetX + 150, offsetY + 75, page),
]; }

describe("switchboard named-field parser", () => {
  it("normalizes Czech labels without losing technical meaning", () => {
    expect(normalizeFieldLabel("  VÝROBNÍ   ČÍSLO: ")).toBe("vyrobni cislo");
    expect(normalizeFieldLabel("InA=")).toBe("ina");
  });
  it("extracts values only after finding their registered labels", () => {
    const result = parseSwitchboardLabel(fixture(), registry);
    expect(result.status).toBe("complete");
    expect(result.fields.find((f) => f.fieldKey === "ratedVoltage")?.normalizedValue).toBe("400 V");
  });
  it("is invariant to absolute position and page number", () => {
    const moved = parseSwitchboardLabel(fixture(1400, 900, 7), registry);
    expect(moved.status).toBe("complete");
    expect(moved.selectedPage).toBe(7);
  });
  it("works when values are below labels", () => {
    const items = fixture().map((item) => item.order % 2 === 0 ? { ...item, x: item.x - 150, y: item.y + 12 } : item);
    expect(parseSwitchboardLabel(items, registry).fields.every((field) => field.validationStatus === "valid")).toBe(true);
  });
  it("does not assign an impressive unlabeled technical value", () => {
    const result = parseSwitchboardLabel([el("DBO-1", 1, 0, 0), el("400 V", 2, 100, 0), el("50 Hz", 3, 200, 0)], registry);
    expect(result.status).toBe("label_not_found");
    expect(result.fields).toHaveLength(0);
  });
  it("requires several labels and does not select a page from IP alone", () => {
    expect(parseSwitchboardLabel([el("IP", 1, 0, 0), el("IP40", 2, 100, 0)], registry).status).toBe("label_not_found");
  });
  it("reports two equally plausible label pages for review", () => {
    const result = parseSwitchboardLabel([...fixture(0, 0, 2), ...fixture(0, 0, 5)], registry);
    expect(result.status).toBe("needs_review");
    expect(result.ambiguousPages).toEqual([2, 5]);
  });
  it("marks a named but invalid value for review", () => {
    const items = fixture().map((item) => item.text === "400 V" ? { ...item, text: "400" } : item);
    const result = parseSwitchboardLabel(items, registry);
    expect(result.status).toBe("needs_review");
    expect(result.fields.find((f) => f.fieldKey === "ratedVoltage")?.validationStatus).toBe("invalid");
  });
});

describe("switchboard validators", () => {
  it.each([
    ["voltage", "400 V", "400 V"], ["frequency", "50 Hz", "50 Hz"], ["current", "63 A", "63 A"],
    ["weight", "7 kg", "7 kg"], ["dimensions", "717 x 346 x 96 mm", "717 × 346 × 96 mm"],
    ["ip_rating", "IP 40", "IP40"], ["ik_rating", "IK08", "IK08"], ["network_system", "tn-c-s", "TN-C-S"],
    ["date", "13. 7. 2026", "2026-07-13"],
  ])("validates %s", (type, raw, normalized) => expect(validateSwitchboardValue(type, raw).normalized).toBe(normalized));
  it.each([["voltage", "400"], ["frequency", "Hz"], ["dimensions", "717 mm"], ["network_system", "ABC"]])("rejects invalid %s", (type, raw) => expect(validateSwitchboardValue(type, raw).valid).toBe(false));
});

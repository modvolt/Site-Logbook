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
  it("accepts a value in the adjacent cell to the right", () => {
    const result = parseSwitchboardLabel(fixture(), registry);
    expect(result.fields.find((field) => field.fieldKey === "serialNumber")?.relativeRelation).toBe("same_line");
  });
  it("does not depend on the order in which field rows are emitted", () => {
    const items = fixture().map((item, index, all) => ({ ...item, order: all.length - index }));
    expect(parseSwitchboardLabel(items, registry).status).toBe("complete");
  });
  it("preserves a long production serial number", () => {
    const serial = "DBO-CZ-2026-00000000000000000042-A";
    const result = parseSwitchboardLabel(fixture().map((item) => item.text === "DBO-2026-000123" ? { ...item, text: serial } : item), registry);
    expect(result.fields.find((field) => field.fieldKey === "serialNumber")?.normalizedValue).toBe(serial);
  });
  it("completes when an optional field is absent", () => {
    const result = parseSwitchboardLabel(fixture().filter((item) => !["IP", "IP40"].includes(item.text)), registry);
    expect(result.status).toBe("complete");
    expect(result.fields.some((field) => field.fieldKey === "ipRating")).toBe(false);
  });
  it("requires review when a required named field is absent", () => {
    const result = parseSwitchboardLabel(fixture().filter((item) => !["Frekvence", "50 Hz"].includes(item.text)), registry);
    expect(result.status).toBe("needs_review");
    expect(result.missingRequired).toContain("ratedFrequency");
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
  it("ignores pages containing only isolated similar technical words", () => {
    const noise = [el("Napětí", 1, 0, 0, 1), el("400 V", 2, 100, 0, 1), el("DBO calculation", 3, 0, 20, 1)];
    const result = parseSwitchboardLabel([...noise, ...fixture(800, 500, 4)], registry);
    expect(result.status).toBe("complete");
    expect(result.selectedPage).toBe(4);
  });
  it("marks a named but invalid value for review", () => {
    const items = fixture().map((item) => item.text === "400 V" ? { ...item, text: "400" } : item);
    const result = parseSwitchboardLabel(items, registry);
    expect(result.status).toBe("needs_review");
    expect(result.fields.find((f) => f.fieldKey === "ratedVoltage")?.validationStatus).toBe("invalid");
  });
  it("keeps equivalent value candidates and requires a manual decision", () => {
    const result = parseSwitchboardLabel([...fixture(), el("230 V", 9, 250, 25)], registry);
    const voltage = result.fields.find((field) => field.fieldKey === "ratedVoltage");
    expect(result.status).toBe("needs_review");
    expect(result.ambiguousFields).toContain("ratedVoltage");
    expect(voltage?.validationStatus).toBe("invalid");
    expect(voltage?.valueCandidates.filter((candidate) => candidate.valid).map((candidate) => candidate.normalized)).toEqual(expect.arrayContaining(["400 V", "230 V"]));
  });
  it("stores one review field when the same named field appears with two values", () => {
    const items = [...fixture(), el("Napětí", 10, 0, 110), el("230 V", 11, 150, 110)];
    const result = parseSwitchboardLabel(items, registry);
    const voltages = result.fields.filter((field) => field.fieldKey === "ratedVoltage");
    expect(result.status).toBe("needs_review");
    expect(voltages).toHaveLength(1);
    expect(voltages[0].valueCandidates.map((candidate) => candidate.normalized)).toEqual(expect.arrayContaining(["400 V", "230 V"]));
  });
  it("tolerates one OCR typo in a long label and lowers confidence", () => {
    const items = fixture().map((item) => item.text === "Výrobní číslo" ? { ...item, text: "Výrobní číxlo", method: "ocr" as const } : item);
    const result = parseSwitchboardLabel(items, registry);
    const serial = result.fields.find((field) => field.fieldKey === "serialNumber");
    expect(serial?.normalizedValue).toBe("DBO-2026-000123");
    expect(serial?.confidence).toBeLessThan(0.9);
  });
  it("never fuzzy-matches short technical labels", () => {
    const items = fixture().map((item) => item.text === "IP" ? { ...item, text: "IK" } : item);
    expect(parseSwitchboardLabel(items, registry).fields.some((field) => field.fieldKey === "ipRating")).toBe(false);
  });
  it("remains stable when the whole label and its dimensions are scaled", () => {
    const scaled = fixture().map((item) => ({ ...item, x: item.x * 2.4, y: item.y * 2.4, width: item.width * 2.4, height: item.height * 2.4 }));
    expect(parseSwitchboardLabel(scaled, registry).status).toBe("complete");
  });
  it("collects a multi-line standard value until the next known label", () => {
    const standardsRegistry: FieldDefinition[] = [
      ...registry.slice(0, 3),
      { fieldKey: "standard", canonicalNameCs: "Norma", aliases: ["Normy"], dataType: "standards", required: true, minimumConfidence: 0.8, allowedRelations: ["same_line", "below", "reading_order", "until_next_label"] },
    ];
    const items = [
      ...fixture().filter((item) => !["IP", "IP40"].includes(item.text)),
      el("Normy", 7, 0, 75), el("CSN EN 61439-1", 8, 150, 75), el("CSN EN 61439-3", 9, 150, 88),
    ];
    const result = parseSwitchboardLabel(items, standardsRegistry);
    const standard = result.fields.find((field) => field.fieldKey === "standard");
    expect(result.status).toBe("complete");
    expect(standard?.relativeRelation).toBe("until_next_label");
    expect(standard?.normalizedValue).toContain("CSN EN 61439-3");
  });
});

describe("switchboard validators", () => {
  it.each([
    ["voltage", "400 V", "400 V"], ["frequency", "50 Hz", "50 Hz"], ["current", "63 A", "63 A"],
    ["weight", "7 kg", "7 kg"], ["dimensions", "717 x 346 x 96 mm", "717 × 346 × 96 mm"],
    ["ip_rating", "IP 40", "IP40"], ["ik_rating", "IK08", "IK08"], ["network_system", "tn-c-s", "TN-C-S"],
    ["network_system", "it", "IT"],
    ["date", "13. 7. 2026", "2026-07-13"],
  ])("validates %s", (type, raw, normalized) => expect(validateSwitchboardValue(type, raw).normalized).toBe(normalized));
  it.each([["voltage", "400"], ["frequency", "Hz"], ["dimensions", "717 mm"], ["network_system", "ABC"]])("rejects invalid %s", (type, raw) => expect(validateSwitchboardValue(type, raw).valid).toBe(false));
  it.each(["2026-02-30", "31. 4. 2026", "2026-13-01"])("rejects impossible calendar date %s", (raw) => expect(validateSwitchboardValue("date", raw).valid).toBe(false));
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWITCHBOARD_CHECKLIST, checklistDefinitionSchema, evaluatePhaseCompletion, isIdempotentChecklistRetry,
  findChecklistItem, itemIsRelevant, validateChecklistResponse,
} from "../src/lib/switchboard-checklist";

describe("default switchboard checklist", () => {
  it("contains the three required phases with a mobile-sized item count", () => {
    expect(checklistDefinitionSchema.safeParse(DEFAULT_SWITCHBOARD_CHECKLIST).success).toBe(true);
    expect(DEFAULT_SWITCHBOARD_CHECKLIST.phases.map((phase) => phase.key)).toEqual(["assembly", "inspection", "measurement"]);
    expect(DEFAULT_SWITCHBOARD_CHECKLIST.phases.map((phase) => phase.items.length)).toEqual([10, 10, 12]);
  });

  it("contains the mandatory tightening, PE, N and RCD measurement controls", () => {
    for (const key of ["assembly_tightening", "assembly_pe", "assembly_n", "measurement_rcd"]) {
      const found = findChecklistItem(DEFAULT_SWITCHBOARD_CHECKLIST, key);
      expect(found?.item.required).toBe(true);
      expect(found?.item.critical).toBe(true);
    }
  });

  it("keeps unknown applicability visible and hides explicitly irrelevant items", () => {
    const rcd = findChecklistItem(DEFAULT_SWITCHBOARD_CHECKLIST, "measurement_rcd")!.item;
    expect(itemIsRelevant(rcd, {})).toBe(true);
    expect(itemIsRelevant(rcd, { hasRcd: true })).toBe(true);
    expect(itemIsRelevant(rcd, { hasRcd: false })).toBe(false);
  });

  it("requires defect descriptions, N/A justification and complete measurement data", () => {
    const critical = findChecklistItem(DEFAULT_SWITCHBOARD_CHECKLIST, "assembly_pe")!.item;
    const measurement = findChecklistItem(DEFAULT_SWITCHBOARD_CHECKLIST, "measurement_insulation")!.item;
    expect(validateChecklistResponse(critical, { result: "defect", note: "" })).toContain("povinný");
    expect(validateChecklistResponse(critical, { result: "not_applicable", justification: "" })).toContain("zdůvodnění");
    expect(validateChecklistResponse(measurement, { result: "done", value: "1.2", unit: null, passed: true })).toContain("jednotku");
    expect(validateChecklistResponse(measurement, { result: "done", value: "1.2", unit: "MΩ", passed: true })).toBeNull();
  });

  it("blocks phase completion for missing responses or defects", () => {
    const phase = DEFAULT_SWITCHBOARD_CHECKLIST.phases[0];
    const withoutRcd = { hasRcd: false };
    const relevant = phase.items.filter((item) => itemIsRelevant(item, withoutRcd));
    const done = relevant.map((item) => ({ itemKey: item.key, result: "done" }));
    expect(evaluatePhaseCompletion(phase, withoutRcd, done).canComplete).toBe(true);
    expect(evaluatePhaseCompletion(phase, withoutRcd, done.slice(1)).missing.length).toBe(1);
    expect(evaluatePhaseCompletion(phase, withoutRcd, done.map((row, index) => index === 0 ? { ...row, result: "defect" } : row)).defects.length).toBe(1);
  });

  it("rejects duplicate item keys in a custom template", () => {
    const duplicate = structuredClone(DEFAULT_SWITCHBOARD_CHECKLIST);
    duplicate.phases[1].items[0].key = duplicate.phases[0].items[0].key;
    expect(checklistDefinitionSchema.safeParse(duplicate).success).toBe(false);
  });

  it("recognizes a lost-response retry only for the same actor and values", () => {
    const stored = { result: "done" as const, value: null, unit: null, passed: null, note: " hotovo ", justification: null, performedByUserId: 7 };
    expect(isIdempotentChecklistRetry(stored, { result: "done", note: "hotovo" }, 7)).toBe(true);
    expect(isIdempotentChecklistRetry(stored, { result: "done", note: "hotovo" }, 8)).toBe(false);
    expect(isIdempotentChecklistRetry(stored, { result: "defect", note: "hotovo" }, 7)).toBe(false);
  });
});

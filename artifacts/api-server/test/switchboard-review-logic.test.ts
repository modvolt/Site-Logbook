import { describe, expect, it } from "vitest";
import { compareExtractionVersions, extractionIsComplete, type ReviewField } from "../src/lib/switchboard-review-logic";

const field = (fieldKey: string, normalizedValue: string | null, confidence = 0.95, patch: Partial<ReviewField> = {}): ReviewField => ({ fieldKey, normalizedValue, correctedValue: null, confidence, manuallyCorrected: false, validationStatus: "valid", ...patch });
const required = [{ fieldKey: "serialNumber", minimumConfidence: 0.9 }, { fieldKey: "ratedCurrent", minimumConfidence: 0.9 }];

describe("switchboard extraction review decisions", () => {
  it("accepts all valid required fields above their thresholds", () => {
    expect(extractionIsComplete([field("serialNumber", "SN-1"), field("ratedCurrent", "63 A")], required)).toBe(true);
  });
  it("does not accept a low-confidence automatic value", () => {
    expect(extractionIsComplete([field("serialNumber", "SN-1"), field("ratedCurrent", "63 A", 0.7)], required)).toBe(false);
  });
  it("accepts a validated manual correction while preserving automatic confidence", () => {
    expect(extractionIsComplete([field("serialNumber", null, 0, { manuallyCorrected: true, correctedValue: "SN-1" }), field("ratedCurrent", "63 A")], required)).toBe(true);
  });
  it("does not accept an invalid corrected field", () => {
    expect(extractionIsComplete([field("serialNumber", null, 0, { manuallyCorrected: true, correctedValue: "SN-1", validationStatus: "invalid" }), field("ratedCurrent", "63 A")], required)).toBe(false);
  });
});

describe("switchboard DBO version comparison", () => {
  it("reports added, removed and changed effective values only", () => {
    expect(compareExtractionVersions([field("ratedCurrent", "25 A"), field("ipRating", "IP40")], [field("ratedCurrent", "32 A"), field("serialNumber", "SN-2")])).toEqual([
      { fieldKey: "ipRating", before: "IP40", after: null },
      { fieldKey: "ratedCurrent", before: "25 A", after: "32 A" },
      { fieldKey: "serialNumber", before: null, after: "SN-2" },
    ]);
  });
  it("compares corrected values rather than stale raw extraction", () => {
    expect(compareExtractionVersions([field("ipRating", "IP40")], [field("ipRating", "IP40", 0.5, { manuallyCorrected: true, correctedValue: "IP44" })])).toEqual([{ fieldKey: "ipRating", before: "IP40", after: "IP44" }]);
  });
});

import { describe, expect, it } from "vitest";
import { switchboardPatchFromExtractedFields } from "../src/lib/switchboard-field-values";

describe("automatic DBO field synchronization", () => {
  it("copies only validated named values and splits standards", () => {
    const patch = switchboardPatchFromExtractedFields([
      { fieldKey: "boardDesignation", normalizedValue: "R-42", validationStatus: "valid" },
      { fieldKey: "ratedCurrent", normalizedValue: "63 A", validationStatus: "valid" },
      { fieldKey: "standard", normalizedValue: "CSN EN 61439-1; CSN EN 61439-3", validationStatus: "valid" },
      { fieldKey: "serialNumber", normalizedValue: "UNTRUSTED", validationStatus: "invalid" },
    ]);
    expect(patch).toMatchObject({ designation: "R-42", ratedCurrent: "63 A", standards: ["CSN EN 61439-1", "CSN EN 61439-3"] });
    expect(patch).not.toHaveProperty("serialNumber");
  });
});

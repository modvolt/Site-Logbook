import { describe, expect, it } from "vitest";
import { encodeCsvCell, neutralizeSpreadsheetFormula } from "../src/lib/csv-security";
import { generateLeavesSummaryCsv } from "../src/lib/leaves-export";

describe("CSV spreadsheet formula neutralization", () => {
  it.each([
    ["=WEBSERVICE(\"https://example.invalid\")", "'=WEBSERVICE"],
    [" +CMD|' /C calc'!A0", "' +CMD"],
    ["\t=1+1", "'\t=1+1"],
    ["\r@SUM(1,1)", "'\r@SUM"],
  ])("neutralizes a dangerous text prefix %#", (input, prefix) => {
    expect(neutralizeSpreadsheetFormula(input)).toContain(prefix);
  });

  it("keeps real numeric values numeric", () => {
    expect(neutralizeSpreadsheetFormula(-12)).toBe("-12");
    expect(encodeCsvCell(-12)).toBe("-12");
  });

  it("quotes delimiters and line breaks after neutralization", () => {
    expect(encodeCsvCell("\r@SUM(1,1)")).toBe("\"'\r@SUM(1,1)\"");
  });

  it("applies the shared encoder in the leave export", () => {
    const csv = generateLeavesSummaryCsv(
      [{ personId: 1, personName: "\t=WEBSERVICE(\"x\")", year: 2026, vacationDays: 1, sickDays: 0, otherDays: 0, totalDays: 1 }],
      2026,
    );
    expect(csv).toContain("\"'\t=WEBSERVICE(\"\"x\"\")\"");
  });
});

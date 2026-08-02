import { describe, expect, it } from "vitest";
import { encodeCsvCell, neutralizeSpreadsheetFormula } from "./csv-security";

describe("browser CSV formula neutralization", () => {
  it.each(["=1+1", " +CMD", "\t=WEBSERVICE(\"x\")", "\r@SUM(1;1)"])(
    "neutralizes %j before CSV download",
    (input) => expect(neutralizeSpreadsheetFormula(input)).toBe(`'${input}`),
  );

  it("always quotes and escapes a neutralized cell", () => {
    expect(encodeCsvCell(' ="x"', { alwaysQuote: true })).toBe('"\' =""x"""');
  });

  it("does not turn a negative number into text", () => {
    expect(encodeCsvCell(-3)).toBe("-3");
  });
});

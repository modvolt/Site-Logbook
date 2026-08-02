import { describe, expect, it } from "vitest";
import { parseLegacyPpeMaxAgeDays } from "../src/scripts/public-token-preflight-policy";

describe("legacy PPE token preflight policy", () => {
  it("requires and returns an explicit limit for both PPE token types", () => {
    expect(
      parseLegacyPpeMaxAgeDays([
        "--database=site_logbook_staging",
        "--max-age-days=ppe_confirmation:7",
        "--max-age-days=ppe_signature:30",
      ]),
    ).toEqual({
      ppe_signature: 30,
      ppe_confirmation: 7,
    });
  });

  it.each([
    [[]],
    [["--max-age-days=ppe_signature:30"]],
    [["--max-age-days=ppe_confirmation:7"]],
  ])("rejects a missing type policy", (args) => {
    expect(() => parseLegacyPpeMaxAgeDays(args)).toThrow(/Both PPE token types/);
  });

  it.each([
    "--max-age-days=30",
    "--max-age-days=ppe_other:30",
    "--max-age-days=ppe_signature:0",
    "--max-age-days=ppe_signature:3651",
    "--max-age-days=ppe_signature:1.5",
  ])("rejects malformed or unsafe policy %s", (value) => {
    expect(() =>
      parseLegacyPpeMaxAgeDays([
        value,
        "--max-age-days=ppe_confirmation:7",
      ]),
    ).toThrow();
  });

  it("rejects duplicate policies instead of using order-dependent precedence", () => {
    expect(() =>
      parseLegacyPpeMaxAgeDays([
        "--max-age-days=ppe_signature:30",
        "--max-age-days=ppe_signature:31",
        "--max-age-days=ppe_confirmation:7",
      ]),
    ).toThrow(/Duplicate/);
  });
});

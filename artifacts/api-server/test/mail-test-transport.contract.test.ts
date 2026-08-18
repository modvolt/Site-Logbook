import { describe, expect, it } from "vitest";
import { allowInsecureMailForHermeticTest } from "../src/lib/mail-transport-security";

describe("R14 hermetic mail transport boundary", () => {
  it("is disabled by default", () => {
    expect(allowInsecureMailForHermeticTest({ NODE_ENV: "test" })).toBe(false);
  });

  it("can be explicitly enabled in test mode", () => {
    expect(
      allowInsecureMailForHermeticTest({
        NODE_ENV: "test",
        MAIL_TEST_ALLOW_INSECURE: "true",
      }),
    ).toBe(true);
  });

  it.each(["production", "development"])("fails closed in %s", (nodeEnv) => {
    expect(() =>
      allowInsecureMailForHermeticTest({
        NODE_ENV: nodeEnv,
        MAIL_TEST_ALLOW_INSECURE: "true",
      }),
    ).toThrow(/only when NODE_ENV=test/);
  });
});

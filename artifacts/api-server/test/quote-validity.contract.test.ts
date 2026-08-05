import { describe, expect, it } from "vitest";
import {
  assertQuoteDecisionStillValid,
  quoteDecisionExpiresAt,
  quoteValidityDeadline,
} from "../src/lib/quote-validity";

describe("quote public decision validity", () => {
  it("uses the inclusive Europe/Prague business-day boundary", () => {
    expect(quoteValidityDeadline("2026-01-15").toISOString()).toBe(
      "2026-01-15T22:59:59.999Z",
    );
    expect(quoteValidityDeadline("2026-07-15").toISOString()).toBe(
      "2026-07-15T21:59:59.999Z",
    );
  });

  it("caps the bearer TTL to validUntil without extending shorter TTL", () => {
    const now = new Date("2026-07-10T10:00:00.000Z");
    expect(
      quoteDecisionExpiresAt(
        new Date("2026-08-10T10:00:00.000Z"),
        "2026-07-15",
        now,
      ).toISOString(),
    ).toBe("2026-07-15T21:59:59.999Z");
    expect(
      quoteDecisionExpiresAt(
        new Date("2026-07-12T10:00:00.000Z"),
        "2026-07-15",
        now,
      ).toISOString(),
    ).toBe("2026-07-12T10:00:00.000Z");
  });

  it("fails closed for expired or malformed validity dates", () => {
    expect(() =>
      assertQuoteDecisionStillValid(
        "2026-07-09",
        new Date("2026-07-10T10:00:00.000Z"),
      ),
    ).toThrowError(/quote_expired/);
    expect(() => quoteValidityDeadline("2026-02-30")).toThrowError(
      /invalid_valid_until/,
    );
  });
});

import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceJson,
  evidenceSha256,
  normalizedUserAgentSha256,
} from "../src/lib/evidence-hash";

describe("canonical evidence hashing", () => {
  it("is stable across object key order but preserves array order", () => {
    const first = { z: 1, nested: { b: true, a: "x" }, lines: [1, 2] };
    const reordered = { lines: [1, 2], nested: { a: "x", b: true }, z: 1 };
    expect(canonicalEvidenceJson(first)).toBe(canonicalEvidenceJson(reordered));
    expect(evidenceSha256(first)).toBe(evidenceSha256(reordered));
    expect(evidenceSha256(first)).not.toBe(
      evidenceSha256({ ...reordered, lines: [2, 1] }),
    );
  });

  it("rejects non-JSON values and stores only a user-agent hash", () => {
    expect(() => canonicalEvidenceJson({ invalid: undefined })).toThrow(
      /unsupported/i,
    );
    const hash = normalizedUserAgentSha256(" Test Browser 1.0 ");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("Browser");
    expect(normalizedUserAgentSha256("  ")).toBeNull();
  });

  it("preserves the existing canonical bytes for valid plain JSON", () => {
    expect(
      canonicalEvidenceJson({
        unicode: "Příliš žluťoučký kůň",
        nested: { empty: {}, negativeZero: -0 },
        values: [null, true, 2.5, [], "x"],
      }),
    ).toBe(
      '{"nested":{"empty":{},"negativeZero":0},"unicode":"Příliš žluťoučký kůň","values":[null,true,2.5,[],"x"]}',
    );
  });

  it.each([
    ["Date", () => canonicalEvidenceJson(new Date("2026-08-11T00:00:00.000Z"))],
    ["Map", () => canonicalEvidenceJson(new Map([["a", 1]]))],
    ["Set", () => canonicalEvidenceJson(new Set([1]))],
    [
      "class instance",
      () =>
        canonicalEvidenceJson(
          new (class Example {
            value = 1;
          })(),
        ),
    ],
    ["function", () => canonicalEvidenceJson(() => undefined)],
    ["bigint", () => canonicalEvidenceJson(1n)],
    ["NaN", () => canonicalEvidenceJson(Number.NaN)],
    ["Infinity", () => canonicalEvidenceJson(Number.POSITIVE_INFINITY)],
  ])("rejects %s values", (_label, invoke) => {
    expect(invoke).toThrow();
  });

  it("rejects sparse arrays, extra properties, accessors and hidden or symbol keys", () => {
    const sparse = Array(2);
    sparse[1] = "x";
    expect(() => canonicalEvidenceJson(sparse)).toThrow(/dense/i);

    const withExtra = ["x"] as string[] & { extra?: string };
    withExtra.extra = "hidden meaning";
    expect(() => canonicalEvidenceJson(withExtra)).toThrow(/extra/i);

    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => "must-not-run",
    });
    expect(() => canonicalEvidenceJson(accessor)).toThrow(/accessor/i);

    const hidden = Object.defineProperty({}, "hidden", {
      enumerable: false,
      value: "must-not-ignore",
    });
    expect(() => canonicalEvidenceJson(hidden)).toThrow(/hidden/i);

    expect(() => canonicalEvidenceJson({ [Symbol("hidden")]: "x" })).toThrow(
      /symbol/i,
    );
  });

  it("rejects cycles but permits repeated non-cyclic references", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalEvidenceJson(cyclic)).toThrow(/cycle/i);

    const shared = { value: 1 };
    expect(canonicalEvidenceJson({ first: shared, second: shared })).toBe(
      '{"first":{"value":1},"second":{"value":1}}',
    );
  });
});

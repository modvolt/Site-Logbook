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
    expect(evidenceSha256(first)).not.toBe(evidenceSha256({ ...reordered, lines: [2, 1] }));
  });

  it("rejects non-JSON values and stores only a user-agent hash", () => {
    expect(() => canonicalEvidenceJson({ invalid: undefined })).toThrow(/unsupported/i);
    const hash = normalizedUserAgentSha256(" Test Browser 1.0 ");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("Browser");
    expect(normalizedUserAgentSha256("  ")).toBeNull();
  });
});

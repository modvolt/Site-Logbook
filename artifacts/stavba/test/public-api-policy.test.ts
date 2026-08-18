import { describe, expect, it } from "vitest";
import {
  canonicalPublicGrantApiFamily,
  isPublicApiRequest,
  publicGrantApiFamily,
} from "../src/lib/public-api-policy";

describe("frontend public API policy", () => {
  it.each([
    ["GET", "/api/sign", "job_signature"],
    ["POST", "/api/sign/token", "job_signature"],
    ["GET", "/api/ppe/sign", "ppe_signature"],
    ["POST", "/api/ppe/confirm", "ppe_confirmation"],
    ["GET", "/api/quotes/public", "quote"],
    ["POST", "/api/quotes/public/token/accept", "quote"],
    ["GET", "/api/q/board", "switchboard"],
    ["GET", "/api/q/board/documents/sha", "switchboard"],
  ] as const)("classifies %s %s", (method, path, family) => {
    expect(publicGrantApiFamily(method, path)).toBe(family);
    expect(isPublicApiRequest(method, path)).toBe(true);
  });

  it.each([
    ["DELETE", "/api/sign"],
    ["POST", "/api/quotes/public/token"],
    ["GET", "/api/q/board/token/private"],
    ["GET", "/api/ppe/confirm/extra"],
  ])("keeps near miss %s %s private", (method, path) => {
    expect(publicGrantApiFamily(method, path)).toBeNull();
    expect(isPublicApiRequest(method, path)).toBe(false);
  });

  it("distinguishes canonical Bearer APIs from deprecated token paths", () => {
    expect(canonicalPublicGrantApiFamily("POST", "/api/sign"))
      .toBe("job_signature");
    expect(canonicalPublicGrantApiFamily("POST", "/api/sign/token"))
      .toBeNull();
    expect(canonicalPublicGrantApiFamily("POST", "/api/quotes/public/accept"))
      .toBe("quote");
    expect(canonicalPublicGrantApiFamily("POST", "/api/quotes/public/token/accept"))
      .toBeNull();
  });

  it("bypasses identity scoping before service-worker cache handling", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/sw.ts", import.meta.url)),
      "utf8",
    );
    const bypass = source.indexOf("publicGrantApiFamily(options.request.method");
    expect(bypass).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(source.indexOf("clientScopes.get(clientId)", bypass));
    expect(source.slice(bypass, source.indexOf("clientScopes.get(clientId)", bypass)))
      .toContain("return fetch(options.request)");
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { classifyPublicBearerRoute } from "../src/lib/public-bearer-route-policy";

describe("public Bearer route classifier", () => {
  const routes = [
    ["GET", "/api/sign", "job_signature", "read"],
    ["HEAD", "/api/sign/token", "job_signature", "read"],
    ["POST", "/api/sign", "job_signature", "mutation"],
    ["POST", "/api/sign/token", "job_signature", "mutation"],
    ["GET", "/api/ppe/sign", "ppe_signature", "read"],
    ["POST", "/api/ppe/sign/token", "ppe_signature", "mutation"],
    ["GET", "/api/ppe/confirm?token=legacy", "ppe_confirmation", "read"],
    ["POST", "/api/ppe/confirm", "ppe_confirmation", "mutation"],
    ["GET", "/api/quotes/public", "quote", "read"],
    ["GET", "/api/quotes/public/token", "quote", "read"],
    ["POST", "/api/quotes/public/accept", "quote", "mutation"],
    ["POST", "/api/quotes/public/token/reject", "quote", "mutation"],
    ["GET", "/api/q/board", "switchboard", "read"],
    ["GET", "/api/q/board/token", "switchboard", "read"],
    ["GET", `/api/q/board/documents/${"a".repeat(64)}`, "switchboard", "read"],
    ["GET", `/api/q/board/token/documents/${"a".repeat(64)}`, "switchboard", "read"],
  ] as const;

  for (const [method, path, family, requestClass] of routes) {
    it(`classifies ${method} ${path}`, () => {
      expect(classifyPublicBearerRoute(method, path)).toEqual({ family, requestClass });
    });
  }

  const nearMisses = [
    ["DELETE", "/api/sign"],
    ["POST", "/api/sign/token/extra"],
    ["GET", "/api/ppe/signature"],
    ["GET", "/api/ppe/sign/token/extra"],
    ["GET", "/api/ppe/confirm/extra"],
    ["POST", "/api/quotes/public/token"],
    ["POST", "/api/quotes/public/token/accept/extra"],
    ["GET", "/api/q/board/token/private"],
    ["GET", `/api/q/board/documents/${"a".repeat(64)}/extra`],
    ["OPTIONS", "/api/q/board"],
  ] as const;

  for (const [method, path] of nearMisses) {
    it(`rejects near miss ${method} ${path}`, () => {
      expect(classifyPublicBearerRoute(method, path)).toBeNull();
    });
  }

  it("keeps documented legacy segment collisions in the read family", () => {
    expect(classifyPublicBearerRoute("GET", "/api/quotes/public/accept"))
      .toEqual({ family: "quote", requestClass: "read" });
    expect(classifyPublicBearerRoute("GET", "/api/q/board/documents"))
      .toEqual({ family: "switchboard", requestClass: "read" });
  });
});

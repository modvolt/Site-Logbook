import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  API_BODY_LIMITS,
  isRequestBodyTooLarge,
  jsonBodyLimitForRequest,
} from "../src/middlewares/request-body";

describe("API body limit policy", () => {
  it("uses a small default/public cap and only named authenticated large routes", () => {
    expect(jsonBodyLimitForRequest({ method: "POST", originalUrl: "/api/jobs" }))
      .toBe(API_BODY_LIMITS.authenticatedJsonBytes);
    expect(jsonBodyLimitForRequest({ method: "POST", originalUrl: "/api/sign/token" }))
      .toBe(API_BODY_LIMITS.publicJsonBytes);
    for (const originalUrl of [
      "/api/sign",
      "/api/ppe/sign",
      "/api/ppe/confirm",
      "/api/quotes/public/accept",
      "/api/quotes/public/reject",
    ]) {
      expect(jsonBodyLimitForRequest({ method: "POST", originalUrl }))
        .toBe(API_BODY_LIMITS.publicJsonBytes);
    }
    expect(jsonBodyLimitForRequest({ method: "POST", originalUrl: "/api/jobs/42/job-sheet" }))
      .toBe(API_BODY_LIMITS.largeAuthenticatedJsonBytes);
    expect(jsonBodyLimitForRequest({ method: "POST", originalUrl: "/api/billing/bank-statements/parse?x=1" }))
      .toBe(API_BODY_LIMITS.largeAuthenticatedJsonBytes);
    expect(jsonBodyLimitForRequest({ method: "GET", originalUrl: "/api/jobs/42/job-sheet" }))
      .toBe(API_BODY_LIMITS.authenticatedJsonBytes);
  });

  it("recognizes body-parser 413 errors", () => {
    expect(isRequestBodyTooLarge({ type: "entity.too.large" })).toBe(true);
    expect(isRequestBodyTooLarge({ status: 413 })).toBe(true);
    expect(isRequestBodyTooLarge(new Error("other"))).toBe(false);
  });
});

describe("middleware and proxy ordering contract", () => {
  it("authenticates and authorizes before parsing, then fingerprints the parsed body", () => {
    const appPath = fileURLToPath(new URL("../src/app.ts", import.meta.url));
    const source = readFileSync(appPath, "utf8");
    expect(source.indexOf('app.use("/api", parseApiRequestBody)')).toBeGreaterThan(
      source.indexOf("return enforceApiPermission(req, res, next)"),
    );
    expect(source.indexOf('app.use("/api", limitPublicBearerRequests)')).toBeLessThan(
      source.indexOf('app.use("/api", parseApiRequestBody)'),
    );
    expect(source.indexOf('app.use("/api", enforceOfflineIdempotency)')).toBeGreaterThan(
      source.indexOf('app.use("/api", parseApiRequestBody)'),
    );

    const nginxPath = fileURLToPath(new URL("../../stavba/nginx.conf", import.meta.url));
    const nginx = readFileSync(nginxPath, "utf8");
    expect(nginx).toContain("proxy_request_buffering off;");
    expect(nginx).toContain("client_body_timeout 30s;");
  });
});

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_ACCOUNT_IDEMPOTENCY_SCOPE,
  onlineIdempotencyPolicyForRequest,
} from "../src/lib/online-idempotency-policy";

const MUTATIONS = [
  ["POST", "/api/external-accounts", "/external-accounts"],
  ["PUT", "/api/external-accounts/7/scopes", "/external-accounts/:id/scopes"],
  ["PATCH", "/api/external-accounts/7/expiry", "/external-accounts/:id/expiry"],
  [
    "POST",
    "/api/external-accounts/7/activate",
    "/external-accounts/:id/activate",
  ],
  [
    "POST",
    "/api/external-accounts/7/transfer",
    "/external-accounts/:id/transfer",
  ],
  ["POST", "/api/external-accounts/7/revoke", "/external-accounts/:id/revoke"],
] as const;

describe("privileged online idempotency policy", () => {
  it.each(MUTATIONS)(
    "registers %s %s with the stable encrypted scope",
    (method, originalUrl, routeTemplate) => {
      expect(
        onlineIdempotencyPolicyForRequest({ method, originalUrl }),
      ).toEqual({
        scope: EXTERNAL_ACCOUNT_IDEMPOTENCY_SCOPE,
        routeTemplate,
        encryptedAtRest: true,
      });
    },
  );

  it.each([
    ["GET", "/api/external-accounts"],
    ["GET", "/api/external-accounts/7"],
    ["POST", "/api/external-accounts/0/revoke"],
    ["POST", "/api/external-accounts/7/revoke/again"],
    ["DELETE", "/api/external-accounts/7"],
    ["POST", "/api/not-external-accounts"],
  ])("does not widen to %s %s", (method, originalUrl) => {
    expect(
      onlineIdempotencyPolicyForRequest({ method, originalUrl }),
    ).toBeNull();
  });
});

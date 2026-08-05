import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import {
  assertNoAuthorizationCredential,
  PublicBearerCredentialError,
  readPublicBearerOrLegacyToken,
  readPublicBearerToken,
  sendPublicBearerCredentialError,
} from "../src/lib/public-bearer-auth";

type HeaderRequest = Pick<Request, "headers" | "rawHeaders">;

function request(
  rawHeaders: string[] = [],
  authorization?: string,
): HeaderRequest {
  return {
    rawHeaders,
    headers: authorization === undefined ? {} : { authorization },
  } as HeaderRequest;
}

function response() {
  const state: {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
  } = { headers: {} };
  const res = {
    setHeader(name: string, value: string) {
      state.headers[name] = value;
      return this;
    },
    status(value: number) {
      state.status = value;
      return this;
    },
    json(value: unknown) {
      state.body = value;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

describe("public Bearer credential parsing", () => {
  for (const length of [32, 43, 128]) {
    it(`accepts a ${length}-character base64url token`, () => {
      const token = "A".repeat(length);
      expect(readPublicBearerToken(request(["Authorization", `Bearer ${token}`])))
        .toBe(token);
    });
  }

  it("accepts case-insensitive header and scheme names", () => {
    const token = "a_B-".repeat(8);
    expect(readPublicBearerToken(request(["aUtHoRiZaTiOn", `bEaReR ${token}`])))
      .toBe(token);
  });

  it.each([
    undefined,
    "",
    "Basic abc",
    `Bearer ${"A".repeat(31)}`,
    `Bearer ${"A".repeat(129)}`,
    `Bearer ${"A".repeat(31)}=`,
    `Bearer  ${"A".repeat(32)}`,
    `Bearer\t${"A".repeat(32)}`,
    `Bearer ${"A".repeat(32)},other`,
  ])("rejects missing or malformed Authorization %s", (value) => {
    const req = value === undefined ? request() : request([], value);
    expect(() => readPublicBearerToken(req)).toThrow(PublicBearerCredentialError);
  });

  it("rejects duplicate raw Authorization headers", () => {
    const token = "A".repeat(32);
    expect(() => readPublicBearerToken(request([
      "Authorization", `Bearer ${token}`,
      "authorization", `Bearer ${token}`,
    ]))).toThrowError(expect.objectContaining({ code: "ambiguous" }));
  });

  it("rejects Bearer together with any legacy credential", () => {
    const token = "A".repeat(32);
    const req = request(["Authorization", `Bearer ${token}`]);
    expect(() => readPublicBearerOrLegacyToken(req, token))
      .toThrowError(expect.objectContaining({ code: "ambiguous" }));
    expect(() => readPublicBearerOrLegacyToken(req, ""))
      .toThrowError(expect.objectContaining({ code: "ambiguous" }));
    expect(() => assertNoAuthorizationCredential(req))
      .toThrowError(expect.objectContaining({ code: "ambiguous" }));
  });

  it("maps errors without reflecting the credential", () => {
    const secret = "S".repeat(43);
    const malformed = (() => {
      try {
        readPublicBearerToken(request([], `Bearer ${secret}=`));
      } catch (error) {
        return error;
      }
      throw new Error("Expected parser to reject malformed credential");
    })();
    const first = response();
    expect(sendPublicBearerCredentialError(first.res, malformed)).toBe(true);
    expect(first.state.status).toBe(401);
    expect(first.state.headers["WWW-Authenticate"]).toBe("Bearer");
    expect(JSON.stringify(first.state)).not.toContain(secret);

    const second = response();
    expect(sendPublicBearerCredentialError(
      second.res,
      new PublicBearerCredentialError("ambiguous"),
    )).toBe(true);
    expect(second.state.status).toBe(400);
    expect(second.state.body).toEqual(expect.objectContaining({
      code: "ambiguous_public_credential",
    }));
  });
});

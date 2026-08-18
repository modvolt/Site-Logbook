import { afterEach, describe, expect, it } from "vitest";
import { PublicOriginConfigError } from "../src/lib/public-origin";
import { webauthnRelyingParty } from "../src/lib/webauthn-rp";

const originalPublicUrl = process.env.PUBLIC_APP_URL;

afterEach(() => {
  if (originalPublicUrl == null) delete process.env.PUBLIC_APP_URL;
  else process.env.PUBLIC_APP_URL = originalPublicUrl;
});

const hostileRequest = {
  protocol: "http",
  hostname: "attacker.example",
  get(header: string) {
    if (header === "host") return "attacker.example:8080";
    if (header === "x-forwarded-proto") return "http";
    return undefined;
  },
};

describe("WebAuthn relying-party origin", () => {
  it("uses only the trusted public application origin in production", () => {
    process.env.PUBLIC_APP_URL = "https://modvoltapp.cz";
    expect(webauthnRelyingParty(hostileRequest, "production")).toEqual({
      rpId: "modvoltapp.cz",
      origin: "https://modvoltapp.cz",
    });
  });

  it("fails closed when the production public origin is invalid", () => {
    process.env.PUBLIC_APP_URL = "http://attacker.example";
    expect(() => webauthnRelyingParty(hostileRequest, "production"))
      .toThrow(PublicOriginConfigError);
  });

  it("keeps localhost ports available outside production", () => {
    const localRequest = {
      protocol: "http",
      hostname: "localhost",
      get: (header: string) => header === "host" ? "localhost:5173" : undefined,
    };
    expect(webauthnRelyingParty(localRequest, "test")).toEqual({
      rpId: "localhost",
      origin: "http://localhost:5173",
    });
  });
});

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  TrustedProxyConfigError,
  trustedProxyRanges,
} from "../src/lib/trusted-proxy";

function proxyTestApp(ranges: string[]) {
  const app = express();
  app.set("trust proxy", ranges);
  app.get("/ip", (req, res) => {
    res.json({ ip: req.ip, ips: req.ips, secure: req.secure });
  });
  return app;
}

describe("trusted reverse-proxy boundary", () => {
  it("requires an explicit production topology", () => {
    expect(() => trustedProxyRanges("production", ""))
      .toThrow(TrustedProxyConfigError);
    expect(trustedProxyRanges("test", "")).toEqual(["loopback"]);
  });

  it.each([
    "true",
    "2",
    "uniquelocal",
    "linklocal",
    "10.0.0.0/0",
    "::/0",
    "172.20.0.0/99",
    "not-an-address",
  ])("rejects unsafe or malformed proxy trust value %s", (value) => {
    expect(() => trustedProxyRanges("production", value))
      .toThrow(TrustedProxyConfigError);
  });

  it("accepts exact proxy addresses and bounded CIDRs", () => {
    expect(trustedProxyRanges(
      "production",
      "172.20.0.0/28, 192.0.2.40, 2001:db8:1::/64",
    )).toEqual(["172.20.0.0/28", "192.0.2.40", "2001:db8:1::/64"]);
  });

  it("resolves the client through explicitly trusted nginx and edge ranges", async () => {
    const response = await request(proxyTestApp([
      "loopback",
      "172.20.0.0/28",
    ]))
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.9, 172.20.0.2")
      .set("X-Forwarded-Proto", "https")
      .expect(200);

    expect(response.body).toEqual({
      ip: "203.0.113.9",
      ips: ["203.0.113.9", "172.20.0.2"],
      secure: true,
    });
  });

  it("stops before public and private spoofed prefixes", async () => {
    const app = proxyTestApp(["loopback", "172.20.0.0/28"]);
    for (const spoofed of ["198.51.100.10", "10.99.0.5"]) {
      const response = await request(app)
        .get("/ip")
        .set(
          "X-Forwarded-For",
          `${spoofed}, 203.0.113.9, 172.20.0.2`,
        )
        .expect(200);
      expect(response.body.ip).toBe("203.0.113.9");
      expect(response.body.ips).toEqual(["203.0.113.9", "172.20.0.2"]);
    }
  });

  it("does not trust an undeclared internal proxy", async () => {
    const response = await request(proxyTestApp(["loopback"]))
      .get("/ip")
      .set("X-Forwarded-For", "203.0.113.9, 172.20.0.2")
      .expect(200);

    expect(response.body.ip).toBe("172.20.0.2");
    expect(response.body.ips).toEqual(["172.20.0.2"]);
  });
});

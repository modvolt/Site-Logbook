import { describe, it, expect } from "vitest";
import { norm, buildTopology } from "../src/components/network-topology-diagram";
import type { NetworkDevice } from "@workspace/api-client-react";

/**
 * Regression guard for the "(e ?? \"\").trim is not a function" crash in the
 * network topology diagram: device names/IPs, port numbers/names, and
 * connectedDevice strings must never throw when they are non-string (e.g.
 * a stray number/boolean/object coming from mistyped device data).
 */

describe("norm", () => {
  it("does not throw and coerces a numeric value", () => {
    expect(() => norm(5 as unknown as string)).not.toThrow();
    expect(norm(5 as unknown as string)).toBe("5");
  });

  it("does not throw for null, undefined, or boolean values", () => {
    expect(() => norm(null as unknown as string)).not.toThrow();
    expect(() => norm(undefined as unknown as string)).not.toThrow();
    expect(() => norm(true as unknown as string)).not.toThrow();
    expect(norm(null as unknown as string)).toBe("");
    expect(norm(undefined as unknown as string)).toBe("");
  });

  it("trims and lowercases a normal string", () => {
    expect(norm("  Router  ")).toBe("router");
  });
});

describe("buildTopology — non-string field hardening", () => {
  function device(overrides: Partial<NetworkDevice>): NetworkDevice {
    return {
      id: "d1",
      name: "Router",
      deviceType: "router",
      ipAddress: "192.168.1.1",
      quantity: 1,
      ports: [],
      ...overrides,
    } as NetworkDevice;
  }

  it("does not throw when a port's connectedDevice is a non-string value", () => {
    const devices: NetworkDevice[] = [
      device({
        id: "d1",
        ports: [
          {
            id: "p1",
            portNumber: 1 as unknown as string,
            name: "LAN1",
            connectedDevice: 42 as unknown as string,
          },
        ] as unknown as NetworkDevice["ports"],
      }),
    ];
    expect(() => buildTopology(devices)).not.toThrow();
  });

  it("does not throw when a port's name/portNumber are non-string values", () => {
    const devices: NetworkDevice[] = [
      device({
        id: "d1",
        ports: [
          {
            id: "p1",
            portNumber: null as unknown as string,
            name: 7 as unknown as string,
            connectedDevice: "Internet",
          },
        ] as unknown as NetworkDevice["ports"],
      }),
    ];
    const built = buildTopology(devices);
    expect(built.nodes.length).toBeGreaterThan(0);
  });
});

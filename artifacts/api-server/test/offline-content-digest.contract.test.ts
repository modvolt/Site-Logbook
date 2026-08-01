import { createHash } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it } from "vitest";
import {
  OFFLINE_CONTENT_DIGEST_HEADER,
  offlineContentDigest,
  requiresOfflineContentDigest,
  verifyOfflineContentDigest,
} from "../src/lib/offline-content-digest";

const OFFLINE_SCOPE = "a".repeat(64);

function requestWith(
  headers: Record<string, string>,
  body: unknown = undefined,
): Request {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    body,
    get(name: string) {
      return normalized[name.toLowerCase()];
    },
  } as Request;
}

describe("offline raw-content digest", () => {
  const content = Buffer.from("offline photo bytes");
  const digest = createHash("sha256").update(content).digest("hex");

  it("requires and verifies SHA-256 for a scoped raw upload", () => {
    const req = requestWith({
      "Content-Type": "image/jpeg",
      "X-Stavba-Offline-Scope": OFFLINE_SCOPE,
      [OFFLINE_CONTENT_DIGEST_HEADER]: digest,
    });

    expect(requiresOfflineContentDigest(req)).toBe(true);
    expect(offlineContentDigest(req)).toBe(digest);
    expect(verifyOfflineContentDigest(req, content)).toBe(true);
    expect(verifyOfflineContentDigest(req, Buffer.from("changed"))).toBe(false);
  });

  it("rejects a missing or malformed digest for a scoped raw upload", () => {
    const missing = requestWith({
      "Content-Type": "image/jpeg",
      "X-Stavba-Offline-Scope": OFFLINE_SCOPE,
    });
    const malformed = requestWith({
      "Content-Type": "image/jpeg",
      "X-Stavba-Offline-Scope": OFFLINE_SCOPE,
      [OFFLINE_CONTENT_DIGEST_HEADER]: "not-a-sha256",
    });

    expect(requiresOfflineContentDigest(missing)).toBe(true);
    expect(verifyOfflineContentDigest(missing, content)).toBe(false);
    expect(offlineContentDigest(malformed)).toBeNull();
    expect(verifyOfflineContentDigest(malformed, content)).toBe(false);
  });

  it("does not impose the offline digest protocol on online or parsed JSON requests", () => {
    const onlineRaw = requestWith({ "Content-Type": "image/jpeg" });
    const offlineJson = requestWith(
      {
        "Content-Type": "application/json",
        "X-Stavba-Offline-Scope": OFFLINE_SCOPE,
      },
      { name: "Kabel" },
    );

    expect(requiresOfflineContentDigest(onlineRaw)).toBe(false);
    expect(verifyOfflineContentDigest(onlineRaw, content)).toBe(true);
    expect(requiresOfflineContentDigest(offlineJson)).toBe(false);
  });
});

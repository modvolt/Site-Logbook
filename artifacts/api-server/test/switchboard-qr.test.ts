import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  createQrToken,
  decryptQrToken,
  encryptQrToken,
  hashAuditIp,
  hashQrToken,
  publicQrUrl,
  renderQrPng,
} from "../src/lib/switchboard-qr";

describe("opaque switchboard QR tokens", () => {
  const originalKeyring = process.env.SECRET_ENCRYPTION_KEYRING;
  const originalActive = process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID;
  const originalSalt = process.env.QR_AUDIT_SALT;
  const originalPublicUrl = process.env.PUBLIC_APP_URL;

  beforeEach(() => {
    process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID = "test-qr";
    process.env.SECRET_ENCRYPTION_KEYRING = JSON.stringify({
      "test-qr": Buffer.alloc(32, 0x51).toString("base64"),
    });
    process.env.QR_AUDIT_SALT = "test-audit-salt";
    process.env.PUBLIC_APP_URL = "https://example.test";
  });

  afterEach(() => {
    if (originalKeyring == null) delete process.env.SECRET_ENCRYPTION_KEYRING;
    else process.env.SECRET_ENCRYPTION_KEYRING = originalKeyring;
    if (originalActive == null) delete process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID;
    else process.env.SECRET_ENCRYPTION_ACTIVE_KEY_ID = originalActive;
    if (originalSalt == null) delete process.env.QR_AUDIT_SALT;
    else process.env.QR_AUDIT_SALT = originalSalt;
    if (originalPublicUrl == null) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = originalPublicUrl;
  });

  it("creates a non-ID opaque token and stores only hash plus row-bound ciphertext", () => {
    const token = createQrToken();
    const encrypted = encryptQrToken(token, 42);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashQrToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(encrypted.ciphertext).not.toContain(token);
    expect(decryptQrToken(encrypted.ciphertext, 42)).toBe(token);
    expect(() => decryptQrToken(encrypted.ciphertext, 43)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const encrypted = encryptQrToken(createQrToken(), 42);
    const payload = Buffer.from(encrypted.ciphertext.slice(5), "base64url");
    payload[payload.length - 1] ^= 1;
    expect(() =>
      decryptQrToken(`mve1.${payload.toString("base64url")}`, 42),
    ).toThrow();
  });

  it("retains read-only compatibility for pre-0099 QR envelopes", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "legacy-qr-read-key";
    const token = createQrToken();
    const iv = randomBytes(12);
    const key = createHash("sha256")
      .update(process.env.TOKEN_ENCRYPTION_KEY)
      .digest();
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(token, "utf8"),
      cipher.final(),
    ]);
    const payload = [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      ciphertext.toString("base64url"),
    ].join(".");
    expect(decryptQrToken(payload, 42)).toBe(token);
  });

  it("builds only the opaque public path and hashes audit IPs deterministically", () => {
    const token = createQrToken();
    expect(publicQrUrl(token)).toBe(
      `https://example.test/q/board/${token}`,
    );
    expect(hashAuditIp("192.0.2.1")).toBe(hashAuditIp("192.0.2.1"));
    expect(hashAuditIp("192.0.2.1")).not.toContain("192.0.2.1");
  });

  it("renders a high-resolution standalone QR PNG", async () => {
    const png = await renderQrPng(createQrToken());
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(5_000);
  });
});

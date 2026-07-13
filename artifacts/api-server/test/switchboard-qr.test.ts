import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createQrToken, decryptQrToken, encryptQrToken, hashAuditIp, hashQrToken, publicQrUrl, renderQrPng } from "../src/lib/switchboard-qr";

describe("opaque switchboard QR tokens", () => {
  const originalKey = process.env.TOKEN_ENCRYPTION_KEY; const originalSalt = process.env.QR_AUDIT_SALT;
  beforeEach(() => { process.env.TOKEN_ENCRYPTION_KEY = "test-only-qr-encryption-key-32bytes"; process.env.QR_AUDIT_SALT = "test-audit-salt"; });
  afterEach(() => { if (originalKey == null) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = originalKey; if (originalSalt == null) delete process.env.QR_AUDIT_SALT; else process.env.QR_AUDIT_SALT = originalSalt; });
  it("creates a non-ID opaque token and stores only hash plus authenticated ciphertext", () => {
    const token = createQrToken(); const encrypted = encryptQrToken(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(hashQrToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(encrypted).not.toContain(token); expect(decryptQrToken(encrypted)).toBe(token);
  });
  it("rejects tampered ciphertext", () => {
    const encrypted = encryptQrToken(createQrToken());
    const parts = encrypted.split(".");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] ^= 1;
    parts[3] = ciphertext.toString("base64url");
    const changed = parts.join(".");
    expect(() => decryptQrToken(changed)).toThrow();
  });
  it("builds only the opaque public path and hashes audit IPs deterministically", () => {
    const token = createQrToken(); expect(publicQrUrl(token, "https://example.test/")).toBe(`https://example.test/q/board/${token}`);
    expect(hashAuditIp("192.0.2.1")).toBe(hashAuditIp("192.0.2.1")); expect(hashAuditIp("192.0.2.1")).not.toContain("192.0.2.1");
  });
  it("renders a high-resolution standalone QR PNG", async () => {
    const png = await renderQrPng(createQrToken(), "https://modvoltapp.cz");
    expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(png.length).toBeGreaterThan(5_000);
  });
});

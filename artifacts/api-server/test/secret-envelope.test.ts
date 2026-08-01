import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import {
  BACKUP_ACTIVE_KEY_ENV,
  BACKUP_KEYRING_ENV,
  decryptBackupPayload,
  decryptSecretValue,
  encryptBackupPayload,
  encryptSecretValue,
  encryptionStatus,
  envelopeKeyId,
  SecretEncryptionError,
  SECRET_ACTIVE_KEY_ENV,
  SECRET_KEYRING_ENV,
} from "../src/lib/secret-envelope";
import { decryptToken } from "../src/lib/token-crypto";

const originalEnv = { ...process.env };
const keyA = Buffer.alloc(32, 0x11).toString("base64");
const keyB = Buffer.alloc(32, 0x22).toString("base64");

function setKeyring(active = "key-a", includeOld = true): void {
  process.env[SECRET_ACTIVE_KEY_ENV] = active;
  process.env[SECRET_KEYRING_ENV] = JSON.stringify(
    includeOld ? { "key-a": keyA, "key-b": keyB } : { [active]: active === "key-a" ? keyA : keyB },
  );
}

describe("versioned secret envelopes", () => {
  beforeEach(() => setKeyring());
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("round-trips without embedding plaintext and binds AAD to row and field", () => {
    const encrypted = encryptSecretValue(
      "not-in-the-database",
      "email_settings:1:password",
    );
    expect(encrypted.ciphertext).toMatch(/^mve1\./);
    expect(encrypted.ciphertext).not.toContain("not-in-the-database");
    expect(encrypted.keyId).toBe("key-a");
    expect(envelopeKeyId(encrypted.ciphertext)).toBe("key-a");
    expect(
      decryptSecretValue(encrypted.ciphertext, "email_settings:1:password"),
    ).toBe("not-in-the-database");
    expect(() =>
      decryptSecretValue(encrypted.ciphertext, "email_settings:2:password"),
    ).toThrowError(SecretEncryptionError);
  });

  it("detects tampering and never returns unauthenticated bytes", () => {
    const encrypted = encryptSecretValue("secret", "openai_settings:1:api_key");
    const payload = Buffer.from(encrypted.ciphertext.slice(5), "base64url");
    payload[payload.length - 1] ^= 1;
    expect(() =>
      decryptSecretValue(
        `mve1.${payload.toString("base64url")}`,
        "openai_settings:1:api_key",
      ),
    ).toThrowError(/authentication failed/i);
  });

  it("rejects truncated metadata as a controlled encryption error", () => {
    expect(() => envelopeKeyId("mve1.AA")).toThrowError(SecretEncryptionError);
  });

  it("decrypts old-key envelopes during rotation and fails when that key is removed", () => {
    const old = encryptSecretValue("rotating", "device_credentials:7:secret_payload");
    setKeyring("key-b");
    expect(
      decryptSecretValue(old.ciphertext, "device_credentials:7:secret_payload"),
    ).toBe("rotating");

    setKeyring("key-b", false);
    expect(() =>
      decryptSecretValue(old.ciphertext, "device_credentials:7:secret_payload"),
    ).toThrowError(/unavailable key/i);
  });

  it("rejects passphrases and malformed or missing active keys", () => {
    process.env[SECRET_KEYRING_ENV] = JSON.stringify({ "key-a": "password" });
    expect(encryptionStatus()).toMatchObject({ configured: false, errorCode: "keyring_invalid" });

    process.env[SECRET_KEYRING_ENV] = JSON.stringify({ "key-a": keyA });
    process.env[SECRET_ACTIVE_KEY_ENV] = "missing";
    expect(encryptionStatus()).toMatchObject({ configured: false, errorCode: "active_key_missing" });
  });

  it("uses a separate binary envelope and keyring for database backups", () => {
    process.env[BACKUP_ACTIVE_KEY_ENV] = "backup-a";
    process.env[BACKUP_KEYRING_ENV] = JSON.stringify({
      "backup-a": Buffer.alloc(32, 0x44).toString("base64"),
    });
    const dump = Buffer.from("PGDMP\0contains-secrets", "utf8");
    const encrypted = encryptBackupPayload(dump, "stavba-test.pgcustom");
    expect(encrypted.payload.subarray(0, 4).toString("ascii")).toBe("MVE1");
    expect(encrypted.payload.includes(Buffer.from("contains-secrets"))).toBe(false);
    expect(
      decryptBackupPayload(encrypted.payload, "stavba-test.pgcustom"),
    ).toEqual(dump);
    expect(() =>
      decryptBackupPayload(encrypted.payload, "different.pgcustom"),
    ).toThrowError(/authentication failed/i);
  });

  it("retains read-only compatibility for pre-0099 Gmail tokens", () => {
    process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.alloc(32), iv);
    const ciphertext = Buffer.concat([
      cipher.update("legacy-refresh-token", "utf8"),
      cipher.final(),
    ]);
    const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
      "base64",
    );
    expect(decryptToken(payload, 99)).toBe("legacy-refresh-token");
  });
});

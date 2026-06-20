/**
 * Symmetric encryption for OAuth refresh tokens at rest.
 *
 * Refresh tokens are long-lived secrets that must never be stored in plaintext
 * or logged. They are encrypted with AES-256-GCM using a key supplied by the
 * operator via the TOKEN_ENCRYPTION_KEY environment variable. The key is read
 * from the environment only — never persisted — and the whole e-mail-import
 * feature is gated on it being present (see getGmailConfig()).
 *
 * Ciphertext format (single base64 string): iv(12) || authTag(16) || cipher.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * Resolve the 32-byte encryption key from TOKEN_ENCRYPTION_KEY. Accepts a 64-char
 * hex string, a base64 string, or any other string (hashed to 32 bytes as a last
 * resort). Returns null when unset/blank so callers can report "not configured".
 */
function resolveKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  // 64 hex chars → 32 bytes.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }
  // base64 that decodes to exactly 32 bytes.
  try {
    const b = Buffer.from(raw, "base64");
    if (b.length === KEY_LEN) return b;
  } catch {
    // fall through
  }
  // Any other string: derive a stable 32-byte key by SHA-256.
  // (Allows a simple passphrase; still 256-bit entropy-bounded by the input.)
  return createHash("sha256").update(raw, "utf8").digest();
}

/** True when a usable TOKEN_ENCRYPTION_KEY is configured. */
export function isTokenEncryptionConfigured(): boolean {
  return resolveKey() !== null;
}

/** Encrypt a plaintext secret. Throws when no key is configured. */
export function encryptToken(plaintext: string): string {
  const key = resolveKey();
  if (!key) {
    throw new Error("TOKEN_ENCRYPTION_KEY není nastaven.");
  }
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

/** Decrypt a value produced by encryptToken(). Throws on tamper / wrong key. */
export function decryptToken(payload: string): string {
  const key = resolveKey();
  if (!key) {
    throw new Error("TOKEN_ENCRYPTION_KEY není nastaven.");
  }
  const buf = Buffer.from(payload, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("Neplatný šifrovaný token.");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

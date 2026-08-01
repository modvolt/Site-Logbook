/**
 * OAuth refresh-token encryption.
 *
 * New writes use the shared versioned envelope with a row-bound context. The
 * old TOKEN_ENCRYPTION_KEY format is retained strictly for reads during the
 * expand/backfill window.
 */
import {
  createDecipheriv,
  createHash,
} from "node:crypto";
import {
  decryptSecretValue,
  encryptSecretValue,
  encryptionStatus,
} from "./secret-envelope";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

function resolveLegacyKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length === KEY_LENGTH) return decoded;
  } catch {
    // Fall through to the historical passphrase derivation.
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/** New token writes require the strict external application keyring. */
export function isTokenEncryptionConfigured(): boolean {
  return encryptionStatus().configured;
}

export function encryptToken(plaintext: string, accountId: number): string {
  return encryptSecretValue(
    plaintext,
    `email_import_accounts:${accountId}:refresh_token`,
  ).ciphertext;
}

export function decryptToken(payload: string, accountId: number): string {
  if (payload.startsWith("mve1.")) {
    return decryptSecretValue(
      payload,
      `email_import_accounts:${accountId}:refresh_token`,
    );
  }

  const key = resolveLegacyKey();
  if (!key) throw new Error("TOKEN_ENCRYPTION_KEY is not configured for legacy token reads.");
  const buffer = Buffer.from(payload, "base64");
  if (buffer.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Invalid encrypted legacy token.");
  }
  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } finally {
    key.fill(0);
  }
}

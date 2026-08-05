import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { decryptSecretValue, encryptSecretValue } from "./secret-envelope";
import { publicAppUrl } from "./public-origin";

// Keep the historical argument order used by automatic label generation so a
// rolling deployment cannot split the per-board critical section.
export const SWITCHBOARD_QR_LOCK_KEY = 8403;
export const SWITCHBOARD_QR_TTL_YEARS = 5;

export function maximumSwitchboardQrExpiry(now = new Date()): Date {
  if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid QR issuance time.");
  const expiresAt = new Date(now);
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + SWITCHBOARD_QR_TTL_YEARS);
  return expiresAt;
}

/**
 * New and rotated physical-label grants are always finite. A missing/null
 * client value deliberately means the conservative five-year default so old
 * admin clients cannot create another perpetual QR. Existing nullable database
 * rows remain a read-only legacy compatibility case until an approved backfill.
 */
export function resolveSwitchboardQrExpiry(
  requested: Date | null | undefined,
  now = new Date(),
): Date {
  const maximum = maximumSwitchboardQrExpiry(now);
  if (requested == null) return maximum;
  const expiresAt = new Date(requested);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt > maximum
  ) {
    throw new RangeError("QR expiry must be in the future and no more than five years away.");
  }
  return expiresAt;
}

function legacyEncryptionKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is required for legacy QR token reads.");
  return createHash("sha256").update(secret).digest();
}

function qrContext(switchboardId: number): string {
  return `switchboards:${switchboardId}:qr_token`;
}

export function hashQrToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createQrToken(): string {
  return randomBytes(32).toString("base64url");
}

export function encryptQrToken(
  token: string,
  switchboardId: number,
): { ciphertext: string; keyId: string } {
  return encryptSecretValue(token, qrContext(switchboardId));
}

export function decryptQrToken(payload: string, switchboardId: number): string {
  if (!payload.startsWith("v1.")) {
    return decryptSecretValue(payload, qrContext(switchboardId));
  }

  // Read-only compatibility for the legacy QR envelope. Rotation/backfill
  // rewrites it to the shared mve1 format; new writes never create v1 values.
  const [version, iv, tag, encrypted] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) {
    throw new Error("Invalid encrypted legacy QR token.");
  }
  const key = legacyEncryptionKey();
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } finally {
    key.fill(0);
  }
}

export function publicQrUrl(token: string): string {
  return publicAppUrl(`/q/board/${encodeURIComponent(token)}`);
}

export async function renderQrPng(token: string): Promise<Buffer> {
  return QRCode.toBuffer(publicQrUrl(token), {
    type: "png",
    width: 1200,
    margin: 4,
    errorCorrectionLevel: "H",
  });
}

export function hashAuditIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.QR_AUDIT_SALT || process.env.SESSION_SECRET;
  if (!salt) return null;
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";

function encryptionKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.length < 16) throw Object.assign(new Error("Pro QR přístup nastavte TOKEN_ENCRYPTION_KEY (min. 16 znaků)."), { code: "qr_encryption_not_configured" });
  return createHash("sha256").update(secret).digest();
}

export function hashQrToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function createQrToken(): string { return randomBytes(32).toString("base64url"); }

export function encryptQrToken(token: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptQrToken(payload: string): string {
  const [version, iv, tag, encrypted] = payload.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Neplatný šifrovaný QR token.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
}

export function publicQrUrl(token: string, requestBaseUrl?: string): string {
  const base = (process.env.PUBLIC_APP_URL || requestBaseUrl || "https://modvoltapp.cz").replace(/\/$/, "");
  return `${base}/q/board/${token}`;
}

export async function renderQrPng(token: string, requestBaseUrl?: string): Promise<Buffer> {
  return QRCode.toBuffer(publicQrUrl(token, requestBaseUrl), {
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

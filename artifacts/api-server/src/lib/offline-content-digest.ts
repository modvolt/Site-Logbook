import { createHash } from "node:crypto";
import type { Request } from "express";
import { OFFLINE_SCOPE_HEADER } from "../middlewares/offline-replay-scope";

export const OFFLINE_CONTENT_DIGEST_HEADER = "x-stavba-content-sha256";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function offlineContentDigest(req: Request): string | null {
  const value = req.get(OFFLINE_CONTENT_DIGEST_HEADER);
  return value && SHA256_PATTERN.test(value) ? value : null;
}

export function requiresOfflineContentDigest(req: Request): boolean {
  if (!req.get(OFFLINE_SCOPE_HEADER) || req.body !== undefined) return false;
  const contentType = req.get("content-type");
  return typeof contentType === "string" && contentType.length > 0;
}

export function verifyOfflineContentDigest(req: Request, body: Buffer): boolean {
  if (!req.get(OFFLINE_SCOPE_HEADER)) return true;
  const supplied = offlineContentDigest(req);
  if (!supplied) return false;
  return createHash("sha256").update(body).digest("hex") === supplied;
}

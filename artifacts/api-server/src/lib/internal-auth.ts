import { createHash, timingSafeEqual } from "node:crypto";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Compare high-entropy bearer secrets without content- or length-based timing. */
export function secureTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  return timingSafeEqual(digest(provided), digest(expected));
}

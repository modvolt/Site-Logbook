import { createHash } from "node:crypto";

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Evidence JSON contains a non-finite number.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
  }
  throw new Error(`Evidence JSON contains unsupported value type: ${typeof value}.`);
}

export function canonicalEvidenceJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceSha256(value: unknown): string {
  return sha256Hex(canonicalEvidenceJson(value));
}

export function normalizedUserAgentSha256(value: string | undefined): string | null {
  const normalized = value?.trim().slice(0, 1024) ?? "";
  return normalized ? sha256Hex(normalized) : null;
}

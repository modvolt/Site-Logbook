import * as path from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is required for the R14 full-stack gate.`);
  return value;
}

function loopbackHttpUrl(name: string): string {
  const raw = required(name);
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${name} must be a credential-free loopback HTTP URL.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

export const r14Environment = {
  baseURL: loopbackHttpUrl("R14_BASE_URL"),
  sourceSha: required("R14_SOURCE_SHA"),
  adminUsername: required("R14_ADMIN_USERNAME"),
  adminPassword: required("R14_ADMIN_PASSWORD"),
  guestUsername: required("R14_GUEST_USERNAME"),
  guestPassword: required("R14_GUEST_PASSWORD"),
};

if (!/^[0-9a-f]{40}$/.test(r14Environment.sourceSha)) {
  throw new Error("R14_SOURCE_SHA must be a lowercase 40-character Git SHA.");
}

export const r14AuthFile = path.resolve(
  __dirname,
  "..",
  "test-results",
  "r14-full-stack",
  "admin-storage-state.json",
);
export const r14BootstrapFile = path.resolve(
  __dirname,
  "..",
  "test-results",
  "r14-full-stack",
  "bootstrap.json",
);
export const r14BrowserEvidenceFile = path.resolve(
  __dirname,
  "..",
  "test-results",
  "r14-full-stack",
  "browser-evidence.json",
);

export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} returned an invalid JSON object.`);
  }
  return value as Record<string, unknown>;
}

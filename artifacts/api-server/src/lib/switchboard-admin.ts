import { normalizeFieldLabel } from "./switchboard-parser";

export type RegistryNameEntry = {
  id: number;
  fieldKey: string;
  canonicalNameCs: string;
  aliases: string[];
  isActive: boolean;
};

export type RegistryNameCollision = {
  normalizedName: string;
  submittedName: string;
  conflictingFieldKey: string;
  conflictingName: string;
};

export function normalizeRegistryAliases(aliases: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of aliases) {
    const alias = value.trim().replace(/\s+/g, " ");
    const normalized = normalizeFieldLabel(alias);
    if (alias && normalized && !unique.has(normalized)) unique.set(normalized, alias);
  }
  return [...unique.values()];
}

export function findRegistryNameCollision(
  registry: RegistryNameEntry[],
  candidateId: number,
  patch: Partial<Pick<RegistryNameEntry, "aliases" | "isActive">>,
): RegistryNameCollision | null {
  const current = registry.find((field) => field.id === candidateId);
  if (!current) return null;
  const candidate = { ...current, ...patch };
  if (!candidate.isActive) return null;

  const candidateNames = [candidate.canonicalNameCs, ...normalizeRegistryAliases(candidate.aliases)];
  const occupied = new Map<string, { fieldKey: string; name: string }>();
  for (const field of registry) {
    if (field.id === candidateId || !field.isActive) continue;
    for (const name of [field.canonicalNameCs, ...field.aliases]) {
      const normalized = normalizeFieldLabel(name);
      if (normalized && !occupied.has(normalized)) occupied.set(normalized, { fieldKey: field.fieldKey, name });
    }
  }

  for (const name of candidateNames) {
    const normalized = normalizeFieldLabel(name);
    const conflict = occupied.get(normalized);
    if (conflict) {
      return {
        normalizedName: normalized,
        submittedName: name,
        conflictingFieldKey: conflict.fieldKey,
        conflictingName: conflict.name,
      };
    }
  }
  return null;
}

export type SnapshotChange = {
  fieldKey: string;
  before: unknown;
  after: unknown;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value ?? null;
}

export function snapshotValuesEqual(before: unknown, after: unknown): boolean {
  return JSON.stringify(canonicalize(before)) === JSON.stringify(canonicalize(after));
}

export function compareSnapshotRecords(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SnapshotChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys
    .filter((fieldKey) => !snapshotValuesEqual(before[fieldKey], after[fieldKey]))
    .map((fieldKey) => ({ fieldKey, before: before[fieldKey] ?? null, after: after[fieldKey] ?? null }));
}

const SENSITIVE_AUDIT_KEYS = new Set([
  "qrtokenhash",
  "qrtokenciphertext",
  "storagepath",
  "pdfstoragepath",
  "pngstoragepath",
  "password",
  "passwordhash",
  "secret",
  "accesstoken",
  "refreshtoken",
  "apikey",
  "privatekey",
  "credential",
  "authorization",
  "cookie",
  "sessionid",
]);

export function redactSwitchboardAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSwitchboardAuditPayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_AUDIT_KEYS.has(key.replace(/[^a-z0-9]/gi, "").toLocaleLowerCase("en-US")))
      .map(([key, nested]) => [key, redactSwitchboardAuditPayload(nested)]),
  );
}

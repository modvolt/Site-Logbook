import { createHash } from "node:crypto";

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Evidence JSON contains a non-finite number.");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw new Error(
        "Evidence JSON arrays must use the built-in Array prototype.",
      );
    }
    const ownKeys = Reflect.ownKeys(value);
    const expectedKeys = Array.from({ length: value.length }, (_, index) =>
      String(index),
    );
    const stringKeys = ownKeys.filter(
      (key): key is string => typeof key === "string",
    );
    if (
      ownKeys.some((key) => typeof key === "symbol") ||
      stringKeys.length !== expectedKeys.length + 1 ||
      stringKeys.at(-1) !== "length" ||
      expectedKeys.some((key, index) => stringKeys[index] !== key)
    ) {
      throw new Error(
        "Evidence JSON arrays must be dense and cannot have extra properties.",
      );
    }
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(
          "Evidence JSON cannot contain accessors or hidden array values.",
        );
      }
    }
    if (ancestors.has(value))
      throw new Error("Evidence JSON cannot contain cycles.");
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Evidence JSON objects must be plain objects.");
    }
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error("Evidence JSON cannot contain symbol keys.");
    }
    const keys = ownKeys as string[];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(
          "Evidence JSON cannot contain accessors or hidden properties.",
        );
      }
    }
    if (ancestors.has(record))
      throw new Error("Evidence JSON cannot contain cycles.");
    ancestors.add(record);
    try {
      return `{${keys
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`,
        )
        .join(",")}}`;
    } finally {
      ancestors.delete(record);
    }
  }
  throw new Error(
    `Evidence JSON contains unsupported value type: ${typeof value}.`,
  );
}

export function canonicalEvidenceJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

export function sha256Hex(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function evidenceSha256(value: unknown): string {
  return sha256Hex(canonicalEvidenceJson(value));
}

export function normalizedUserAgentSha256(
  value: string | undefined,
): string | null {
  const normalized = value?.trim().slice(0, 1024) ?? "";
  return normalized ? sha256Hex(normalized) : null;
}

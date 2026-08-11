import { canonicalEvidenceJson, sha256Hex } from "./evidence-hash";

const UUID_DOMAIN = "site-logbook.accounting-deterministic-uuid/v1";
const OBJECT_LOCATION_DOMAIN = "site-logbook.accounting-object-location/v1";
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;

export function canonicalAccountingDecimal(value: string): string {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error("Accounting decimal must use plain base-10 notation.");
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer, rawFraction = ""] = unsigned.split(".");
  const fraction = rawFraction.replace(/0+$/, "");
  if (fraction.length > 4) {
    throw new Error("Accounting decimal scale exceeds four places.");
  }
  const zero = integer === "0" && fraction.length === 0;
  return `${negative && !zero ? "-" : ""}${integer}${
    fraction.length ? `.${fraction}` : ""
  }`;
}

export function accountingDecimalToScaled(value: string): bigint {
  const canonical = canonicalAccountingDecimal(value);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integer, fraction = ""] = unsigned.split(".");
  const scaled = BigInt(`${integer}${fraction.padEnd(4, "0")}`);
  return negative ? -scaled : scaled;
}

export function accountingScaledToDecimal(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const integer = absolute / 10_000n;
  const fraction = String(absolute % 10_000n)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

export function deterministicAccountingUuid(
  label: string,
  value: unknown,
): string {
  const digest = sha256Hex(
    `${UUID_DOMAIN}\0${label}\0${canonicalEvidenceJson(value)}`,
  );
  const chars = digest.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = "8";
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function positiveAccountingId(
  value: number | null,
  label: string,
): string | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return String(value);
}

export function requiredPositiveAccountingId(
  value: number | null,
  label: string,
): string {
  const id = positiveAccountingId(value, label);
  if (id === null) throw new Error(`${label} is required.`);
  return id;
}

export function canonicalAccountingSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftJson = canonicalEvidenceJson(left);
    const rightJson = canonicalEvidenceJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

export function accountingObjectLocationSha256(objectPath: string): string {
  return sha256Hex(`${OBJECT_LOCATION_DOMAIN}\0${objectPath}`);
}

import { isAbsolute, resolve } from "node:path";
import { ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES } from "../lib/accounting-warehouse-price-bootstrap-activation-artifacts";

export const WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SET_BYTES = 402_653_184;
export const WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_REPORT_BYTES = 268_435_456;
export const WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_JSON_BYTES = 67_108_864;
export const WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SMALL_JSON_BYTES = 8_388_608;

export type WarehousePriceBootstrapActivationVerificationMode =
  | "preflight"
  | "receipt";

export interface WarehousePriceBootstrapActivationVerifyOptions {
  mode: WarehousePriceBootstrapActivationVerificationMode;
  artifactDirectory: string;
  expectedPreflightFileSha256: string;
  expectedReceiptFileSha256: string | null;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_MUTATION_PREFIXES = [
  "--activate",
  "--apply",
  "--execute",
  "--backfill",
  "--migrate",
  "--deploy",
  "--update",
  "--delete",
  "--write",
  "--write-database",
  "--database",
  "--output",
] as const;

function exactArgument(args: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const matches = args.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(
      `Activation verifier requires exactly one ${name}=<value> argument.`,
    );
  }
  const value = matches[0]!.slice(prefix.length);
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${name} must contain one exact non-empty value.`);
  }
  return value;
}

function optionalExactArgument(
  args: readonly string[],
  name: string,
): string | null {
  const prefix = `${name}=`;
  const matches = args.filter((value) => value.startsWith(prefix));
  if (matches.length > 1) {
    throw new Error(
      `Activation verifier accepts at most one ${name}=<value> argument.`,
    );
  }
  if (matches.length === 0) return null;
  const value = matches[0]!.slice(prefix.length);
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${name} must contain one exact non-empty value.`);
  }
  return value;
}

export function activationArtifactNames(
  mode: WarehousePriceBootstrapActivationVerificationMode,
): readonly string[] {
  const names = ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES;
  const common = [
    names.stagingReleaseEvidence,
    names.stagingReleaseVerification,
    names.lineageEvidence,
    names.backupEvidence,
    names.sourceParityReport,
    names.plan,
    names.approval,
    names.authorization,
    names.preflight,
  ];
  return Object.freeze(
    mode === "receipt"
      ? [
          ...common,
          names.beforeParityReport,
          names.afterParityReport,
          names.receipt,
        ].sort()
      : common.sort(),
  );
}

export function maximumActivationArtifactBytes(filename: string): number {
  const names = ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES;
  if (
    filename === names.sourceParityReport ||
    filename === names.beforeParityReport ||
    filename === names.afterParityReport
  ) {
    return WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_REPORT_BYTES;
  }
  if (
    filename === names.plan ||
    filename === names.stagingReleaseEvidence ||
    filename === names.receipt
  ) {
    return WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_JSON_BYTES;
  }
  if (activationArtifactNames("receipt").includes(filename)) {
    return WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SMALL_JSON_BYTES;
  }
  throw new Error(
    `Unsupported activation artifact filename ${JSON.stringify(filename)}.`,
  );
}

export function assertActivationArtifactSize(
  filename: string,
  sizeBytes: number,
): void {
  const maximum = maximumActivationArtifactBytes(filename);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`${filename} must have a positive safe byte size.`);
  }
  if (sizeBytes > maximum) {
    throw new Error(`${filename} exceeds its hard maximum ${maximum} bytes.`);
  }
}

export function assertExactActivationArtifactLayout(
  mode: WarehousePriceBootstrapActivationVerificationMode,
  names: readonly string[],
): void {
  const actual = [...names].sort();
  const expected = [...activationArtifactNames(mode)];
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Activation artifact directory layout mismatch: expected ${expected.join(", ")}.`,
    );
  }
}

export function parseWarehousePriceBootstrapActivationVerifyOptions(
  args: readonly string[],
): WarehousePriceBootstrapActivationVerifyOptions {
  for (const argument of args) {
    if (
      FORBIDDEN_MUTATION_PREFIXES.some(
        (prefix) => argument === prefix || argument.startsWith(`${prefix}=`),
      )
    ) {
      throw new Error(
        `${argument.split("=")[0]} is forbidden: the activation verifier is read-only.`,
      );
    }
  }
  const mode = exactArgument(args, "--mode");
  if (mode !== "preflight" && mode !== "receipt") {
    throw new Error("--mode must be exactly preflight or receipt.");
  }
  const artifactDirectory = exactArgument(args, "--artifact-dir");
  if (!isAbsolute(artifactDirectory)) {
    throw new Error("--artifact-dir must be an absolute path.");
  }
  const expectedPreflightFileSha256 = exactArgument(
    args,
    "--expected-preflight-file-sha256",
  );
  if (!SHA256_PATTERN.test(expectedPreflightFileSha256)) {
    throw new Error(
      "--expected-preflight-file-sha256 must be a lowercase SHA-256 digest.",
    );
  }
  const expectedReceiptFileSha256 = optionalExactArgument(
    args,
    "--expected-receipt-file-sha256",
  );
  if (
    mode === "receipt" &&
    (expectedReceiptFileSha256 === null ||
      !SHA256_PATTERN.test(expectedReceiptFileSha256))
  ) {
    throw new Error(
      "Receipt mode requires --expected-receipt-file-sha256 with a lowercase SHA-256 digest.",
    );
  }
  if (mode === "preflight" && expectedReceiptFileSha256 !== null) {
    throw new Error("Preflight mode forbids --expected-receipt-file-sha256.");
  }
  const knownPrefixes = [
    "--mode=",
    "--artifact-dir=",
    "--expected-preflight-file-sha256=",
    "--expected-receipt-file-sha256=",
  ];
  const unknown = args.find(
    (argument) => !knownPrefixes.some((prefix) => argument.startsWith(prefix)),
  );
  if (unknown) {
    throw new Error(
      `Unsupported activation verifier argument ${JSON.stringify(unknown)}.`,
    );
  }
  return Object.freeze({
    mode,
    artifactDirectory: resolve(artifactDirectory),
    expectedPreflightFileSha256,
    expectedReceiptFileSha256,
  });
}

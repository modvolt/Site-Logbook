export const WAREHOUSE_PRICE_BOOTSTRAP_MAX_PLANNED_ITEMS = 20_000;
export const WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES = 268_435_456;

export interface WarehousePriceBootstrapPlanOptions {
  parityReportPath: string;
  expectedReportFileSha256: string;
  maxPlannedItems: number;
}

export interface WarehousePriceBootstrapVerifyOptions {
  planPath: string;
  expectedPlanFileSha256: string;
  parityReportPath: string;
  expectedReportFileSha256: string;
}

export function assertWarehousePriceBootstrapReportFileSize(
  sizeBytes: number,
): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(
      "Warehouse-price parity report file must have a positive safe byte size.",
    );
  }
  if (sizeBytes > WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES) {
    throw new Error(
      `Warehouse-price parity report file exceeds the hard maximum ${WAREHOUSE_PRICE_BOOTSTRAP_MAX_REPORT_BYTES} bytes.`,
    );
  }
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FORBIDDEN_MUTATION_PREFIXES = [
  "--apply",
  "--execute",
  "--backfill",
  "--update",
  "--delete",
  "--write-database",
] as const;

function exactArgument(args: readonly string[], name: string): string {
  const prefix = `${name}=`;
  const matches = args.filter((value) => value.startsWith(prefix));
  if (matches.length !== 1) {
    throw new Error(`Planner requires exactly one ${name}=<value> argument.`);
  }
  const value = matches[0]!.slice(prefix.length);
  if (!value || value !== value.trim() || value.includes("\0")) {
    throw new Error(`${name} must contain one exact non-empty value.`);
  }
  return value;
}

function boundedInteger(
  args: readonly string[],
  name: string,
  maximum: number,
): number {
  const raw = exactArgument(args, name);
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) {
    throw new Error(`${name} exceeds the hard maximum ${maximum}.`);
  }
  return value;
}

export function parseWarehousePriceBootstrapPlanOptions(
  args: readonly string[],
): WarehousePriceBootstrapPlanOptions {
  for (const argument of args) {
    if (
      FORBIDDEN_MUTATION_PREFIXES.some(
        (prefix) => argument === prefix || argument.startsWith(`${prefix}=`),
      )
    ) {
      throw new Error(
        `${argument.split("=")[0]} is forbidden: this planner has no mutation mode.`,
      );
    }
  }
  const parityReportPath = exactArgument(args, "--parity-report");
  const expectedReportFileSha256 = exactArgument(
    args,
    "--expected-report-file-sha256",
  );
  if (!SHA256_PATTERN.test(expectedReportFileSha256)) {
    throw new Error(
      "--expected-report-file-sha256 must be a lowercase SHA-256 digest.",
    );
  }
  const maxPlannedItems = boundedInteger(
    args,
    "--max-planned-items",
    WAREHOUSE_PRICE_BOOTSTRAP_MAX_PLANNED_ITEMS,
  );
  const knownPrefixes = [
    "--parity-report=",
    "--expected-report-file-sha256=",
    "--max-planned-items=",
  ];
  const unknown = args.find(
    (argument) => !knownPrefixes.some((prefix) => argument.startsWith(prefix)),
  );
  if (unknown) {
    throw new Error(`Unsupported planner argument ${JSON.stringify(unknown)}.`);
  }
  return Object.freeze({
    parityReportPath,
    expectedReportFileSha256,
    maxPlannedItems,
  });
}

export function parseWarehousePriceBootstrapVerifyOptions(
  args: readonly string[],
): WarehousePriceBootstrapVerifyOptions {
  for (const argument of args) {
    if (
      FORBIDDEN_MUTATION_PREFIXES.some(
        (prefix) => argument === prefix || argument.startsWith(`${prefix}=`),
      )
    ) {
      throw new Error(
        `${argument.split("=")[0]} is forbidden: this verifier has no mutation mode.`,
      );
    }
  }
  const planPath = exactArgument(args, "--plan");
  const expectedPlanFileSha256 = exactArgument(
    args,
    "--expected-plan-file-sha256",
  );
  const parityReportPath = exactArgument(args, "--parity-report");
  const expectedReportFileSha256 = exactArgument(
    args,
    "--expected-report-file-sha256",
  );
  if (!SHA256_PATTERN.test(expectedPlanFileSha256)) {
    throw new Error(
      "--expected-plan-file-sha256 must be a lowercase SHA-256 digest.",
    );
  }
  if (!SHA256_PATTERN.test(expectedReportFileSha256)) {
    throw new Error(
      "--expected-report-file-sha256 must be a lowercase SHA-256 digest.",
    );
  }
  const knownPrefixes = [
    "--plan=",
    "--expected-plan-file-sha256=",
    "--parity-report=",
    "--expected-report-file-sha256=",
  ];
  const unknown = args.find(
    (argument) => !knownPrefixes.some((prefix) => argument.startsWith(prefix)),
  );
  if (unknown) {
    throw new Error(
      `Unsupported verifier argument ${JSON.stringify(unknown)}.`,
    );
  }
  return Object.freeze({
    planPath,
    expectedPlanFileSha256,
    parityReportPath,
    expectedReportFileSha256,
  });
}

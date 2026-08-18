import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES,
  canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson,
  createAccountingWarehousePriceBootstrapOfflineVerificationSummary,
  verifyAccountingWarehousePriceBootstrapPreflightArtifactSet,
  verifyAccountingWarehousePriceBootstrapReceiptArtifactSet,
} from "../lib/accounting-warehouse-price-bootstrap-activation-artifacts";
import { sha256Hex } from "../lib/evidence-hash";
import {
  activationArtifactNames,
  assertActivationArtifactSize,
  assertExactActivationArtifactLayout,
  parseWarehousePriceBootstrapActivationVerifyOptions,
  WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SET_BYTES,
  type WarehousePriceBootstrapActivationVerificationMode,
} from "./warehouse-price-bootstrap-activation-verifier-policy";

async function readStableRegularFile(
  path: string,
  filename: string,
  expectedSize: number,
): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size !== expectedSize) {
      throw new Error(`${filename} changed before it could be read.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      bytes.byteLength !== expectedSize ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`${filename} changed while it was being read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readExactArtifactDirectory(
  directory: string,
  mode: WarehousePriceBootstrapActivationVerificationMode,
): Promise<Record<string, Buffer>> {
  const directoryMetadata = await lstat(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(
      "Activation artifact path must be a non-symlink directory.",
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  assertExactActivationArtifactLayout(
    mode,
    entries.map((entry) => entry.name),
  );
  const expectedNames = activationArtifactNames(mode);
  const sizes = new Map<string, number>();
  let aggregateSize = 0;
  for (const filename of expectedNames) {
    const entry = entries.find((candidate) => candidate.name === filename);
    if (!entry || !entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${filename} must be a regular non-symlink file.`);
    }
    const path = join(directory, filename);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`${filename} must be a regular non-symlink file.`);
    }
    assertActivationArtifactSize(filename, metadata.size);
    aggregateSize += metadata.size;
    if (aggregateSize > WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SET_BYTES) {
      throw new Error(
        `Activation artifact set exceeds the hard aggregate maximum ${WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_MAX_SET_BYTES} bytes.`,
      );
    }
    sizes.set(filename, metadata.size);
  }
  const artifacts: Record<string, Buffer> = {};
  // Reads are intentionally sequential and happen only after all limits pass.
  for (const filename of expectedNames) {
    artifacts[filename] = await readStableRegularFile(
      join(directory, filename),
      filename,
      sizes.get(filename)!,
    );
  }
  return artifacts;
}

function requiredArtifact(
  artifacts: Readonly<Record<string, Buffer>>,
  filename: string,
): Buffer {
  const value = artifacts[filename];
  if (!value) throw new Error(`Missing activation artifact ${filename}.`);
  return value;
}

async function main(): Promise<void> {
  const options = parseWarehousePriceBootstrapActivationVerifyOptions(
    process.argv.slice(2),
  );
  const artifacts = await readExactArtifactDirectory(
    options.artifactDirectory,
    options.mode,
  );
  const names = ACCOUNTING_WAREHOUSE_PRICE_BOOTSTRAP_ACTIVATION_FILENAMES;
  const preflightBytes = requiredArtifact(artifacts, names.preflight);
  const preflightFileSha256 = sha256Hex(preflightBytes);
  if (preflightFileSha256 !== options.expectedPreflightFileSha256) {
    throw new Error(
      "Warehouse-price activation preflight file digest does not match the approved value.",
    );
  }
  const common = {
    stagingReleaseEvidenceBytes: requiredArtifact(
      artifacts,
      names.stagingReleaseEvidence,
    ),
    stagingReleaseVerificationBytes: requiredArtifact(
      artifacts,
      names.stagingReleaseVerification,
    ),
    lineageEvidenceBytes: requiredArtifact(artifacts, names.lineageEvidence),
    backupEvidenceBytes: requiredArtifact(artifacts, names.backupEvidence),
    sourceParityReportBytes: requiredArtifact(
      artifacts,
      names.sourceParityReport,
    ),
    planBytes: requiredArtifact(artifacts, names.plan),
    approvalBytes: requiredArtifact(artifacts, names.approval),
    authorizationBytes: requiredArtifact(artifacts, names.authorization),
    preflightBytes,
  };
  if (options.mode === "preflight") {
    const preflight =
      verifyAccountingWarehousePriceBootstrapPreflightArtifactSet(common);
    process.stdout.write(
      canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson(
        createAccountingWarehousePriceBootstrapOfflineVerificationSummary({
          mode: "preflight",
          preflight,
          preflightFileSha256,
        }),
      ),
    );
    return;
  }
  const receiptBytes = requiredArtifact(artifacts, names.receipt);
  const receiptFileSha256 = sha256Hex(receiptBytes);
  if (receiptFileSha256 !== options.expectedReceiptFileSha256) {
    throw new Error(
      "Warehouse-price bootstrap receipt file digest does not match the approved value.",
    );
  }
  const verified = verifyAccountingWarehousePriceBootstrapReceiptArtifactSet({
    ...common,
    beforeParityReportBytes: requiredArtifact(
      artifacts,
      names.beforeParityReport,
    ),
    afterParityReportBytes: requiredArtifact(
      artifacts,
      names.afterParityReport,
    ),
    receiptBytes,
  });
  process.stdout.write(
    canonicalAccountingWarehousePriceBootstrapOfflineVerificationSummaryJson(
      createAccountingWarehousePriceBootstrapOfflineVerificationSummary({
        mode: "receipt",
        preflight: verified.preflight,
        preflightFileSha256,
        receipt: verified.receipt,
        receiptFileSha256,
      }),
    ),
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Warehouse-price activation verification failed."}\n`,
  );
  process.exitCode = 1;
});

import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES,
  MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES,
  MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES,
  verifyAccountingArchive,
} from "../lib/accounting-archive-contract";

function requiredOption(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredAbsolutePath(name: string): string {
  const value = requiredOption(name);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      `Archive input must be a regular non-symlink file: ${path}`,
    );
  }
  if (metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error(
      `Archive input size must be between 1 and ${maximumBytes} bytes: ${path}`,
    );
  }
  const body = await readFile(path);
  if (body.byteLength !== metadata.size) {
    throw new Error(`Archive input changed while it was being read: ${path}`);
  }
  return body;
}

async function main(): Promise<void> {
  const bundlePath = requiredAbsolutePath("--bundle");
  const checksumPath = requiredAbsolutePath("--checksum");
  const manifestPath = requiredAbsolutePath("--manifest");
  if (new Set([bundlePath, checksumPath, manifestPath]).size !== 3) {
    throw new Error("Bundle, checksum and manifest paths must be distinct.");
  }
  const [bundleBytes, checksumBytes, manifestBytes] = await Promise.all([
    readBoundedRegularFile(bundlePath, MAX_ACCOUNTING_ARCHIVE_BUNDLE_BYTES),
    readBoundedRegularFile(checksumPath, MAX_ACCOUNTING_ARCHIVE_CHECKSUM_BYTES),
    readBoundedRegularFile(manifestPath, MAX_ACCOUNTING_ARCHIVE_MANIFEST_BYTES),
  ]);
  const expectedIntentId = requiredOption("--expected-intent-id");
  const verified = verifyAccountingArchive({
    bundleBytes,
    checksumBytes,
    manifestBytes,
    observedManifestVersionId: requiredOption("--observed-manifest-version-id"),
    expectedReceipt: {
      manifestObjectKey: requiredOption("--expected-manifest-object-key"),
      manifestVersionId: requiredOption("--expected-manifest-version-id"),
      manifestSha256: requiredOption("--expected-manifest-sha256"),
      bundleSha256: requiredOption("--expected-bundle-sha256"),
      checksumSha256: requiredOption("--expected-checksum-sha256"),
    },
  });
  if (verified.intent.intentId !== expectedIntentId) {
    throw new Error(
      "Verified archive intent does not match the approved intent ID.",
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        intentId: verified.intent.intentId,
        operation: verified.intent.operation,
        recordedAt: verified.intent.recordedAt,
        entryCount: verified.intent.entries.length,
        manifestObjectKey: verified.receipt.manifestObjectKey,
        manifestVersionId: verified.receipt.manifestVersionId,
        manifestSha256: verified.receipt.manifestSha256,
        bundleSha256: verified.receipt.bundleSha256,
        checksumSha256: verified.receipt.checksumSha256,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Accounting archive verification failed."}\n`,
  );
  process.exitCode = 1;
});

import { isAbsolute, resolve } from "node:path";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  checkObjectRecoveryBundleFreshness,
  createObjectRecoveryBundle,
  recoveryStorageFingerprint,
  restoreObjectRecoveryBundle,
  verifyObjectRecoveryBundle,
} from "../lib/object-recovery";
import { evaluateRecoveryStorageReadiness } from "../lib/recovery-storage-readiness";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function requiredAbsolutePath(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required.`);
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  const resolved = resolve(value);
  return resolved;
}

function flag(name: string): boolean {
  return process.argv.includes(name);
}

function positiveNumberOption(
  name: string,
  fallback?: number,
): number | undefined {
  const value = option(name);
  if (value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const storage = new ObjectStorageService();

  if (command === "identity") {
    const identity = storage.getRecoveryStorageIdentity();
    printResult({
      identity,
      fingerprint: recoveryStorageFingerprint(identity),
    });
    return;
  }

  if (command === "preflight") {
    const result = evaluateRecoveryStorageReadiness(
      await storage.inspectRecoveryStorageReadiness(),
      {
        expectedFingerprint: option("--expected-fingerprint") ?? undefined,
        allowInsecureLoopback: flag("--allow-http-loopback"),
        requireVersioning: flag("--require-versioning"),
        requireObjectLock: flag("--require-object-lock"),
        minimumDefaultRetentionDays:
          positiveNumberOption("--minimum-retention-days", 0) ?? 0,
        requireEncryption: flag("--require-encryption"),
        requirePublicAccessBlock: flag("--require-public-access-block"),
      },
    );
    printResult(result);
    if (!result.ready) process.exitCode = 2;
    return;
  }

  if (command === "snapshot") {
    const outputDir = requiredAbsolutePath("--output");
    printResult(
      await createObjectRecoveryBundle(storage, outputDir, {
        chunkSizeBytes: positiveNumberOption("--chunk-bytes"),
      }),
    );
    return;
  }

  if (command === "verify") {
    const bundleDir = requiredAbsolutePath("--bundle");
    printResult(await verifyObjectRecoveryBundle(bundleDir));
    return;
  }

  if (command === "freshness") {
    const bundleDir = requiredAbsolutePath("--bundle");
    const maxAgeHours = positiveNumberOption("--max-age-hours");
    if (maxAgeHours === undefined)
      throw new Error("--max-age-hours is required.");
    const result = await checkObjectRecoveryBundleFreshness(
      bundleDir,
      maxAgeHours,
    );
    printResult(result);
    if (!result.fresh) process.exitCode = 2;
    return;
  }

  if (command === "restore") {
    const bundleDir = requiredAbsolutePath("--bundle");
    const expectedFingerprint = option("--target-fingerprint");
    const identity = storage.getRecoveryStorageIdentity();
    const actualFingerprint = recoveryStorageFingerprint(identity);
    if (!expectedFingerprint || expectedFingerprint !== actualFingerprint) {
      throw new Error(
        "Restore target fingerprint is missing or does not match the configured object store.",
      );
    }
    printResult(
      await restoreObjectRecoveryBundle(storage, bundleDir, {
        confirmIsolatedTarget:
          process.env.OBJECT_RECOVERY_CONFIRM_ISOLATED_TARGET === "true",
      }),
    );
    return;
  }

  throw new Error(
    "Usage: object-recovery <identity|preflight|snapshot|verify|freshness|restore> " +
      "[--output ABSOLUTE_PATH] [--bundle ABSOLUTE_PATH] " +
      "[--chunk-bytes N] [--max-age-hours N] [--target-fingerprint SHA256] " +
      "[--expected-fingerprint SHA256] [--require-versioning] " +
      "[--require-object-lock] [--minimum-retention-days N] " +
      "[--require-encryption] [--require-public-access-block] " +
      "[--allow-http-loopback]",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Object recovery failed: ${message}\n`);
  process.exitCode = 1;
});

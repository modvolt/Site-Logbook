import { isAbsolute, resolve } from "node:path";
import { ObjectStorageService } from "../lib/objectStorage";
import {
  createObjectRecoveryBundle,
  recoveryStorageFingerprint,
  restoreObjectRecoveryBundle,
  verifyObjectRecoveryBundle,
} from "../lib/object-recovery";

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

function printResult(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const storage = new ObjectStorageService();

  if (command === "identity") {
    const identity = storage.getRecoveryStorageIdentity();
    printResult({ identity, fingerprint: recoveryStorageFingerprint(identity) });
    return;
  }

  if (command === "snapshot") {
    const outputDir = requiredAbsolutePath("--output");
    printResult(await createObjectRecoveryBundle(storage, outputDir));
    return;
  }

  if (command === "verify") {
    const bundleDir = requiredAbsolutePath("--bundle");
    printResult(await verifyObjectRecoveryBundle(bundleDir));
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
    "Usage: object-recovery <identity|snapshot|verify|restore> " +
      "[--output ABSOLUTE_PATH] [--bundle ABSOLUTE_PATH] " +
      "[--target-fingerprint SHA256]",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Object recovery failed: ${message}\n`);
  process.exitCode = 1;
});

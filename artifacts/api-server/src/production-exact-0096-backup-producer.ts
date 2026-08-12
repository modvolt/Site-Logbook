import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_REQUEST_BYTES = 512 * 1024;
const OPERATION = /^[a-z][A-Za-z0-9]{2,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{3,511}$/;
const FORBIDDEN_KEY =
  /^(?:password|passwd|privateKey|secretKey|clientSecret|credential|databaseUrl|connectionString|snapshotToken|accessToken|authToken|apiKey)$/i;
const FORBIDDEN_VALUE = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
];
const OPERATIONS = Object.freeze([
  "observeExecutorIdentity",
  "observeImmutableProductionSourceReadOnly",
  "proveProductionWritersStopped",
  "openExportedReadOnlySnapshot",
  "readFrozenRelationManifestMeasurements",
  "createBoundedPgDumpCustom",
  "encryptAndPersistVersionedPayload",
  "headExactVersionedPayloadReadOnly",
  "restoreIntoNewDisposablePostgres16",
  "observeRestoredJournalSchemaAndContentReadOnly",
  "reobserveProductionSourceReadOnly",
]);

export class ProductionExact0096ProducerEntrypointError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProductionExact0096ProducerEntrypointError";
  }
}

function fail(code: string): never {
  throw new ProductionExact0096ProducerEntrypointError(code);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalValue(value))}\n`;
}

function rejectSecrets(value: unknown, key = "request"): void {
  if (FORBIDDEN_KEY.test(key))
    fail("PRODUCTION_BACKUP_PRODUCER_SECRET_REJECTED");
  if (typeof value === "string") {
    if (FORBIDDEN_VALUE.some((pattern) => pattern.test(value))) {
      fail("PRODUCTION_BACKUP_PRODUCER_SECRET_REJECTED");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => rejectSecrets(item));
    return;
  }
  if (value && typeof value === "object") {
    for (const [itemKey, item] of Object.entries(value)) {
      rejectSecrets(item, itemKey);
    }
  }
}

export async function readCanonicalProductionBackupProducerRequest(
  requestPath: string,
  dependencies: {
    isReviewedContainerPath?: (value: string) => boolean;
  } = {},
): Promise<Readonly<Record<string, unknown>>> {
  const isReviewedContainerPath =
    dependencies.isReviewedContainerPath ??
    ((value: string) =>
      isAbsolute(value) &&
      SAFE_PATH.test(value) &&
      !value.split("/").some((part) => part === ".."));
  if (!isReviewedContainerPath(requestPath)) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_PATH_INVALID");
  }
  const metadata = await lstat(requestPath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 3 ||
    metadata.size > MAX_REQUEST_BYTES
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  const handle = await open(requestPath, "r");
  let raw: string;
  try {
    const bytes = Buffer.alloc(metadata.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_CHANGED");
    raw = bytes.toString("utf8");
  } finally {
    await handle.close();
  }
  const after = await lstat(requestPath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.size !== metadata.size ||
    after.dev !== metadata.dev ||
    after.ino !== metadata.ino ||
    after.mtimeMs !== metadata.mtimeMs
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_CHANGED");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    canonicalJson(parsed) !== raw
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  rejectSecrets(parsed);
  return Object.freeze(parsed as Record<string, unknown>);
}

export async function runProductionExact0096BackupProducerCli(
  argv: readonly string[],
  io: { stdout(value: string): void; stderr(value: string): void } = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  dependencies: {
    isReviewedContainerPath?: (value: string) => boolean;
  } = {},
): Promise<number> {
  try {
    if (
      argv.length !== 3 ||
      !OPERATION.test(argv[0] ?? "") ||
      !OPERATIONS.includes(argv[0] ?? "") ||
      argv[1] !== "--request-file"
    ) {
      fail("PRODUCTION_BACKUP_PRODUCER_ARGUMENT_INVALID");
    }
    await readCanonicalProductionBackupProducerRequest(argv[2], dependencies);
    // The executable boundary is intentionally present but default-dark. The
    // operation handlers require separately reviewed Docker/disposable-restore
    // lifecycle wiring; no generic shell, SQL, or credential-bearing escape is
    // permitted here in the meantime.
    fail("PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED");
  } catch (error) {
    const code =
      error instanceof ProductionExact0096ProducerEntrypointError
        ? error.code
        : "PRODUCTION_BACKUP_PRODUCER_FAILED";
    io.stderr(`${code}\n`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runProductionExact0096BackupProducerCli(
    process.argv.slice(2),
  );
}

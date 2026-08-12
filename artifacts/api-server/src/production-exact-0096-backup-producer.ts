import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_PAYLOAD_BYTES = 256 * 1024 * 1024;
const OPERATION = /^[a-z][A-Za-z0-9]{2,63}$/;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]{3,511}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const HEX_ID = /^[0-9a-f]{64}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,255}$/;
const BUCKET = /^(?!xn--)(?!.*\.\.)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const EXACT_BACKUP_KEY =
  /^private\/production\/exact-0096\/[A-Za-z0-9][A-Za-z0-9._/-]{7,511}$/;
const ETAG = /^"[0-9a-f]{32,64}(?:-[1-9][0-9]*)?"$/;
const FORBIDDEN_KEY =
  /^(?:password|passwd|privateKey|secretKey|clientSecret|credential|databaseUrl|connectionString|snapshotToken|accessToken|authToken|apiKey)$/i;
const FORBIDDEN_VALUE = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/i,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:@/]+:[^\s@/]+@/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /(?:^|[?&;\s])(?:password|passwd|pwd|secret|access[_-]?token|api[_-]?key)=\S+/i,
];
export const PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS = Object.freeze([
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
] as const);
export const PRODUCTION_EXACT_0096_SESSION_OPERATIONS = Object.freeze([
  "openExportedReadOnlySnapshot",
  "readFrozenRelationManifestMeasurements",
  "createBoundedPgDumpCustom",
  "encryptAndPersistVersionedPayload",
  "headExactVersionedPayloadReadOnly",
] as const);

export type ProductionExact0096ProducerOperation =
  (typeof PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS)[number];

export type ProductionExact0096ProducerOperationHandler = (
  request: Readonly<Record<string, unknown>>,
) => Promise<Readonly<Record<string, unknown>>>;

export type ProductionExact0096ProducerOperationHandlers = Readonly<
  Record<
    ProductionExact0096ProducerOperation,
    ProductionExact0096ProducerOperationHandler
  >
>;
export type ProductionExact0096SessionOperation =
  (typeof PRODUCTION_EXACT_0096_SESSION_OPERATIONS)[number];
export type ProductionExact0096SessionOperationHandlers = Readonly<
  Record<
    ProductionExact0096SessionOperation,
    ProductionExact0096ProducerOperationHandler
  >
>;

const OPERATION_REQUEST_FIELDS: Readonly<
  Record<ProductionExact0096ProducerOperation, readonly string[]>
> = Object.freeze({
  observeExecutorIdentity: Object.freeze(["planSha256"]),
  observeImmutableProductionSourceReadOnly: Object.freeze(["planSha256"]),
  proveProductionWritersStopped: Object.freeze([
    "boundary",
    "maintenanceWindowId",
    "runtimeBindingSha256",
    "sourceSha",
  ]),
  openExportedReadOnlySnapshot: Object.freeze(["transactionMode"]),
  readFrozenRelationManifestMeasurements: Object.freeze(["snapshotHandleId"]),
  createBoundedPgDumpCustom: Object.freeze([
    "ceilingBytes",
    "snapshotHandleId",
  ]),
  encryptAndPersistVersionedPayload: Object.freeze([
    "abortWriteOnOverflow",
    "ceilingBytes",
    "deletePartialObjectOnOverflow",
    "dumpCanonical",
    "dumpId",
    "enforcement",
    "terminateProducerOnOverflow",
  ]),
  headExactVersionedPayloadReadOnly: Object.freeze([
    "bucket",
    "key",
    "versionId",
  ]),
  restoreIntoNewDisposablePostgres16: Object.freeze([
    "backupObjectCanonical",
    "encryptedPayloadSha256",
    "sourceDumpSha256",
  ]),
  observeRestoredJournalSchemaAndContentReadOnly: Object.freeze(["restoreId"]),
  reobserveProductionSourceReadOnly: Object.freeze([
    "boundary",
    "maintenanceWindowId",
  ]),
});

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

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  errorCode: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(errorCode);
  }
  const object = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(object).sort()) !==
    JSON.stringify([...expectedKeys].sort())
  ) {
    fail(errorCode);
  }
  return Object.freeze(object);
}

function validateOperationHandlers(
  value: unknown,
): ProductionExact0096ProducerOperationHandlers {
  const handlers = exactObject(
    value,
    PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS,
    "PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID",
  );
  for (const operation of PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS) {
    if (typeof handlers[operation] !== "function") {
      fail("PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID");
    }
  }
  return handlers as ProductionExact0096ProducerOperationHandlers;
}

function validateSessionOperationHandlers(
  value: unknown,
): ProductionExact0096SessionOperationHandlers {
  const handlers = exactObject(
    value,
    PRODUCTION_EXACT_0096_SESSION_OPERATIONS,
    "PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID",
  );
  for (const operation of PRODUCTION_EXACT_0096_SESSION_OPERATIONS) {
    if (typeof handlers[operation] !== "function") {
      fail("PRODUCTION_BACKUP_PRODUCER_HANDLERS_INVALID");
    }
  }
  return handlers as ProductionExact0096SessionOperationHandlers;
}

function exactString(
  value: unknown,
  pattern: RegExp,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    !pattern.test(value)
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  return value;
}

function exactDigest(value: unknown): void {
  const digest = exactString(value, DIGEST, 71);
  if (digest === `sha256:${"0".repeat(64)}`) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
}

function exactCanonicalArtifact(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) < 3 ||
    Buffer.byteLength(value) > MAX_REQUEST_BYTES
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  if (canonicalJson(parsed) !== value) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  rejectSecrets(parsed);
  return exactObject(
    parsed,
    Object.keys(parsed as Record<string, unknown>),
    "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID",
  );
}

function exactTimestamp(value: unknown): void {
  const timestamp = exactString(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    24,
  );
  if (new Date(timestamp).toISOString() !== timestamp) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
}

function validateDumpArtifact(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const dump = exactCanonicalArtifact(value);
  exactObject(
    dump,
    [
      "backupFormat",
      "completedAt",
      "dumpId",
      "exitCode",
      "pgDumpMajor",
      "plaintextBytes",
      "plaintextSha256",
      "snapshotTokenSha256",
      "sourceDataSnapshotSha256",
    ],
    "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID",
  );
  if (
    dump.backupFormat !== "pg_dump-custom" ||
    dump.pgDumpMajor !== 16 ||
    dump.exitCode !== 0 ||
    !Number.isSafeInteger(dump.plaintextBytes) ||
    Number(dump.plaintextBytes) < 1 ||
    Number(dump.plaintextBytes) > MAX_PAYLOAD_BYTES
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  exactIdValue(dump.dumpId);
  exactTimestamp(dump.completedAt);
  exactDigest(dump.plaintextSha256);
  exactDigest(dump.snapshotTokenSha256);
  exactDigest(dump.sourceDataSnapshotSha256);
  return dump;
}

function validateVersionedObjectArtifact(
  value: unknown,
): Readonly<Record<string, unknown>> {
  const object = exactCanonicalArtifact(value);
  exactObject(
    object,
    [
      "bucket",
      "headContentLength",
      "headEtag",
      "headObjectSha256Metadata",
      "headObservedAt",
      "key",
      "storageProvider",
      "versionId",
    ],
    "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID",
  );
  const bucket = exactString(object.bucket, BUCKET, 63);
  if (
    bucket.toLowerCase().includes("staging") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bucket)
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  const key = exactString(object.key, EXACT_BACKUP_KEY, 512);
  if (key.split("/").some((segment) => ["", ".", ".."].includes(segment))) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  exactString(object.versionId, VERSION_ID, 256);
  if (
    ["null", "none", "undefined"].includes(
      String(object.versionId).toLowerCase(),
    ) ||
    !Number.isSafeInteger(object.headContentLength) ||
    Number(object.headContentLength) < 1 ||
    Number(object.headContentLength) > MAX_PAYLOAD_BYTES
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  exactString(object.headEtag, ETAG, 80);
  exactDigest(object.headObjectSha256Metadata);
  exactTimestamp(object.headObservedAt);
  const provider = exactObject(
    object.storageProvider,
    [
      "endpointOriginSha256",
      "kind",
      "region",
      "encryptionBoundary",
      "transport",
      "versioning",
    ],
    "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID",
  );
  if (
    provider.kind !== "hetzner-object-storage" ||
    !["fsn1", "nbg1", "hel1"].includes(String(provider.region)) ||
    provider.encryptionBoundary !== "client-envelope-only" ||
    provider.transport !== "https" ||
    provider.versioning !== "enabled"
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  }
  exactDigest(provider.endpointOriginSha256);
  return object;
}

function exactIdValue(value: unknown): void {
  exactString(value, BOUNDED_ID, 128);
}

function validateOperationRequest(
  operation: ProductionExact0096ProducerOperation,
  request: Readonly<Record<string, unknown>>,
): void {
  exactObject(
    request,
    OPERATION_REQUEST_FIELDS[operation],
    "PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID",
  );
  const exactId = exactIdValue;
  const exactHexId = (value: unknown) => {
    const id = exactString(value, HEX_ID, 64);
    if (id === "0".repeat(64))
      fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
  };
  switch (operation) {
    case "observeExecutorIdentity":
    case "observeImmutableProductionSourceReadOnly":
      exactDigest(request.planSha256);
      break;
    case "proveProductionWritersStopped":
      if (request.boundary !== "before")
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      exactId(request.maintenanceWindowId);
      exactDigest(request.runtimeBindingSha256);
      if (exactString(request.sourceSha, SOURCE_SHA, 40) === "0".repeat(40)) {
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      }
      break;
    case "openExportedReadOnlySnapshot":
      if (request.transactionMode !== "repeatable-read-read-only")
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      break;
    case "readFrozenRelationManifestMeasurements":
      exactHexId(request.snapshotHandleId);
      break;
    case "createBoundedPgDumpCustom":
      exactHexId(request.snapshotHandleId);
      if (request.ceilingBytes !== MAX_PAYLOAD_BYTES)
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      break;
    case "encryptAndPersistVersionedPayload":
      {
        const dump = validateDumpArtifact(request.dumpCanonical);
        if (dump.dumpId !== request.dumpId) {
          fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
        }
      }
      exactId(request.dumpId);
      if (
        request.ceilingBytes !== MAX_PAYLOAD_BYTES ||
        request.enforcement !== "streaming-before-write" ||
        request.abortWriteOnOverflow !== true ||
        request.terminateProducerOnOverflow !== true ||
        request.deletePartialObjectOnOverflow !== true
      ) {
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      }
      break;
    case "headExactVersionedPayloadReadOnly":
      {
        const bucket = exactString(request.bucket, BUCKET, 63);
        if (
          bucket.toLowerCase().includes("staging") ||
          /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bucket)
        ) {
          fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
        }
      }
      {
        const key = exactString(request.key, EXACT_BACKUP_KEY, 512);
        if (
          key.split("/").some((segment) => ["", ".", ".."].includes(segment))
        ) {
          fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
        }
      }
      exactString(request.versionId, VERSION_ID, 256);
      if (
        ["null", "none", "undefined"].includes(
          String(request.versionId).toLowerCase(),
        )
      ) {
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      }
      break;
    case "restoreIntoNewDisposablePostgres16":
      {
        const object = validateVersionedObjectArtifact(
          request.backupObjectCanonical,
        );
        if (
          object.headObjectSha256Metadata !== request.encryptedPayloadSha256
        ) {
          fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
        }
      }
      exactDigest(request.encryptedPayloadSha256);
      exactDigest(request.sourceDumpSha256);
      break;
    case "observeRestoredJournalSchemaAndContentReadOnly":
      exactId(request.restoreId);
      break;
    case "reobserveProductionSourceReadOnly":
      if (request.boundary !== "after")
        fail("PRODUCTION_BACKUP_PRODUCER_REQUEST_INVALID");
      exactId(request.maintenanceWindowId);
      break;
  }
}

function canonicalProducerOutput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("PRODUCTION_BACKUP_PRODUCER_OUTPUT_INVALID");
  }
  rejectSecrets(value, "output");
  const canonical = canonicalJson(value);
  if (
    Buffer.byteLength(canonical) < 3 ||
    Buffer.byteLength(canonical) > MAX_REQUEST_BYTES
  ) {
    fail("PRODUCTION_BACKUP_PRODUCER_OUTPUT_INVALID");
  }
  return canonical;
}

async function dispatchProductionExact0096ProducerOperation(
  operation: ProductionExact0096ProducerOperation,
  requestPath: string,
  dependencies: {
    isReviewedContainerPath?: (value: string) => boolean;
    operationHandlers: ProductionExact0096ProducerOperationHandlers;
  },
): Promise<string> {
  const request = await readCanonicalProductionBackupProducerRequest(
    requestPath,
    dependencies,
  );
  validateOperationRequest(operation, request);
  const handlers = validateOperationHandlers(dependencies.operationHandlers);
  const output = await handlers[operation](request);
  return canonicalProducerOutput(output);
}

/**
 * Serve the fixed producer operations from one process. The process-owned
 * handler registry is deliberately constructed once, so an exported snapshot
 * transaction and its encrypted dump state can remain live across the ordered
 * measure/dump/persist calls. Requests still cross the reviewed, canonical,
 * regular-file boundary; stdin carries no credentials or artifact bodies.
 *
 * The protocol is one canonical JSON line per request:
 * `{\"operation\":\"...\",\"requestPath\":\"/...json\"}`. A response is the
 * operation's canonical artifact line. Any malformed request or handler error
 * is terminal, closes the session, and emits only a stable error code.
 */
export async function runProductionExact0096BackupProducerSession(
  input: Readable,
  io: { stdout(value: string): void; stderr(value: string): void } = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
  dependencies: {
    isReviewedContainerPath?: (value: string) => boolean;
    operationHandlers?: ProductionExact0096SessionOperationHandlers;
    close?: () => Promise<void>;
  } = {},
): Promise<number> {
  let code = 0;
  try {
    if (dependencies.operationHandlers === undefined) {
      fail("PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED");
    }
    const handlers = validateSessionOperationHandlers(
      dependencies.operationHandlers,
    );
    const lines = createInterface({ input, crlfDelay: Infinity });
    let requestCount = 0;
    for await (const raw of lines) {
      requestCount += 1;
      if (
        requestCount > PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS.length ||
        Buffer.byteLength(raw) < 2 ||
        Buffer.byteLength(raw) > 2048
      ) {
        fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
      }
      const command = exactObject(
        envelope,
        ["operation", "requestPath"],
        "PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID",
      );
      if (canonicalJson(command) !== `${raw}\n`) {
        fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
      }
      const operation = exactString(command.operation, OPERATION, 64);
      if (
        !PRODUCTION_EXACT_0096_SESSION_OPERATIONS.includes(
          operation as ProductionExact0096SessionOperation,
        )
      ) {
        fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
      }
      const requestPath = exactString(
        command.requestPath,
        /^(?!.*[\r\n\0]).{3,512}$/,
        512,
      );
      const pathAccepted = dependencies.isReviewedContainerPath
        ? dependencies.isReviewedContainerPath(requestPath)
        : isAbsolute(requestPath) &&
          SAFE_PATH.test(requestPath) &&
          !requestPath.split("/").some((part) => part === "..");
      if (!pathAccepted) {
        fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
      }
      const request = await readCanonicalProductionBackupProducerRequest(
        requestPath,
        dependencies,
      );
      validateOperationRequest(
        operation as ProductionExact0096SessionOperation,
        request,
      );
      io.stdout(
        canonicalProducerOutput(
          await handlers[operation as ProductionExact0096SessionOperation](
            request,
          ),
        ),
      );
    }
    if (requestCount === 0) {
      fail("PRODUCTION_BACKUP_PRODUCER_SESSION_INVALID");
    }
  } catch (error) {
    code = 1;
    const errorCode =
      error instanceof ProductionExact0096ProducerEntrypointError
        ? error.code
        : "PRODUCTION_BACKUP_PRODUCER_FAILED";
    io.stderr(`${errorCode}\n`);
  } finally {
    try {
      await dependencies.close?.();
    } catch {
      if (code === 0) {
        code = 1;
        io.stderr("PRODUCTION_BACKUP_PRODUCER_SESSION_CLOSE_FAILED\n");
      }
    }
  }
  return code;
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
    operationHandlers?: ProductionExact0096ProducerOperationHandlers;
  } = {},
): Promise<number> {
  try {
    if (
      argv.length !== 3 ||
      !OPERATION.test(argv[0] ?? "") ||
      !PRODUCTION_EXACT_0096_PRODUCER_OPERATIONS.includes(
        (argv[0] ?? "") as ProductionExact0096ProducerOperation,
      ) ||
      argv[1] !== "--request-file"
    ) {
      fail("PRODUCTION_BACKUP_PRODUCER_ARGUMENT_INVALID");
    }
    const operation = argv[0] as ProductionExact0096ProducerOperation;
    if (dependencies.operationHandlers === undefined) {
      // The shipped CLI remains default-dark until a reviewed lifecycle creates
      // and injects the complete fixed handler registry. A partial registry is
      // never accepted, so no operation can accidentally become independently
      // reachable while snapshot/restore state is absent.
      fail("PRODUCTION_BACKUP_PRODUCER_OPERATION_UNWIRED");
    }
    io.stdout(
      await dispatchProductionExact0096ProducerOperation(operation, argv[2], {
        ...dependencies,
        operationHandlers: dependencies.operationHandlers,
      }),
    );
    return 0;
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
  process.exitCode =
    process.argv[2] === "--session"
      ? await runProductionExact0096BackupProducerSession(process.stdin)
      : await runProductionExact0096BackupProducerCli(process.argv.slice(2));
}

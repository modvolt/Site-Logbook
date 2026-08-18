import {
  constants as fsConstants,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { requireEmbeddedProductionBuildSha } from "./lib/build-provenance";
import {
  applyProductionRuntimeDbCredentialCutover,
  parseProductionRuntimeDbCredentialRequest,
  productionRuntimeDbCredentialSha256,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
  type ProductionRuntimeCredentialClient,
} from "./lib/production-runtime-db-credential-cutover";
import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV,
  PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV,
  PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV,
  PRODUCTION_RUNTIME_DATABASE_USER,
} from "./lib/production-runtime-database";

const MAX_ARTIFACT_BYTES = 512 * 1024;
const ARGUMENTS = [
  "request-file",
  "migration-plan-file",
  "role-transaction-receipt-file",
  "role-postcommit-file",
  "receipt-out",
  "confirm",
] as const;

class ProductionRuntimeDbCredentialCliError extends Error {
  constructor(
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ProductionRuntimeDbCredentialCliError";
  }
}

function fail(code: string, cause?: unknown): never {
  throw new ProductionRuntimeDbCredentialCliError(code, { cause });
}

function parseArguments(argv: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      !key?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_ARGUMENT_INVALID");
    }
    const name = key.slice(2);
    if (
      !ARGUMENTS.includes(name as (typeof ARGUMENTS)[number]) ||
      name in values
    ) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_ARGUMENT_INVALID");
    }
    values[name] = value;
  }
  if (
    Object.keys(values).length !== ARGUMENTS.length ||
    !ARGUMENTS.every((key) => typeof values[key] === "string") ||
    values.confirm !== PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_ARGUMENT_INVALID");
  }
  return values;
}

export const parseProductionRuntimeDbCredentialCliArguments = parseArguments;

function sameStableInputIdentity(
  left: BigIntStats,
  right: BigIntStats,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.nlink === right.nlink
  );
}

export async function readStableProductionRuntimeDbCredentialInputFile(
  filename: string,
  maximumBytes = MAX_ARTIFACT_BYTES,
): Promise<string> {
  if (
    !path.isAbsolute(filename) ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes <= 0 ||
    maximumBytes > MAX_ARTIFACT_BYTES
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_PATH_INVALID");
  }
  const absolute = path.resolve(filename);
  const requested = await lstat(absolute, { bigint: true }).catch((error) =>
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_UNAVAILABLE", error),
  );
  if (requested.isSymbolicLink()) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_INVALID");
  }
  const resolved = await realpath(absolute).catch((error) =>
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_UNAVAILABLE", error),
  );
  if (path.normalize(resolved) !== path.normalize(absolute)) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_INVALID");
  }
  const before = await lstat(resolved, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_INVALID");
  }
  const noFollow =
    typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(resolved, fsConstants.O_RDONLY | noFollow);
  let bytes: Buffer;
  let openedBefore;
  let openedAfter;
  try {
    openedBefore = await handle.stat({ bigint: true });
    if (
      !openedBefore.isFile() ||
      openedBefore.nlink !== 1n ||
      !sameStableInputIdentity(openedBefore, before)
    ) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_DRIFT");
    }
    const bounded = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset <= maximumBytes) {
      const { bytesRead } = await handle.read(
        bounded,
        offset,
        maximumBytes + 1 - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_INVALID");
    }
    bytes = bounded.subarray(0, offset);
    openedAfter = await handle.stat({ bigint: true });
  } finally {
    await handle.close();
  }
  const after = await lstat(resolved, { bigint: true });
  if (
    !openedAfter.isFile() ||
    openedAfter.nlink !== 1n ||
    !after.isFile() ||
    after.isSymbolicLink() ||
    after.nlink !== 1n ||
    !sameStableInputIdentity(openedBefore, openedAfter) ||
    !sameStableInputIdentity(before, after) ||
    !sameStableInputIdentity(openedAfter, after) ||
    bytes.length !== Number(before.size)
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_DRIFT");
  }
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes) || value.includes("\0")) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_INPUT_INVALID");
  }
  return value;
}

const readStableRegularFile = readStableProductionRuntimeDbCredentialInputFile;

export function parseProductionRuntimeCredentialAdminDatabaseUrl(
  raw: string,
  expectedDatabaseName: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (error) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ADMIN_URL_INVALID", error);
  }
  let username: string;
  let databaseName: string;
  try {
    username = decodeURIComponent(parsed.username);
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch (error) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ADMIN_URL_INVALID", error);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.toLowerCase() !== "postgres" ||
    (parsed.port.length > 0 && parsed.port !== "5432") ||
    parsed.search.length !== 0 ||
    parsed.password.length === 0 ||
    !/^\/[^/]+$/.test(parsed.pathname) ||
    databaseName !== expectedDatabaseName ||
    username.length === 0 ||
    username === PRODUCTION_RUNTIME_DATABASE_USER ||
    username === PRODUCTION_MIGRATOR_DATABASE_USER ||
    parsed.hash.length !== 0
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ADMIN_URL_INVALID");
  }
  return parsed;
}

async function connect(
  connectionString: string,
  applicationName: string,
): Promise<ProductionRuntimeCredentialClient> {
  const { Client } = pg;
  const client = new Client({
    connectionString,
    application_name: applicationName,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 60_000,
    query_timeout: 60_000,
  });
  await client.connect();
  return Object.freeze({
    query: (statement: string, values?: readonly unknown[]) =>
      client.query(statement, values as unknown[] | undefined),
    release: async (_destroy?: boolean) => {
      await client.end().catch(() => undefined);
    },
  });
}

async function syncDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(parent, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function reserveProductionRuntimeDbCredentialReceipt(
  filename: string,
) {
  if (!path.isAbsolute(filename)) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_PATH_INVALID");
  }
  const requestedParent = path.dirname(path.resolve(filename));
  const parent = await realpath(requestedParent).catch((error) =>
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_INVALID", error),
  );
  if (path.normalize(parent) !== path.normalize(requestedParent)) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_INVALID");
  }
  const destination = path.join(parent, path.basename(filename));
  let handle: FileHandle;
  try {
    handle = await open(destination, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_EXISTS", error);
    }
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_INVALID", error);
  }
  const identity = await handle.stat({ bigint: true });
  if (
    !identity.isFile() ||
    identity.nlink !== 1n ||
    identity.size !== 0n ||
    (process.platform !== "win32" && (identity.mode & 0o777n) !== 0o600n)
  ) {
    await handle.close().catch(() => undefined);
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_INVALID");
  }
  try {
    await handle.sync();
    await syncDirectory(parent);
  } catch (error) {
    await handle.close().catch(() => undefined);
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_INVALID", error);
  }
  let settled = false;
  const closeIncomplete = async () => {
    if (settled) return;
    settled = true;
    await handle.close().catch(() => undefined);
    // Deliberately retain the exact reserved inode. It is a fail-closed marker
    // for an incomplete attempt and can never delete a concurrent peer file.
  };
  const finalize = async (canonical: string) => {
    if (settled) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_STATE_INVALID");
    }
    settled = true;
    const expectedBytes = Buffer.from(canonical, "utf8");
    const expectedSha256 = productionRuntimeDbCredentialSha256(expectedBytes);
    try {
      await handle.writeFile(expectedBytes);
      await handle.sync();
      const held = await handle.stat({ bigint: true });
      if (
        held.dev !== identity.dev ||
        held.ino !== identity.ino ||
        held.nlink !== 1n ||
        held.size !== BigInt(expectedBytes.length)
      ) {
        fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_IDENTITY_DRIFT");
      }
      await handle.close();
      const published = await lstat(destination, { bigint: true });
      if (
        published.dev !== identity.dev ||
        published.ino !== identity.ino ||
        published.nlink !== 1n ||
        published.size !== BigInt(expectedBytes.length)
      ) {
        fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_IDENTITY_DRIFT");
      }
      const readbackHandle = await open(destination, "r");
      let readback: Buffer;
      try {
        const before = await readbackHandle.stat({ bigint: true });
        readback = await readbackHandle.readFile();
        const after = await readbackHandle.stat({ bigint: true });
        if (
          before.dev !== identity.dev ||
          before.ino !== identity.ino ||
          before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs
        ) {
          fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_IDENTITY_DRIFT");
        }
      } finally {
        await readbackHandle.close();
      }
      if (
        !readback.equals(expectedBytes) ||
        productionRuntimeDbCredentialSha256(readback) !== expectedSha256
      ) {
        fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_READBACK_INVALID");
      }
      const finalPublished = await lstat(destination, { bigint: true });
      if (
        finalPublished.dev !== identity.dev ||
        finalPublished.ino !== identity.ino ||
        finalPublished.nlink !== 1n ||
        finalPublished.size !== BigInt(expectedBytes.length)
      ) {
        fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_IDENTITY_DRIFT");
      }
      await syncDirectory(parent);
      return Object.freeze({
        path: destination,
        sha256: expectedSha256,
        dev: identity.dev,
        ino: identity.ino,
      });
    } catch (error) {
      await handle.close().catch(() => undefined);
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_PERSIST_FAILED", error);
    }
  };
  return Object.freeze({
    path: destination,
    dev: identity.dev,
    ino: identity.ino,
    finalize,
    closeIncomplete,
  });
}

export async function persistProductionRuntimeDbCredentialReceipt(
  filename: string,
  canonical: string,
) {
  const reservation =
    await reserveProductionRuntimeDbCredentialReceipt(filename);
  const published = await reservation.finalize(canonical);
  return published.path;
}

export async function runProductionRuntimeDbCredentialCutoverCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal = new AbortController().signal,
) {
  const options = parseArguments(argv);
  const requestCanonical = await readStableRegularFile(
    options["request-file"],
    64 * 1024,
  );
  const request = parseProductionRuntimeDbCredentialRequest(requestCanonical);
  const embeddedSourceSha = requireEmbeddedProductionBuildSha();
  const adminDatabaseUrl =
    env[PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV];
  const runtimePassword = env[PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV];
  const executorImage = env[PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV];
  if (
    typeof adminDatabaseUrl !== "string" ||
    adminDatabaseUrl.length === 0 ||
    typeof runtimePassword !== "string" ||
    runtimePassword.length === 0 ||
    typeof executorImage !== "string" ||
    executorImage.length === 0
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_SECRET_ENV_MISSING");
  }
  const parsedAdminUrl = parseProductionRuntimeCredentialAdminDatabaseUrl(
    adminDatabaseUrl,
    request.databaseName,
  );
  const runtimeUrl = new URL(parsedAdminUrl.href);
  runtimeUrl.username = PRODUCTION_RUNTIME_DATABASE_USER;
  runtimeUrl.password = runtimePassword;

  const migrationPlanCanonical = await readStableRegularFile(
    options["migration-plan-file"],
  );
  const roleTransactionReceiptCanonical = await readStableRegularFile(
    options["role-transaction-receipt-file"],
  );
  const rolePostCommitArtifactCanonical = await readStableRegularFile(
    options["role-postcommit-file"],
  );
  // Reserve and durably fsync the no-clobber output inode before the first DB
  // connection. A crash or failed attempt leaves a non-PASS marker that must
  // be investigated; this process never unlinks a destination name.
  const reservation = await reserveProductionRuntimeDbCredentialReceipt(
    options["receipt-out"],
  );
  let result;
  try {
    result = await applyProductionRuntimeDbCredentialCutover({
      requestCanonical,
      migrationPlanCanonical,
      roleTransactionReceiptCanonical,
      rolePostCommitArtifactCanonical,
      embeddedSourceSha,
      executorImage,
      runtimePassword,
      connectAdmin: () =>
        connect(
          parsedAdminUrl.href,
          "site-logbook-production-runtime-credential-admin",
        ),
      connectRuntime: () =>
        connect(
          runtimeUrl.href,
          "site-logbook-production-runtime-credential-proof",
        ),
      signal,
    });
  } catch (error) {
    await reservation.closeIncomplete();
    throw error;
  }
  let published;
  try {
    published = await reservation.finalize(result.receiptCanonical);
    if (published.sha256 !== result.receiptSha256) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_READBACK_INVALID");
    }
  } catch (error) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_COMMITTED_WITHOUT_DURABLE_RECEIPT",
      error,
    );
  }
  return Object.freeze({
    decision: "PASS" as const,
    receiptPath: published.path,
    receiptSha256: result.receiptSha256,
    authorizesApplicationStart: false as const,
    authorizesDeployment: false as const,
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("operator interrupted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const argv = process.argv.slice(2);
    if (argv[0] === "--") argv.shift();
    const result = await runProductionRuntimeDbCredentialCutoverCli(
      argv,
      process.env,
      controller.signal,
    );
    process.stdout.write(
      `${JSON.stringify({
        decision: result.decision,
        receiptSha256: result.receiptSha256,
        authorizesApplicationStart: false,
        authorizesDeployment: false,
      })}\n`,
    );
  } catch (error) {
    const code =
      typeof (error as { code?: unknown })?.code === "string"
        ? (error as { code: string }).code
        : "PRODUCTION_RUNTIME_DB_CREDENTIAL_CUTOVER_FAILED";
    process.stderr.write(`${code}: credential cutover failed closed.\n`);
    process.exitCode = 1;
  } finally {
    delete process.env[PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV];
    delete process.env[PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV];
    delete process.env[PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV];
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}

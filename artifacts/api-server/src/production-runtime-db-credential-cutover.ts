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
  applyProductionRuntimeDbCredentialRotation,
  parseProductionRuntimeDbCredentialRequest,
  productionRuntimeDbCredentialSha256,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_CONFIRMATION,
  PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA,
  prepareProductionRuntimeDbCredentialRotationRequest,
  type ProductionRuntimeCredentialClient,
} from "./lib/production-runtime-db-credential-cutover";
import {
  PRODUCTION_MIGRATOR_DATABASE_USER,
  PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV,
  PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV,
  PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV,
  PRODUCTION_RUNTIME_DATABASE_USER,
  requireProductionRuntimeDatabasePassword,
} from "./lib/production-runtime-database";

const MAX_ARTIFACT_BYTES = 512 * 1024;
const CUTOVER_ARGUMENTS = [
  "request-file",
  "migration-plan-file",
  "role-transaction-receipt-file",
  "role-postcommit-file",
  "receipt-out",
  "confirm",
] as const;
const ROTATION_ARGUMENTS = [
  ...CUTOVER_ARGUMENTS,
  "rotation-secret-out",
] as const;
const ROTATION_PREPARE_ARGUMENTS = [
  "migration-plan-file",
  "role-transaction-receipt-file",
  "role-postcommit-file",
  "request-out",
  "live-source-sha",
  "database-name",
  "approval-id",
  "confirm",
] as const;
const ARGUMENTS = Array.from(
  new Set([
    ...CUTOVER_ARGUMENTS,
    ...ROTATION_ARGUMENTS,
    ...ROTATION_PREPARE_ARGUMENTS,
  ]),
);

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
  const expectedArguments =
    values.confirm === PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION
      ? CUTOVER_ARGUMENTS
      : values.confirm ===
          PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION
        ? ROTATION_ARGUMENTS
        : values.confirm ===
            PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_CONFIRMATION
          ? ROTATION_PREPARE_ARGUMENTS
          : undefined;
  if (
    !expectedArguments ||
    Object.keys(values).length !== expectedArguments.length ||
    !expectedArguments.every((key) => typeof values[key] === "string")
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

export async function reserveProductionRuntimeDbCredentialRotationSecret(
  filename: string,
  forbiddenArtifactPaths: readonly string[],
) {
  if (
    !path.isAbsolute(filename) ||
    !Array.isArray(forbiddenArtifactPaths) ||
    forbiddenArtifactPaths.length < 2 ||
    forbiddenArtifactPaths.some((entry) => !path.isAbsolute(entry))
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_INVALID");
  }
  const requestedPrivateParent = path.dirname(path.resolve(filename));
  const privateParent = await realpath(requestedPrivateParent).catch((error) =>
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_INVALID",
      error,
    ),
  );
  const privateParentIdentity = await lstat(privateParent, {
    bigint: true,
  }).catch((error) =>
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_INVALID",
      error,
    ),
  );
  if (
    path.normalize(privateParent) !== path.normalize(requestedPrivateParent) ||
    !privateParentIdentity.isDirectory() ||
    privateParentIdentity.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (privateParentIdentity.mode & 0o777n) !== 0o700n)
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_INVALID");
  }
  const artifactParents = await Promise.all(
    forbiddenArtifactPaths.map((entry) =>
      realpath(path.dirname(path.resolve(entry))).catch((error) =>
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_INVALID",
          error,
        ),
      ),
    ),
  );
  if (
    artifactParents.some(
      (parent) => path.normalize(parent) === path.normalize(privateParent),
    ) ||
    forbiddenArtifactPaths.some(
      (entry) =>
        path.normalize(path.resolve(entry)) ===
        path.normalize(path.resolve(filename)),
    )
  ) {
    fail(
      "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PATH_ALIASES_EVIDENCE",
    );
  }
  const reservation =
    await reserveProductionRuntimeDbCredentialReceipt(filename);
  let persisted = false;
  return Object.freeze({
    path: reservation.path,
    async persist(secret: string): Promise<void> {
      if (persisted) {
        fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_STATE_INVALID");
      }
      persisted = true;
      try {
        requireProductionRuntimeDatabasePassword(secret);
        await reservation.finalize(secret);
      } catch (error) {
        fail(
          "PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_SECRET_PERSIST_FAILED",
          error,
        );
      }
    },
    async closeIncomplete(): Promise<void> {
      if (persisted) return;
      persisted = true;
      await reservation.closeIncomplete();
    },
  });
}

export async function runProductionRuntimeDbCredentialCutoverCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  signal: AbortSignal = new AbortController().signal,
) {
  const options = parseArguments(argv);
  if (
    options.confirm ===
    PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_PREPARE_CONFIRMATION
  ) {
    const embeddedSourceSha = requireEmbeddedProductionBuildSha();
    const adminDatabaseUrl =
      env[PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV];
    const executorImage = env[PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV];
    const runtimePassword = env[PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV];
    if (
      typeof adminDatabaseUrl !== "string" ||
      adminDatabaseUrl.length === 0 ||
      typeof executorImage !== "string" ||
      executorImage.length === 0 ||
      (runtimePassword !== undefined && runtimePassword.length > 0)
    ) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_SECRET_ENV_MISSING");
    }
    const parsedAdminUrl = parseProductionRuntimeCredentialAdminDatabaseUrl(
      adminDatabaseUrl,
      options["database-name"],
    );
    const migrationPlanCanonical = await readStableRegularFile(
      options["migration-plan-file"],
    );
    const roleTransactionReceiptCanonical = await readStableRegularFile(
      options["role-transaction-receipt-file"],
    );
    const rolePostCommitArtifactCanonical = await readStableRegularFile(
      options["role-postcommit-file"],
    );
    const reservation = await reserveProductionRuntimeDbCredentialReceipt(
      options["request-out"],
    );
    let prepared;
    try {
      prepared = await prepareProductionRuntimeDbCredentialRotationRequest({
        migrationPlanCanonical,
        roleTransactionReceiptCanonical,
        rolePostCommitArtifactCanonical,
        embeddedSourceSha,
        executorImage,
        liveSourceSha: options["live-source-sha"],
        databaseName: options["database-name"],
        approvalId: options["approval-id"],
        connectAdmin: () =>
          connect(
            parsedAdminUrl.href,
            "site-logbook-production-runtime-credential-rotation-prepare",
          ),
        signal,
      });
    } catch (error) {
      await reservation.closeIncomplete();
      throw error;
    }
    const published = await reservation.finalize(prepared.requestCanonical);
    if (published.sha256 !== prepared.requestSha256) {
      fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_OUTPUT_READBACK_INVALID");
    }
    return Object.freeze({
      decision: "PREPARED" as const,
      requestPath: published.path,
      requestSha256: prepared.requestSha256,
      authorizesCredentialMutation: false as const,
      authorizesApplicationStart: false as const,
      authorizesDeployment: false as const,
    });
  }
  const requestCanonical = await readStableRegularFile(
    options["request-file"],
    64 * 1024,
  );
  const request = parseProductionRuntimeDbCredentialRequest(requestCanonical);
  const rotation =
    request.schemaVersion ===
    PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_REQUEST_SCHEMA;
  if (
    (rotation &&
      options.confirm !==
        PRODUCTION_RUNTIME_DB_CREDENTIAL_ROTATION_CONFIRMATION) ||
    (!rotation &&
      (request.schemaVersion !==
        PRODUCTION_RUNTIME_DB_CREDENTIAL_REQUEST_SCHEMA ||
        options.confirm !== PRODUCTION_RUNTIME_DB_CREDENTIAL_CONFIRMATION))
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_CEREMONY_MISMATCH");
  }
  const embeddedSourceSha = requireEmbeddedProductionBuildSha();
  const adminDatabaseUrl =
    env[PRODUCTION_RUNTIME_CREDENTIAL_ADMIN_DATABASE_URL_ENV];
  const runtimePassword = env[PRODUCTION_RUNTIME_DATABASE_PASSWORD_ENV];
  const executorImage = env[PRODUCTION_RUNTIME_CREDENTIAL_EXECUTOR_IMAGE_ENV];
  if (
    typeof adminDatabaseUrl !== "string" ||
    adminDatabaseUrl.length === 0 ||
    (rotation
      ? runtimePassword !== undefined && runtimePassword.length > 0
      : typeof runtimePassword !== "string" || runtimePassword.length === 0) ||
    typeof executorImage !== "string" ||
    executorImage.length === 0
  ) {
    fail("PRODUCTION_RUNTIME_DB_CREDENTIAL_CLI_SECRET_ENV_MISSING");
  }
  const parsedAdminUrl = parseProductionRuntimeCredentialAdminDatabaseUrl(
    adminDatabaseUrl,
    request.databaseName,
  );

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
  let secretReservation:
    | Awaited<
        ReturnType<typeof reserveProductionRuntimeDbCredentialRotationSecret>
      >
    | undefined;
  try {
    secretReservation = rotation
      ? await reserveProductionRuntimeDbCredentialRotationSecret(
          options["rotation-secret-out"],
          [
            options["request-file"],
            options["migration-plan-file"],
            options["role-transaction-receipt-file"],
            options["role-postcommit-file"],
            options["receipt-out"],
          ],
        )
      : undefined;
  } catch (error) {
    await reservation.closeIncomplete();
    throw error;
  }
  const connectRuntime = (input: {
    databaseName: string;
    databaseUser: typeof PRODUCTION_RUNTIME_DATABASE_USER;
    password: string;
  }) => {
    const runtimeUrl = new URL(parsedAdminUrl.href);
    runtimeUrl.username = input.databaseUser;
    runtimeUrl.password = input.password;
    return connect(
      runtimeUrl.href,
      "site-logbook-production-runtime-credential-proof",
    );
  };
  let result;
  try {
    const common = {
      requestCanonical,
      migrationPlanCanonical,
      roleTransactionReceiptCanonical,
      rolePostCommitArtifactCanonical,
      embeddedSourceSha,
      executorImage,
      connectAdmin: () =>
        connect(
          parsedAdminUrl.href,
          "site-logbook-production-runtime-credential-admin",
        ),
      connectRuntime,
      signal,
    };
    result = rotation
      ? await applyProductionRuntimeDbCredentialRotation({
          ...common,
          persistGeneratedSecret: (secret) =>
            secretReservation!.persist(secret),
        })
      : await applyProductionRuntimeDbCredentialCutover({
          ...common,
          runtimePassword: runtimePassword!,
        });
  } catch (error) {
    await reservation.closeIncomplete();
    await secretReservation?.closeIncomplete();
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
      `${JSON.stringify(
        result.decision === "PREPARED"
          ? {
              decision: result.decision,
              requestSha256: result.requestSha256,
              authorizesCredentialMutation: false,
              authorizesApplicationStart: false,
              authorizesDeployment: false,
            }
          : {
              decision: result.decision,
              receiptSha256: result.receiptSha256,
              authorizesApplicationStart: false,
              authorizesDeployment: false,
            },
      )}\n`,
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

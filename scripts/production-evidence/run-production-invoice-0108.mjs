#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID,
  PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256,
  createProductionMigrationRole0108Authority,
} from "../../lib/db/src/production-migration-role-0108-authority.ts";
import { createProductionInvoice0108BackupAuthority } from "./production-exact-0107-backup-authority.mjs";
import {
  PRODUCTION_INVOICE_0108_CONFIRMATION,
  PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION,
} from "./production-invoice-0108-contract.mjs";
import {
  createPgProductionInvoice0108Database,
  loadProductionInvoice0108Catalog,
} from "./production-invoice-0108-pg-adapter.mjs";
import { createProductionInvoice0108Executable } from "./production-invoice-0108-runner.mjs";
import { createNodeExclusiveArtifactStore } from "./production-migration-adapter.mjs";
import { canonicalProductionMigrationJson } from "./production-migration-contract.mjs";

export const PRODUCTION_INVOICE_0108_RUNNER_DESCRIPTOR_SCHEMA =
  "site-logbook.production-invoice-0108-runner-descriptor/v1";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,127}$/;
const STORAGE_ID = /^[a-z0-9][a-z0-9._/-]{0,255}$/;
const COMMANDS = new Set(["prepare", "apply", "apply-role-delta", "inspect"]);
const MAX_INPUT_BYTES = 512 * 1024;

export class ProductionInvoice0108CliError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionInvoice0108CliError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductionInvoice0108CliError(code, message, options);
}

function exactObject(value, keys, field) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_SCHEMA_INVALID",
      `${field} has an unexpected key set.`,
    );
  }
  return value;
}

function exactString(value, field, pattern) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    value !== value.trim() ||
    (pattern && !pattern.test(value))
  ) {
    fail("PRODUCTION_INVOICE_0108_CLI_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function relativePath(value, field) {
  const exact = exactString(value, field);
  if (path.isAbsolute(exact) || exact.includes("\0")) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_PATH_INVALID",
      `${field} must be descriptor-relative.`,
    );
  }
  const normalized = path.normalize(exact);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.parse(normalized).root
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_PATH_INVALID",
      `${field} escapes the descriptor directory.`,
    );
  }
  return normalized;
}

function resolveBelow(base, relative, field) {
  const target = path.resolve(base, relativePath(relative, field));
  const relation = path.relative(base, target);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_PATH_INVALID",
      `${field} escapes the descriptor directory.`,
    );
  }
  return target;
}

async function readStableRegularFile(file, maximumBytes, field) {
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_INPUT_UNSAFE",
      `${field} must be one bounded regular single-link file.`,
    );
  }
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const handle = await open(file, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await lstat(file, { bigint: true });
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      bytes.length !== Number(opened.size)
    ) {
      fail(
        "PRODUCTION_INVOICE_0108_CLI_INPUT_CHANGED",
        `${field} changed during its bounded read.`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseJson(bytes, field) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_SCHEMA_INVALID",
      `${field} is not strict UTF-8 JSON.`,
      { cause: error },
    );
  }
  if (canonicalProductionMigrationJson(value) !== text) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_SCHEMA_INVALID",
      `${field} must be canonical sorted-key JSON with one trailing LF.`,
    );
  }
  return value;
}

function parseDescriptor(value) {
  const descriptor = exactObject(
    value,
    [
      "schemaVersion",
      "kind",
      "executionDefault",
      "sourceSha",
      "migrationsDirectory",
      "artifactDirectory",
      "backupReceiptDirectory",
      "backupRestoreReferenceFile",
      "connection",
      "authorities",
      "authorizesApplicationStart",
    ],
    "descriptor",
  );
  const connection = exactObject(
    descriptor.connection,
    [
      "environmentVariable",
      "databaseName",
      "sessionUser",
      "migratorRole",
      "runtimeRole",
    ],
    "descriptor.connection",
  );
  const authorities = exactObject(
    descriptor.authorities,
    ["role0108"],
    "descriptor.authorities",
  );
  const role0108 = exactObject(
    authorities.role0108,
    ["id", "sourceSha256"],
    "descriptor.authorities.role0108",
  );
  if (
    descriptor.schemaVersion !==
      PRODUCTION_INVOICE_0108_RUNNER_DESCRIPTOR_SCHEMA ||
    descriptor.kind !== "site-logbook-production-invoice-0108-runner" ||
    descriptor.executionDefault !== "disabled" ||
    descriptor.authorizesApplicationStart !== false ||
    role0108.id !== PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_ID ||
    role0108.sourceSha256 !==
      PRODUCTION_MIGRATION_ROLE_0108_AUTHORITY_SOURCE_SHA256
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_DESCRIPTOR_INVALID",
      "Descriptor is not exact, default-dark or source-pinned.",
    );
  }
  exactString(descriptor.sourceSha, "descriptor.sourceSha", SOURCE_SHA);
  for (const field of [
    "migrationsDirectory",
    "artifactDirectory",
    "backupReceiptDirectory",
    "backupRestoreReferenceFile",
  ]) {
    relativePath(descriptor[field], `descriptor.${field}`);
  }
  exactString(
    connection.environmentVariable,
    "descriptor.connection.environmentVariable",
    ENVIRONMENT_NAME,
  );
  for (const field of [
    "databaseName",
    "sessionUser",
    "migratorRole",
    "runtimeRole",
  ]) {
    exactString(
      connection[field],
      `descriptor.connection.${field}`,
      IDENTIFIER,
    );
  }
  if (connection.migratorRole === connection.runtimeRole) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_DESCRIPTOR_INVALID",
      "Migrator and runtime roles must differ.",
    );
  }
  return Object.freeze({
    ...descriptor,
    connection: Object.freeze({ ...connection }),
    authorities: Object.freeze({ role0108: Object.freeze({ ...role0108 }) }),
  });
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!COMMANDS.has(command) || rest.length % 2 !== 0) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_ARGUMENT_INVALID",
      "Command or exact --name value pairs are invalid.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !/^--[a-z][a-z-]*$/.test(String(flag)) ||
      !value ||
      String(value).startsWith("--") ||
      Object.hasOwn(options, flag.slice(2))
    ) {
      fail(
        "PRODUCTION_INVOICE_0108_CLI_ARGUMENT_INVALID",
        "CLI accepts only unique exact --name value pairs.",
      );
    }
    options[flag.slice(2)] = value;
  }
  const required = {
    prepare: [
      "descriptor",
      "intent-id",
      "operator",
      "approved-at",
      "confirmation",
    ],
    apply: [
      "descriptor",
      "plan-storage-id",
      "intent-storage-id",
      "confirmation",
    ],
    "apply-role-delta": [
      "descriptor",
      "plan-storage-id",
      "intent-storage-id",
      "migration-receipt-storage-id",
      "confirmation",
    ],
    inspect: [
      "descriptor",
      "plan-storage-id",
      "intent-storage-id",
      "migration-receipt-storage-id",
      "role-receipt-storage-id",
    ],
  }[command];
  if (
    Object.keys(options).length !== required.length ||
    required.some((field) => !Object.hasOwn(options, field))
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_ARGUMENT_INVALID",
      "CLI arguments differ from the reviewed command surface.",
    );
  }
  exactString(options.descriptor, "--descriptor");
  if (command === "prepare") {
    exactString(options["intent-id"], "--intent-id", HEX64);
    exactString(options.operator, "--operator");
    if (
      options.confirmation !== PRODUCTION_INVOICE_0108_CONFIRMATION ||
      new Date(options["approved-at"]).toISOString() !== options["approved-at"]
    ) {
      fail(
        "PRODUCTION_INVOICE_0108_CLI_CONFIRMATION_REQUIRED",
        "Prepare requires its exact attended confirmation and UTC timestamp.",
      );
    }
  } else if (command === "apply") {
    if (options.confirmation !== PRODUCTION_INVOICE_0108_CONFIRMATION) {
      fail(
        "PRODUCTION_INVOICE_0108_CLI_CONFIRMATION_REQUIRED",
        "Apply requires its exact attended confirmation.",
      );
    }
  } else if (command === "apply-role-delta") {
    if (options.confirmation !== PRODUCTION_INVOICE_0108_ROLE_CONFIRMATION) {
      fail(
        "PRODUCTION_INVOICE_0108_CLI_CONFIRMATION_REQUIRED",
        "Role delta requires its exact attended confirmation.",
      );
    }
  }
  for (const [key, value] of Object.entries(options)) {
    if (key.endsWith("storage-id") && value !== "none") {
      exactString(value, `--${key}`, STORAGE_ID);
    }
  }
  return Object.freeze({ command, options: Object.freeze(options) });
}

async function assertDirectory(file, field) {
  const metadata = await lstat(file, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_PATH_INVALID",
      `${field} must be one real directory.`,
    );
  }
  return realpath(file);
}

function optionalStorageId(value) {
  return value === "none" ? undefined : value;
}

export async function executeProductionInvoice0108Cli(
  argv,
  { environment = process.env, createPool } = {},
) {
  const { command, options } = parseCli(argv);
  const descriptorFile = path.resolve(options.descriptor);
  const descriptorDirectory = await realpath(path.dirname(descriptorFile));
  const descriptor = parseDescriptor(
    parseJson(
      await readStableRegularFile(
        descriptorFile,
        MAX_INPUT_BYTES,
        "descriptor",
      ),
      "descriptor",
    ),
  );
  if (
    environment.BUILD_SHA !== descriptor.sourceSha ||
    !SOURCE_SHA.test(String(environment.BUILD_SHA ?? ""))
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_SOURCE_MISMATCH",
      "BUILD_SHA does not equal the source-pinned runner descriptor.",
    );
  }
  const migrationsDirectory = await assertDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.migrationsDirectory,
      "descriptor.migrationsDirectory",
    ),
    "descriptor.migrationsDirectory",
  );
  const artifactDirectory = await assertDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.artifactDirectory,
      "descriptor.artifactDirectory",
    ),
    "descriptor.artifactDirectory",
  );
  const backupReceiptDirectory = await assertDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.backupReceiptDirectory,
      "descriptor.backupReceiptDirectory",
    ),
    "descriptor.backupReceiptDirectory",
  );
  const referenceFile = resolveBelow(
    descriptorDirectory,
    descriptor.backupRestoreReferenceFile,
    "descriptor.backupRestoreReferenceFile",
  );
  const connectionString =
    environment[descriptor.connection.environmentVariable];
  if (
    typeof connectionString !== "string" ||
    connectionString.length === 0 ||
    connectionString.includes("\r") ||
    connectionString.includes("\n")
  ) {
    fail(
      "PRODUCTION_INVOICE_0108_CLI_CONNECTION_UNAVAILABLE",
      "The descriptor-selected PostgreSQL connection material is unavailable.",
    );
  }

  let pool;
  try {
    if (typeof createPool === "function") {
      pool = createPool(connectionString);
    } else {
      const requireFromDb = createRequire(
        new URL("../../lib/db/package.json", import.meta.url),
      );
      const { Pool } = requireFromDb("pg");
      pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 15_000,
      });
    }
    const connect = () => pool.connect();
    const catalog = await loadProductionInvoice0108Catalog({
      migrationsDirectory,
    });
    const artifacts = createNodeExclusiveArtifactStore({
      directory: artifactDirectory,
    });
    const database = createPgProductionInvoice0108Database({
      connect,
      catalog,
      sourceSha: descriptor.sourceSha,
      databaseName: descriptor.connection.databaseName,
      sessionUser: descriptor.connection.sessionUser,
      migratorRole: descriptor.connection.migratorRole,
    });
    const backupAuthority = createProductionInvoice0108BackupAuthority({
      expectedRuntimeRole: descriptor.connection.runtimeRole,
      loadReceiptCanonical: async (storageId) => {
        if (!STORAGE_ID.test(String(storageId)) || storageId.includes("..")) {
          fail(
            "PRODUCTION_INVOICE_0108_CLI_BACKUP_RECEIPT_INVALID",
            "Backup receipt storage id is unsafe.",
          );
        }
        const receiptFile = resolveBelow(
          backupReceiptDirectory,
          storageId,
          "backupReceiptStorageId",
        );
        return (
          await readStableRegularFile(
            receiptFile,
            MAX_INPUT_BYTES,
            "backupReceipt",
          )
        ).toString("utf8");
      },
    });
    const roleAuthority = createProductionMigrationRole0108Authority({
      connect,
      databaseName: descriptor.connection.databaseName,
      sessionUser: descriptor.connection.sessionUser,
      migratorRole: descriptor.connection.migratorRole,
      runtimeRole: descriptor.connection.runtimeRole,
    });
    const executable = createProductionInvoice0108Executable({
      sourceSha: descriptor.sourceSha,
      readMigrationSql: async () => catalog.sql,
      database,
      artifacts,
      backupAuthority,
      roleAuthority,
    });
    if (command === "prepare") {
      const backupRestoreReferenceCanonical = (
        await readStableRegularFile(
          referenceFile,
          MAX_INPUT_BYTES,
          "backupRestoreReference",
        )
      ).toString("utf8");
      return executable.prepare({
        intentId: options["intent-id"],
        operator: options.operator,
        approvedAt: options["approved-at"],
        confirmation: options.confirmation,
        backupRestoreReferenceCanonical,
      });
    }
    if (command === "apply") {
      return executable.apply({
        planStorageId: options["plan-storage-id"],
        intentStorageId: options["intent-storage-id"],
        confirmation: options.confirmation,
      });
    }
    if (command === "apply-role-delta") {
      return executable.applyRoleDelta({
        planStorageId: options["plan-storage-id"],
        intentStorageId: options["intent-storage-id"],
        migrationReceiptStorageId: options["migration-receipt-storage-id"],
        confirmation: options.confirmation,
      });
    }
    return executable.inspect({
      planStorageId: options["plan-storage-id"],
      intentStorageId: options["intent-storage-id"],
      migrationReceiptStorageId: optionalStorageId(
        options["migration-receipt-storage-id"],
      ),
      roleReceiptStorageId: optionalStorageId(
        options["role-receipt-storage-id"],
      ),
    });
  } finally {
    await pool?.end?.();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const result = await executeProductionInvoice0108Cli(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      error instanceof ProductionInvoice0108CliError
        ? error.code
        : "PRODUCTION_INVOICE_0108_CLI_FAILED";
    process.stderr.write(`${code}: execution stopped.\n`);
    process.exitCode = 1;
  });
}

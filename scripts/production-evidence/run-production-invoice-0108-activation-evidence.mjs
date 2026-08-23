#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
  PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
  PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA,
  parseProductionActivation0108Approval,
  parseProductionActivation0108Readiness,
} from "../../artifacts/api-server/src/lib/production-activation-0108-contract.ts";
import { canonicalProductionActivationJson } from "../../artifacts/api-server/src/lib/production-activation-hold.ts";
import { verifyLiveProductionInvoice0108Readiness } from "../../artifacts/api-server/src/lib/production-invoice-0108-readiness.ts";
import {
  PRODUCTION_INVOICE_0108_POST_STATE,
  parseProductionInvoice0108Intent,
  parseProductionInvoice0108Plan,
  parseProductionInvoice0108Receipt,
  parseProductionInvoice0108RoleReceipt,
} from "./production-invoice-0108-contract.mjs";
import { PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 } from "./production-migration-contract.mjs";

export const PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA =
  "site-logbook.production-invoice-0108-activation-evidence-descriptor/v1";
export const PRODUCTION_INVOICE_0108_READINESS_CONFIRMATION =
  "VERIFY_EXACT_PRODUCTION_INVOICE_0108_READINESS_NO_START";
export const PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION =
  "ASSEMBLE_EXACT_PRODUCTION_INVOICE_0108_EVIDENCE_NO_PUBLICATION";

const SOURCE_SHA = /^[0-9a-f]{40}$/;
const SHA256_PIN = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{2,127}$/;
const MAX_INPUT_BYTES = 1024 * 1024;
const OUTPUTS = Object.freeze({
  readiness: "invoice-0108-schema-readiness.json",
  approval: "invoice-0108-activation-approval.json",
  evidence: "activation-evidence-v3.json",
});

export class ProductionInvoice0108ActivationEvidenceError extends Error {
  constructor(code, message, options) {
    super(`${code}: ${message}`, options);
    this.name = "ProductionInvoice0108ActivationEvidenceError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ProductionInvoice0108ActivationEvidenceError(
    `PRODUCTION_INVOICE_0108_ACTIVATION_${code}`,
    message,
    options,
  );
}

function exactObject(value, keys, field) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail("SCHEMA_INVALID", `${field} has an unexpected key set.`);
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
    fail("SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function canonicalTimestamp(value, field) {
  const exact = exactString(value, field);
  const millis = Date.parse(exact);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== exact) {
    fail("TIME_INVALID", `${field} must be canonical UTC.`);
  }
  return millis;
}

function relativePath(value, field) {
  const exact = exactString(value, field);
  const normalized = path.normalize(exact);
  if (
    path.isAbsolute(exact) ||
    exact.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith(`..${path.sep}`) ||
    path.parse(normalized).root
  ) {
    fail("PATH_INVALID", `${field} must remain below the descriptor.`);
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
    fail("PATH_INVALID", `${field} escapes the descriptor directory.`);
  }
  return target;
}

async function readStableFile(file, maximumBytes, field) {
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size <= 0n ||
    before.size > BigInt(maximumBytes)
  ) {
    fail("INPUT_UNSAFE", `${field} is not one bounded single-link file.`);
  }
  const handle = await open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
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
      fail("INPUT_CHANGED", `${field} changed during its bounded read.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function parseCanonical(bytes, field) {
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail("CANONICAL_INVALID", `${field} is not UTF-8 JSON.`, { cause: error });
  }
  if (canonicalProductionActivationJson(value) !== text) {
    fail(
      "CANONICAL_INVALID",
      `${field} must be sorted canonical JSON with one trailing LF.`,
    );
  }
  return Object.freeze({ text, value });
}

async function persistExclusive(outputDirectory, basename, canonical) {
  const target = path.join(outputDirectory, basename);
  const handle = await open(
    target,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      (fsConstants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(canonical, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const readback = await readStableFile(
    target,
    Buffer.byteLength(canonical, "utf8"),
    basename,
  );
  if (readback.toString("utf8") !== canonical) {
    fail("OUTPUT_INVALID", `${basename} durable read-back differs.`);
  }
  return target;
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
      "outputDirectory",
      "connection",
      "inputs",
      "authorizesApplicationStart",
    ],
    "descriptor",
  );
  const connection = exactObject(
    descriptor.connection,
    [
      "environmentVariable",
      "databaseName",
      "databaseUser",
      "expectedSchemaFingerprintSha256",
    ],
    "descriptor.connection",
  );
  const inputs = exactObject(
    descriptor.inputs,
    [
      "predecessorEvidence",
      "backupRestoreReference",
      "plan",
      "intent",
      "migrationReceipt",
      "roleReceipt",
      "challenge",
    ],
    "descriptor.inputs",
  );
  if (
    descriptor.schemaVersion !==
      PRODUCTION_INVOICE_0108_ACTIVATION_EVIDENCE_DESCRIPTOR_SCHEMA ||
    descriptor.kind !==
      "site-logbook-production-invoice-0108-activation-evidence" ||
    descriptor.executionDefault !== "disabled" ||
    descriptor.authorizesApplicationStart !== false
  ) {
    fail("DESCRIPTOR_INVALID", "Descriptor must be exact and default-dark.");
  }
  exactString(descriptor.sourceSha, "descriptor.sourceSha", SOURCE_SHA);
  relativePath(
    descriptor.migrationsDirectory,
    "descriptor.migrationsDirectory",
  );
  relativePath(descriptor.outputDirectory, "descriptor.outputDirectory");
  for (const [field, value] of Object.entries(inputs)) {
    relativePath(value, `descriptor.inputs.${field}`);
  }
  exactString(
    connection.environmentVariable,
    "descriptor.connection.environmentVariable",
    ENVIRONMENT_NAME,
  );
  exactString(
    connection.databaseName,
    "descriptor.connection.databaseName",
    IDENTIFIER,
  );
  exactString(
    connection.databaseUser,
    "descriptor.connection.databaseUser",
    IDENTIFIER,
  );
  exactString(
    connection.expectedSchemaFingerprintSha256,
    "descriptor.connection.expectedSchemaFingerprintSha256",
    SHA256_PIN,
  );
  return Object.freeze({
    ...descriptor,
    connection: Object.freeze({ ...connection }),
    inputs: Object.freeze({ ...inputs }),
  });
}

async function assertDirectory(directory, field) {
  const metadata = await lstat(directory, { bigint: true });
  const resolved = await realpath(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    path.resolve(resolved) !== path.resolve(directory)
  ) {
    fail("PATH_INVALID", `${field} must be one real directory.`);
  }
  return resolved;
}

function parseCli(argv) {
  const [command, ...rest] = argv;
  if (!new Set(["readiness", "approve", "assemble"]).has(command)) {
    fail("ARGUMENT_INVALID", "Command must be readiness, approve or assemble.");
  }
  if (rest.length % 2 !== 0) {
    fail("ARGUMENT_INVALID", "Options must be exact --name value pairs.");
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (
      !/^--[a-z][a-z-]*$/.test(String(flag)) ||
      !value ||
      value.startsWith("--") ||
      Object.hasOwn(options, flag.slice(2))
    ) {
      fail("ARGUMENT_INVALID", "Options are invalid or duplicated.");
    }
    options[flag.slice(2)] = value;
  }
  const required = {
    readiness: ["descriptor", "checked-at", "confirmation"],
    approve: ["descriptor", "operator", "approved-at", "confirmation"],
    assemble: ["descriptor", "confirmation"],
  }[command];
  if (
    Object.keys(options).length !== required.length ||
    required.some((field) => !Object.hasOwn(options, field))
  ) {
    fail("ARGUMENT_INVALID", "Options differ from the reviewed command.");
  }
  if (
    command === "readiness" &&
    options.confirmation !== PRODUCTION_INVOICE_0108_READINESS_CONFIRMATION
  ) {
    fail("CONFIRMATION_REQUIRED", "Readiness confirmation is not exact.");
  }
  if (
    command === "approve" &&
    options.confirmation !== PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION
  ) {
    fail("CONFIRMATION_REQUIRED", "Approval confirmation is not exact.");
  }
  if (
    command === "assemble" &&
    options.confirmation !==
      PRODUCTION_INVOICE_0108_EVIDENCE_ASSEMBLY_CONFIRMATION
  ) {
    fail("CONFIRMATION_REQUIRED", "Assembly confirmation is not exact.");
  }
  return Object.freeze({ command, options: Object.freeze(options) });
}

async function loadBoundArtifacts(descriptorDirectory, descriptor) {
  const read = async (name) =>
    parseCanonical(
      await readStableFile(
        resolveBelow(
          descriptorDirectory,
          descriptor.inputs[name],
          `descriptor.inputs.${name}`,
        ),
        MAX_INPUT_BYTES,
        name,
      ),
      name,
    );
  const [backup, plan, intent, migrationReceipt, roleReceipt] =
    await Promise.all(
      [
        "backupRestoreReference",
        "plan",
        "intent",
        "migrationReceipt",
        "roleReceipt",
      ].map(read),
    );
  const parsedPlan = parseProductionInvoice0108Plan(plan.text);
  const parsedIntent = parseProductionInvoice0108Intent(intent.text, plan.text);
  const parsedMigrationReceipt = parseProductionInvoice0108Receipt(
    migrationReceipt.text,
    plan.text,
    intent.text,
  );
  const parsedRoleReceipt = parseProductionInvoice0108RoleReceipt(
    roleReceipt.text,
    migrationReceipt.text,
  );
  if (
    parsedPlan.backup.artifact.canonical !== backup.text ||
    parsedIntent.plan.artifact.sha256 !== parsedPlan.artifact.sha256
  ) {
    fail("BINDING_INVALID", "0108 durable artifacts are not one exact chain.");
  }
  return Object.freeze({
    backup,
    plan,
    intent,
    migrationReceipt,
    roleReceipt,
    parsedMigrationReceipt,
    parsedRoleReceipt,
  });
}

function wrapArtifact(kind, parsed) {
  return Object.freeze({
    kind,
    payload: parsed.value,
    sha256: createHash("sha256").update(parsed.text, "utf8").digest("hex"),
  });
}

export async function executeProductionInvoice0108ActivationEvidence(
  argv,
  {
    environment = process.env,
    verifyReadiness = verifyLiveProductionInvoice0108Readiness,
  } = {},
) {
  const { command, options } = parseCli(argv);
  const descriptorFile = path.resolve(options.descriptor);
  const descriptorDirectory = await realpath(path.dirname(descriptorFile));
  const descriptor = parseDescriptor(
    parseCanonical(
      await readStableFile(descriptorFile, MAX_INPUT_BYTES, "descriptor"),
      "descriptor",
    ).value,
  );
  if (environment.BUILD_SHA !== descriptor.sourceSha) {
    fail("SOURCE_MISMATCH", "BUILD_SHA differs from the descriptor source.");
  }
  const migrationsDirectory = await assertDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.migrationsDirectory,
      "descriptor.migrationsDirectory",
    ),
    "descriptor.migrationsDirectory",
  );
  const outputDirectory = await assertDirectory(
    resolveBelow(
      descriptorDirectory,
      descriptor.outputDirectory,
      "descriptor.outputDirectory",
    ),
    "descriptor.outputDirectory",
  );
  const artifacts = await loadBoundArtifacts(descriptorDirectory, descriptor);

  if (command === "readiness") {
    const checkedAt = canonicalTimestamp(options["checked-at"], "checkedAt");
    const roleCompletedAt = canonicalTimestamp(
      artifacts.parsedRoleReceipt.value.completedAt,
      "roleReceipt.completedAt",
    );
    if (checkedAt < roleCompletedAt) {
      fail("TIME_INVALID", "Readiness cannot predate the role receipt.");
    }
    const databaseUrl = environment[descriptor.connection.environmentVariable];
    if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
      fail("CONNECTION_UNAVAILABLE", "Runtime database URL is unavailable.");
    }
    const live = await verifyReadiness({
      databaseUrl,
      migrationsDir: migrationsDirectory,
      expectedDatabaseName: descriptor.connection.databaseName,
      expectedDatabaseUser: descriptor.connection.databaseUser,
      buildSha: descriptor.sourceSha,
      expectedSchemaFingerprintSha256:
        descriptor.connection.expectedSchemaFingerprintSha256,
    });
    if (
      live.invoice0108Ready !== true ||
      live.roleDeltaReady !== true ||
      live.latestKnownAppliedTag !==
        PRODUCTION_INVOICE_0108_POST_STATE.latestKnownAppliedTag ||
      live.knownExpectedMigrations !== 108 ||
      live.knownAppliedMigrations !== 108 ||
      live.knownAppliedRowsSha256 !==
        PRODUCTION_INVOICE_0108_POST_STATE.knownAppliedRowsSha256 ||
      live.opaqueLegacyRowCount !== 2 ||
      live.opaqueLegacyRowsSha256 !== PRODUCTION_OPAQUE_LEGACY_ROWS_SHA256 ||
      live.excludedMigration0100Present !== false
    ) {
      fail("READINESS_INVALID", "Live exact-0108 readiness differs.");
    }
    const value = {
      schemaVersion: PRODUCTION_ACTIVATION_0108_READINESS_SCHEMA,
      kind: "site-logbook-production-invoice-0108-activation-readiness",
      decision: "PASS",
      sourceSha: descriptor.sourceSha,
      databaseName: live.databaseName,
      databaseUser: live.databaseUser,
      schemaFingerprintSha256: live.schemaFingerprintSha256,
      invoiceSchemaProjectionSha256: live.invoiceSchemaProjectionSha256,
      migrationReceiptSha256: artifacts.parsedMigrationReceipt.artifact.sha256,
      roleReceiptSha256: artifacts.parsedRoleReceipt.artifact.sha256,
      lineage: {
        decision: "ALREADY_0108",
        mode: "production-copy-restricted",
        knownExpectedMigrations: live.knownExpectedMigrations,
        knownAppliedMigrations: live.knownAppliedMigrations,
        knownAppliedRowsSha256: live.knownAppliedRowsSha256,
        latestKnownAppliedTag: live.latestKnownAppliedTag,
        missingKnownToPredecessor: 0,
        opaqueLegacyRowCount: live.opaqueLegacyRowCount,
        opaqueLegacyRowsSha256: live.opaqueLegacyRowsSha256,
        opaqueLegacyMeaningInferred: false,
        excludedMigration0100Present: false,
      },
      checkedAt: options["checked-at"],
      authorizesApplicationStart: false,
    };
    const canonical = canonicalProductionActivationJson(value);
    parseProductionActivation0108Readiness(canonical);
    const output = await persistExclusive(
      outputDirectory,
      OUTPUTS.readiness,
      canonical,
    );
    return Object.freeze({
      decision: "READINESS_DURABLE",
      output,
      sha256: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
      authorizesApplicationStart: false,
    });
  }

  if (command === "approve") {
    const readiness = parseCanonical(
      await readStableFile(
        path.join(outputDirectory, OUTPUTS.readiness),
        MAX_INPUT_BYTES,
        "readiness",
      ),
      "readiness",
    );
    const parsedReadiness = parseProductionActivation0108Readiness(
      readiness.text,
    );
    const challenge = exactObject(
      parseCanonical(
        await readStableFile(
          resolveBelow(
            descriptorDirectory,
            descriptor.inputs.challenge,
            "descriptor.inputs.challenge",
          ),
          MAX_INPUT_BYTES,
          "challenge",
        ),
        "challenge",
      ).value,
      ["kind", "sourceSha", "apiImage", "containerId", "nonce"],
      "challenge",
    );
    if (
      challenge.kind !== "site-logbook-production-activation-challenge-v3" ||
      challenge.sourceSha !== descriptor.sourceSha
    ) {
      fail("BINDING_INVALID", "Challenge is not the exact v3 source.");
    }
    const approvedAt = canonicalTimestamp(options["approved-at"], "approvedAt");
    if (
      approvedAt < canonicalTimestamp(parsedReadiness.checkedAt, "checkedAt")
    ) {
      fail("TIME_INVALID", "Approval cannot predate readiness.");
    }
    const value = {
      schemaVersion: PRODUCTION_ACTIVATION_0108_APPROVAL_SCHEMA,
      kind: "site-logbook-production-invoice-0108-activation-approval",
      decision: "APPROVE",
      confirmation: PRODUCTION_ACTIVATION_0108_APPROVAL_CONFIRMATION,
      sourceSha: descriptor.sourceSha,
      apiImage: challenge.apiImage,
      nonce: challenge.nonce,
      containerId: challenge.containerId,
      schemaReadinessSha256: `sha256:${createHash("sha256")
        .update(readiness.text)
        .digest("hex")}`,
      migrationReceiptSha256: artifacts.parsedMigrationReceipt.artifact.sha256,
      roleReceiptSha256: artifacts.parsedRoleReceipt.artifact.sha256,
      invoiceSchemaProjectionSha256:
        parsedReadiness.invoiceSchemaProjectionSha256,
      approvedAt: options["approved-at"],
      operator: exactString(options.operator, "operator"),
      authorizesApplicationStart: true,
      authorizesDeployment: false,
    };
    const canonical = canonicalProductionActivationJson(value);
    parseProductionActivation0108Approval(canonical);
    const output = await persistExclusive(
      outputDirectory,
      OUTPUTS.approval,
      canonical,
    );
    return Object.freeze({
      decision: "ATTENDED_APPROVAL_DURABLE",
      output,
      sha256: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
      authorizesApplicationStart: true,
      authorizesDeployment: false,
    });
  }

  const predecessor = exactObject(
    parseCanonical(
      await readStableFile(
        resolveBelow(
          descriptorDirectory,
          descriptor.inputs.predecessorEvidence,
          "descriptor.inputs.predecessorEvidence",
        ),
        MAX_INPUT_BYTES,
        "predecessorEvidence",
      ),
      "predecessorEvidence",
    ).value,
    [
      "activationApproval",
      "apiImageProvenance",
      "exact0096Backup",
      "finalObservations",
      "migration0096To0107",
      "runtimeDatabaseCredentialCutover",
    ],
    "predecessorEvidence",
  );
  const readiness = parseCanonical(
    await readStableFile(
      path.join(outputDirectory, OUTPUTS.readiness),
      MAX_INPUT_BYTES,
      "readiness",
    ),
    "readiness",
  );
  const approval = parseCanonical(
    await readStableFile(
      path.join(outputDirectory, OUTPUTS.approval),
      MAX_INPUT_BYTES,
      "approval",
    ),
    "approval",
  );
  parseProductionActivation0108Readiness(readiness.text);
  parseProductionActivation0108Approval(approval.text);
  const evidence = {
    ...predecessor,
    migration0107To0108: {
      activationApproval: wrapArtifact(
        "site-logbook-production-invoice-0108-activation-approval",
        approval,
      ),
      backupRestoreReference: wrapArtifact(
        "site-logbook-production-exact-0107-backup-restore-reference",
        artifacts.backup,
      ),
      intent: wrapArtifact(
        "site-logbook-production-invoice-0108-intent",
        artifacts.intent,
      ),
      migrationReceipt: wrapArtifact(
        "site-logbook-production-invoice-0108-receipt",
        artifacts.migrationReceipt,
      ),
      plan: wrapArtifact(
        "site-logbook-production-invoice-0108-plan",
        artifacts.plan,
      ),
      roleReceipt: wrapArtifact(
        "site-logbook-production-invoice-0108-role-delta-receipt",
        artifacts.roleReceipt,
      ),
      schemaReadiness: wrapArtifact(
        "site-logbook-production-invoice-0108-activation-readiness",
        readiness,
      ),
    },
  };
  const canonical = canonicalProductionActivationJson(evidence);
  const output = await persistExclusive(
    outputDirectory,
    OUTPUTS.evidence,
    canonical,
  );
  return Object.freeze({
    decision: "V3_EVIDENCE_DURABLE",
    output,
    sha256: `sha256:${createHash("sha256").update(canonical).digest("hex")}`,
    authorizesPublication: false,
    authorizesApplicationStart: false,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const result = await executeProductionInvoice0108ActivationEvidence(argv);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      error instanceof ProductionInvoice0108ActivationEvidenceError
        ? error.code
        : "PRODUCTION_INVOICE_0108_ACTIVATION_FAILED";
    process.stderr.write(`${code}: execution stopped.\n`);
    process.exitCode = 1;
  });
}

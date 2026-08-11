import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./check-staging-provisioning.mjs";

export const AUDIT_0107 = Object.freeze({
  action: "apply-0107",
  confirmation: "APPLY_0107_AUDIT_EVIDENCE_TO_ISOLATED_SITE_LOGBOOK_STAGING",
  backupAction: "create-exact-0106-audit-backup",
  backupConfirmation:
    "CREATE_FRESH_EXACT_0106_STAGING_BACKUP_AND_RESTORE_TEST_NO_0107",
  predecessorCount: 106,
  predecessorTag: "0106_graceful_frog_thor",
  targetCount: 107,
  targetIdx: 107,
  targetWhen: 1786484628859,
  targetTag: "0107_canonical_audit_evidence",
  // Hashes are over canonical LF bytes, not a platform checkout's line endings.
  migrationSha256:
    "5523f25b4c941919612f2f87a2d8fa371acd9922c3d3166b8d761000365e1339",
  predecessorSnapshotId: "18841ec6-0ec2-4ae8-8ac7-8ee8c1eb34cd",
  targetSnapshotId: "b20520fc-59f2-4d34-9e2f-9d7ed565288a",
  predecessorSnapshotSha256:
    "32e6cca10d51d73ebd7262a896e55390e823c286e71853e4aa13c8842ae4ab24",
  targetSnapshotSha256:
    "4973350b31c540f44a539ff896342b8d8b95b8fe394a9a257ba828276824afbb",
  predecessorKnownRowsSha256:
    "sha256:cfbf74de83f99c3ca49fb717a6784265e8ef193e75e894aab9924fb7b80e16ee",
  targetKnownRowsSha256:
    "sha256:d34407b4cdb8b0dc8bb9d07cd6cd500be5853d3112e142fe44e0efa5b8cd7cc1",
  maxPayloadBytes: 256 * 1024 * 1024,
});

export const AUDIT_0107_FILES = Object.freeze({
  backup: "staging-exact-0106-audit-backup-execution.json",
  backupChecksum: "staging-exact-0106-audit-backup-execution.sha256",
  transition: "staging-audit-0107-transition.json",
  transitionChecksum: "staging-audit-0107-transition.sha256",
  inspect: "staging-audit-0107-inspect.json",
  inspectChecksum: "staging-audit-0107-inspect.sha256",
  environment: "staging-audit-0107.env",
  intent: "staging-audit-0107-intent.json",
  intentChecksum: "staging-audit-0107-intent.sha256",
  execution: "staging-audit-0107-execution.json",
  executionChecksum: "staging-audit-0107-execution.sha256",
});

export const AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS = Object.freeze([
  Object.freeze({
    createdAt: 1783190993468,
    hash: "fe7cb6a82d419b32a4a71e54476a5431b2260e876de1a4e37f156f151a8b6927",
  }),
  Object.freeze({
    createdAt: 1783261969512,
    hash: "3355fdc1265e205de92dae49d7f51d3a01fbc9e3d37c6512f92536d27081affa",
  }),
]);

export class StagingAudit0107ContractError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingAudit0107ContractError";
    this.code = code;
  }
}

export function audit0107Fail(code, message) {
  throw new StagingAudit0107ContractError(code, message);
}

export function exactKeys(
  value,
  keys,
  field,
  code = "AUDIT_0107_SCHEMA_INVALID",
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    audit0107Fail(code, `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    audit0107Fail(code, `${field} must contain only approved fields.`);
  }
  return value;
}

export function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) {
    audit0107Fail("AUDIT_0107_SCHEMA_INVALID", `${field} must be positive.`);
  }
  return value;
}

export function canonicalTimestamp(value, field) {
  if (typeof value !== "string" || !value.endsWith("Z")) {
    audit0107Fail("AUDIT_0107_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    audit0107Fail("AUDIT_0107_TIME_INVALID", `${field} must be canonical UTC.`);
  }
  return parsed;
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function trustedCanonicalArtifact({
  bytes,
  checksumText,
  expectedSha256,
  name,
  label,
}) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    !/^[0-9a-f]{64}$/.test(expectedSha256 ?? "")
  ) {
    audit0107Fail(
      "AUDIT_0107_INPUT_INVALID",
      `${label} bytes and a reviewed SHA-256 are required.`,
    );
  }
  const actualSha256 = sha256(bytes);
  if (
    actualSha256 !== expectedSha256 ||
    checksumText !== `${expectedSha256}  ${name}\n`
  ) {
    audit0107Fail(
      "AUDIT_0107_HASH_MISMATCH",
      `${label} does not match its reviewed bytes and checksum.`,
    );
  }
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    audit0107Fail("AUDIT_0107_JSON_INVALID", `${label} must be strict JSON.`);
  }
  if (!bytes.equals(Buffer.from(canonicalJson(value), "utf8"))) {
    audit0107Fail(
      "AUDIT_0107_CANONICAL_INVALID",
      `${label} must use canonical JSON bytes.`,
    );
  }
  return Object.freeze({ value, sha256: actualSha256 });
}

export function canonicalOpaqueLegacyRows(value, mode) {
  if (!Array.isArray(value)) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Opaque legacy rows must be an array.",
    );
  }
  const rows = value.map((row, index) => {
    exactKeys(
      row,
      ["createdAt", "hash"],
      `opaque legacy row ${index}`,
      "AUDIT_0107_LINEAGE_INVALID",
    );
    if (
      !Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 1 ||
      !/^[0-9a-f]{64}$/.test(String(row.hash))
    ) {
      audit0107Fail(
        "AUDIT_0107_LINEAGE_INVALID",
        "Opaque legacy row identities must contain a positive createdAt and lowercase hash.",
      );
    }
    return { createdAt: row.createdAt, hash: row.hash };
  });
  const sorted = [...rows].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.hash.localeCompare(right.hash),
  );
  if (JSON.stringify(rows) !== JSON.stringify(sorted)) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Opaque legacy row identities must be in canonical sorted order.",
    );
  }
  if (
    (mode === "clean" && rows.length !== 0) ||
    (mode === "production-copy-restricted" && rows.length !== 2) ||
    !["clean", "production-copy-restricted"].includes(mode)
  ) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Lineage mode and exact opaque legacy row count do not match.",
    );
  }
  if (
    mode === "production-copy-restricted" &&
    JSON.stringify(rows) !== JSON.stringify(AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS)
  ) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Restricted production-copy lineage must use the two frozen opaque row identities.",
    );
  }
  const opaqueLegacyRowsJson = JSON.stringify(rows);
  return Object.freeze({
    mode,
    opaqueLegacyRows: Object.freeze(rows),
    opaqueLegacyRowsJson,
    opaqueLegacyRowsSha256: `sha256:${sha256(Buffer.from(opaqueLegacyRowsJson, "utf8"))}`,
    knownExpectedMigrations: AUDIT_0107.targetCount,
    totalJournalRows: AUDIT_0107.targetCount + rows.length,
  });
}

export function parseOpaqueLegacyRowsJson(text, mode) {
  if (typeof text !== "string") {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "The exact opaque legacy row JSON is required.",
    );
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Opaque legacy row identities must be strict JSON.",
    );
  }
  if (JSON.stringify(value) !== text) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_INVALID",
      "Opaque legacy row identities must use canonical JSON bytes.",
    );
  }
  return canonicalOpaqueLegacyRows(value, mode);
}

export function validateLineageSummary(value, expected, appliedCount) {
  exactKeys(
    value,
    [
      "decision",
      "knownAppliedRowsSha256",
      "mode",
      "knownExpectedMigrations",
      "knownAppliedMigrations",
      "latestKnownAppliedTag",
      "missingKnownToPredecessor",
      "opaqueLegacyRowCount",
      "opaqueLegacyRowsSha256",
      "opaqueLegacyMeaningInferred",
      "excludedMigration0100Present",
    ],
    "audit lineage",
  );
  const predecessor = appliedCount === AUDIT_0107.predecessorCount;
  if (
    value.decision !== (predecessor ? "READY_0106" : "ALREADY_0107") ||
    value.knownAppliedRowsSha256 !==
      (predecessor
        ? AUDIT_0107.predecessorKnownRowsSha256
        : AUDIT_0107.targetKnownRowsSha256) ||
    value.mode !== expected.mode ||
    value.knownExpectedMigrations !== AUDIT_0107.targetCount ||
    value.knownAppliedMigrations !== appliedCount ||
    value.latestKnownAppliedTag !==
      (predecessor ? AUDIT_0107.predecessorTag : AUDIT_0107.targetTag) ||
    value.missingKnownToPredecessor !== 0 ||
    value.opaqueLegacyRowCount !== expected.opaqueLegacyRows.length ||
    value.opaqueLegacyRowsSha256 !== expected.opaqueLegacyRowsSha256 ||
    value.opaqueLegacyMeaningInferred !== false ||
    value.excludedMigration0100Present !== false
  ) {
    audit0107Fail(
      "AUDIT_0107_LINEAGE_MISMATCH",
      "Database lineage does not match the reviewed 0106 to 0107 boundary.",
    );
  }
  return Object.freeze(value);
}

export function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    audit0107Fail(
      "AUDIT_0107_OUTPUT_EXISTS",
      `${name} already exists; use a fresh evidence directory.`,
    );
  }
  const temporary = path.join(
    directory,
    `.${name}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, bytes, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // `rename(2)` replaces an existing destination on POSIX.  A preflight
    // exists check is therefore not enough for evidence files: another writer
    // could create the reviewed name between that check and the rename.  A
    // hard-link creation is atomic and fails with EEXIST instead of clobbering
    // the winner.  The temporary inode is removed only after the destination
    // link exists.
    try {
      fs.linkSync(temporary, target);
    } catch (error) {
      if (error?.code === "EEXIST") {
        audit0107Fail(
          "AUDIT_0107_OUTPUT_EXISTS",
          `${name} already exists; evidence was not overwritten.`,
        );
      }
      throw error;
    }
    fs.unlinkSync(temporary);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return target;
}

export function prepareExclusiveOutput(directory, names) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    audit0107Fail(
      "AUDIT_0107_OUTPUT_INVALID",
      "Output must be a nonsymlink directory.",
    );
  }
  for (const name of names) {
    if (fs.existsSync(path.join(absolute, name))) {
      audit0107Fail(
        "AUDIT_0107_OUTPUT_EXISTS",
        `${name} already exists; use a fresh evidence directory.`,
      );
    }
  }
  return absolute;
}

export function writeCanonicalPair(directory, name, checksumName, value) {
  const bytes = canonicalJson(value);
  const digest = sha256(Buffer.from(bytes, "utf8"));
  const target = atomicWriteExclusive(directory, name, bytes);
  const checksum = atomicWriteExclusive(
    directory,
    checksumName,
    `${digest}  ${name}\n`,
  );
  return Object.freeze({ target, checksum, sha256: digest });
}

export function readRegularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    audit0107Fail(
      "AUDIT_0107_INPUT_INVALID",
      `${label} must be a regular file.`,
    );
  }
  return absolute;
}

export function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function requiredArgument(name) {
  const value = argument(name);
  if (!value) {
    audit0107Fail("AUDIT_0107_ARGUMENT_MISSING", `${name} is required.`);
  }
  return value;
}

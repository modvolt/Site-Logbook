import { createHash } from "node:crypto";
import type { ExternalSchemaInventorySummary } from "./external-schema-preflight";

export const STAGING_BASELINE_0104_ACTION = "apply-0104-baseline";
export const STAGING_BASELINE_0104_CONFIRMATION =
  "APPLY_FIXED_PREDECESSOR_0104_TO_ISOLATED_SITE_LOGBOOK_STAGING";
export const STAGING_BASELINE_0104_SOURCE_SHA =
  "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
export const STAGING_BASELINE_0104_SOURCE_TREE =
  "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
export const STAGING_BASELINE_0104_LATEST_TAG =
  "0104_thin_sheva_callister";

const SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const CANDIDATE_API_IMAGE =
  /^ghcr\.io\/modvolt\/site-logbook-staging-api@sha256:[0-9a-f]{64}$/;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_PREDECESSOR_MANIFEST_BYTES = 64 * 1024;

export class StagingBaseline0104Error extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StagingBaseline0104Error";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new StagingBaseline0104Error(code, message);
}

function requiredRaw(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("BASELINE_ENV_MISSING", `${key} must be set.`);
  }
  return value;
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  field: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("BASELINE_INPUT_SCHEMA_INVALID", `${field} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(
      "BASELINE_INPUT_SCHEMA_INVALID",
      `${field} has missing or unknown fields.`,
    );
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key]),
        ]),
    );
  }
  return value;
}

function decodeBase64(raw: string, maximumBytes: number, field: string): Buffer {
  if (
    raw.length === 0 ||
    raw.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      raw,
    )
  ) {
    fail("BASELINE_INPUT_BASE64_INVALID", `${field} must be canonical base64.`);
  }
  const bytes = Buffer.from(raw, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== raw
  ) {
    fail(
      "BASELINE_INPUT_BASE64_INVALID",
      `${field} exceeds its size bound or is not canonical.`,
    );
  }
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseJson(bytes: Buffer, field: string): unknown {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    fail("BASELINE_INPUT_ENCODING_INVALID", `${field} must not contain a BOM.`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("BASELINE_INPUT_ENCODING_INVALID", `${field} must be valid UTF-8.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail("BASELINE_INPUT_JSON_INVALID", `${field} must be strict JSON.`);
  }
}

function stringAt(
  object: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  field: string,
): string {
  const value = object[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("BASELINE_INPUT_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value;
}

function positiveIntegerAt(
  object: Record<string, unknown>,
  key: string,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = object[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail("BASELINE_INPUT_SCHEMA_INVALID", `${field} is invalid.`);
  }
  return value as number;
}

export interface StagingBaseline0104Environment {
  phase: "pre" | "post";
  inputsSha256: string;
  candidateSourceSha: string;
  candidateApiImage: string;
  predecessorSourceSha: string;
  predecessorSourceTree: string;
  predecessorApiImage: string;
  predecessorManifestSha256: string;
  backupEvidenceId: number;
  backupRestoreMaxAgeHours: number;
}

export function readStagingBaseline0104Environment(
  env: NodeJS.ProcessEnv = process.env,
): StagingBaseline0104Environment {
  if (requiredRaw(env, "STAGING_BASELINE_0104_ACTION") !== STAGING_BASELINE_0104_ACTION) {
    fail("BASELINE_ACTION_INVALID", "The exact baseline action is required.");
  }
  if (
    requiredRaw(env, "STAGING_BASELINE_0104_CONFIRMATION") !==
    STAGING_BASELINE_0104_CONFIRMATION
  ) {
    fail(
      "BASELINE_CONFIRMATION_INVALID",
      "The exact isolated baseline confirmation phrase is required.",
    );
  }
  const phase = requiredRaw(env, "STAGING_BASELINE_0104_PHASE");
  if (phase !== "pre" && phase !== "post") {
    fail("BASELINE_PHASE_INVALID", "Baseline phase must be pre or post.");
  }
  if (
    requiredRaw(env, "STAGING_SCHEMA_ACTION") !== "inspect" ||
    (env.STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION ?? "") !== ""
  ) {
    fail(
      "BASELINE_PRIMARY_GATE_UNSAFE",
      "The primary schema action must remain inspect without a 0105 confirmation.",
    );
  }

  const inputsSha256 = requiredRaw(env, "STAGING_BASELINE_0104_INPUTS_SHA256");
  if (!SHA256.test(inputsSha256)) {
    fail("BASELINE_INPUT_HASH_INVALID", "Baseline input SHA-256 is invalid.");
  }
  const inputBytes = decodeBase64(
    requiredRaw(env, "STAGING_BASELINE_0104_INPUTS_B64"),
    MAX_INPUT_BYTES,
    "baseline inputs",
  );
  if (sha256(inputBytes) !== inputsSha256) {
    fail(
      "BASELINE_INPUT_HASH_MISMATCH",
      "Baseline input bytes do not match the approved checksum.",
    );
  }
  const input = parseJson(inputBytes, "baseline inputs");
  const canonical = `${JSON.stringify(canonicalValue(input))}\n`;
  if (!inputBytes.equals(Buffer.from(canonical, "utf8"))) {
    fail(
      "BASELINE_INPUT_NOT_CANONICAL",
      "Baseline inputs must use the canonical JSON serialization.",
    );
  }
  exactKeys(
    input,
    [
      "schemaVersion",
      "kind",
      "action",
      "productionTargetsTouched",
      "environmentId",
      "composeProjectName",
      "database",
      "externalAccountsEnabled",
      "candidate",
      "predecessor",
      "backup",
      "target",
      "nextGate",
      "authorizes0105",
    ],
    "baseline inputs",
  );
  if (
    input.schemaVersion !== 1 ||
    input.kind !== "site-logbook-staging-baseline-0104" ||
    input.action !== STAGING_BASELINE_0104_ACTION ||
    input.productionTargetsTouched !== false ||
    input.environmentId !== "site-logbook-staging" ||
    typeof input.composeProjectName !== "string" ||
    !/^site-logbook-staging(?:-[a-z0-9-]+)?$/.test(input.composeProjectName) ||
    input.externalAccountsEnabled !== false ||
    input.nextGate !== "fresh-exact-0104-backup-and-restore-required" ||
    input.authorizes0105 !== false
  ) {
    fail(
      "BASELINE_INPUT_BOUNDARY_INVALID",
      "Baseline inputs do not preserve the isolated no-0105 boundary.",
    );
  }

  exactKeys(input.database, ["host", "name", "user"], "database");
  if (
    input.database.host !== "postgres" ||
    input.database.name !== "site_logbook_staging" ||
    input.database.user !== "site_logbook_staging"
  ) {
    fail(
      "BASELINE_DATABASE_IDENTITY_INVALID",
      "Baseline database identity must be the exact isolated staging database.",
    );
  }

  exactKeys(
    input.candidate,
    [
      "sourceSha",
      "imageManifestSha256",
      "provisioningManifestSha256",
      "inspectInputsSha256",
      "apiImage",
    ],
    "candidate",
  );
  const candidateSourceSha = stringAt(
    input.candidate,
    "sourceSha",
    FULL_SHA,
    "candidate.sourceSha",
  );
  const candidateApiImage = stringAt(
    input.candidate,
    "apiImage",
    CANDIDATE_API_IMAGE,
    "candidate.apiImage",
  );
  const candidateImageManifestSha256 = stringAt(
    input.candidate,
    "imageManifestSha256",
    SHA256,
    "candidate.imageManifestSha256",
  );
  const provisioningManifestSha256 = stringAt(
    input.candidate,
    "provisioningManifestSha256",
    SHA256,
    "candidate.provisioningManifestSha256",
  );
  const inspectInputsSha256 = stringAt(
    input.candidate,
    "inspectInputsSha256",
    SHA256,
    "candidate.inspectInputsSha256",
  );

  exactKeys(
    input.predecessor,
    [
      "sourceSha",
      "sourceTree",
      "imageManifestSha256",
      "apiImage",
      "publisherRun",
    ],
    "predecessor",
  );
  const predecessorSourceSha = stringAt(
    input.predecessor,
    "sourceSha",
    FULL_SHA,
    "predecessor.sourceSha",
  );
  const predecessorSourceTree = stringAt(
    input.predecessor,
    "sourceTree",
    FULL_SHA,
    "predecessor.sourceTree",
  );
  const predecessorManifestSha256 = stringAt(
    input.predecessor,
    "imageManifestSha256",
    SHA256,
    "predecessor.imageManifestSha256",
  );
  const predecessorApiImage = stringAt(
    input.predecessor,
    "apiImage",
    CANDIDATE_API_IMAGE,
    "predecessor.apiImage",
  );
  exactKeys(input.predecessor.publisherRun, ["id", "attempt"], "publisherRun");
  stringAt(
    input.predecessor.publisherRun,
    "id",
    /^[1-9][0-9]*$/,
    "publisherRun.id",
  );
  stringAt(
    input.predecessor.publisherRun,
    "attempt",
    /^[1-9][0-9]*$/,
    "publisherRun.attempt",
  );
  if (
    predecessorSourceSha !== STAGING_BASELINE_0104_SOURCE_SHA ||
    predecessorSourceTree !== STAGING_BASELINE_0104_SOURCE_TREE ||
    predecessorApiImage === candidateApiImage
  ) {
    fail(
      "BASELINE_PREDECESSOR_IDENTITY_INVALID",
      "Predecessor source/tree must be fixed and its digest must differ from the candidate.",
    );
  }

  exactKeys(input.backup, ["evidenceId", "restoreMaxAgeHours"], "backup");
  const backupEvidenceId = positiveIntegerAt(
    input.backup,
    "evidenceId",
    "backup.evidenceId",
  );
  const backupRestoreMaxAgeHours = positiveIntegerAt(
    input.backup,
    "restoreMaxAgeHours",
    "backup.restoreMaxAgeHours",
    168,
  );
  exactKeys(
    input.target,
    ["migrationCount", "latestTag", "excluded0100", "excluded0105"],
    "target",
  );
  if (
    input.target.migrationCount !== 104 ||
    input.target.latestTag !== STAGING_BASELINE_0104_LATEST_TAG ||
    input.target.excluded0100 !== true ||
    input.target.excluded0105 !== true
  ) {
    fail(
      "BASELINE_TARGET_INVALID",
      "Baseline target must be exact 104/0104 with 0100 and 0105 excluded.",
    );
  }

  const runtimePairs: Array<[string | undefined, string, string]> = [
    [env.STAGING_ENVIRONMENT_ID, input.environmentId as string, "environment id"],
    [
      env.STAGING_COMPOSE_PROJECT_NAME,
      input.composeProjectName as string,
      "compose project",
    ],
    [env.STAGING_DATABASE_HOST, input.database.host as string, "database host"],
    [env.STAGING_DATABASE_NAME, input.database.name as string, "database name"],
    [env.STAGING_DATABASE_USER, input.database.user as string, "database user"],
    [env.BUILD_SHA, candidateSourceSha, "baked candidate SHA"],
    [env.STAGING_BUILD_SHA, candidateSourceSha, "staging candidate SHA"],
    [
      env.STAGING_IMAGE_MANIFEST_SOURCE_SHA,
      candidateSourceSha,
      "candidate manifest source SHA",
    ],
    [env.STAGING_API_IMAGE, candidateApiImage, "candidate API image"],
    [
      env.STAGING_IMAGE_MANIFEST_SHA256,
      candidateImageManifestSha256,
      "candidate manifest checksum",
    ],
    [
      env.STAGING_PROVISIONING_MANIFEST_SHA256,
      provisioningManifestSha256,
      "provisioning checksum",
    ],
    [
      env.STAGING_DEPLOYMENT_INPUTS_SHA256,
      inspectInputsSha256,
      "candidate inspect input checksum",
    ],
    [
      env.STAGING_PREDECESSOR_0104_SOURCE_SHA,
      predecessorSourceSha,
      "predecessor source SHA",
    ],
    [
      env.STAGING_PREDECESSOR_0104_MANIFEST_SHA256,
      predecessorManifestSha256,
      "predecessor manifest checksum",
    ],
    [
      env.STAGING_PREDECESSOR_0104_API_IMAGE,
      predecessorApiImage,
      "predecessor API image",
    ],
    [
      env.STAGING_BACKUP_EVIDENCE_ID,
      String(backupEvidenceId),
      "backup evidence id",
    ],
    [
      env.STAGING_BACKUP_RESTORE_MAX_AGE_HOURS,
      String(backupRestoreMaxAgeHours),
      "backup restore maximum age",
    ],
  ];
  for (const [actual, expected, field] of runtimePairs) {
    if (actual !== expected) {
      fail(
        "BASELINE_RUNTIME_BINDING_MISMATCH",
        `Runtime ${field} does not match the approved baseline inputs.`,
      );
    }
  }
  if (env.STAGING_EXTERNAL_ACCOUNTS_ENABLED !== "false") {
    fail(
      "BASELINE_FEATURE_FLAG_UNSAFE",
      "External accounts must stay exactly false during baseline migration.",
    );
  }

  const predecessorBytes = decodeBase64(
    requiredRaw(env, "STAGING_PREDECESSOR_0104_MANIFEST_B64"),
    MAX_PREDECESSOR_MANIFEST_BYTES,
    "predecessor manifest",
  );
  if (sha256(predecessorBytes) !== predecessorManifestSha256) {
    fail(
      "BASELINE_PREDECESSOR_MANIFEST_MISMATCH",
      "Predecessor manifest bytes do not match the approved checksum.",
    );
  }
  const predecessorManifest = parseJson(
    predecessorBytes,
    "predecessor manifest",
  );
  if (
    !predecessorManifest ||
    typeof predecessorManifest !== "object" ||
    Array.isArray(predecessorManifest) ||
    (predecessorManifest as Record<string, unknown>).schemaVersion !== 2 ||
    (predecessorManifest as Record<string, unknown>).kind !==
      "site-logbook-staging-predecessor-api" ||
    (predecessorManifest as Record<string, unknown>).sourceSha !==
      predecessorSourceSha ||
    (predecessorManifest as Record<string, unknown>).sourceTree !==
      predecessorSourceTree ||
    (predecessorManifest as Record<string, unknown>).image !== predecessorApiImage
  ) {
    fail(
      "BASELINE_PREDECESSOR_MANIFEST_INVALID",
      "Predecessor manifest identity does not match the approved baseline inputs.",
    );
  }

  return Object.freeze({
    phase,
    inputsSha256,
    candidateSourceSha,
    candidateApiImage,
    predecessorSourceSha,
    predecessorSourceTree,
    predecessorApiImage,
    predecessorManifestSha256,
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
}

export interface StagingBaseline0104Decision {
  phase: "pre" | "post";
  operation: "migrate" | "verified-noop" | "ready";
  decision: "BASELINE_0104_REQUIRED" | "READY_0104";
}

export function evaluateStagingBaseline0104Decision(
  phase: "pre" | "post",
  inventory: Pick<
    ExternalSchemaInventorySummary,
    | "decision"
    | "appliedMigrations"
    | "predecessorMigrations"
    | "latestAppliedTag"
    | "missingToPredecessor"
  >,
): StagingBaseline0104Decision {
  if (inventory.predecessorMigrations !== 104) {
    fail(
      "BASELINE_INVENTORY_INVALID",
      "Candidate inventory does not identify exact 104 as its predecessor.",
    );
  }
  if (phase === "pre" && inventory.decision === "BASELINE_0104_REQUIRED") {
    if (
      inventory.appliedMigrations < 0 ||
      inventory.appliedMigrations >= 104 ||
      inventory.missingToPredecessor !== 104 - inventory.appliedMigrations
    ) {
      fail(
        "BASELINE_INVENTORY_INVALID",
        "Precheck baseline inventory counts are inconsistent.",
      );
    }
    return Object.freeze({
      phase,
      operation: "migrate",
      decision: inventory.decision,
    });
  }
  if (inventory.decision === "READY_0104") {
    if (
      inventory.appliedMigrations !== 104 ||
      inventory.missingToPredecessor !== 0 ||
      inventory.latestAppliedTag !== STAGING_BASELINE_0104_LATEST_TAG
    ) {
      fail(
        "BASELINE_INVENTORY_INVALID",
        "Exact-0104 inventory counts or tail are inconsistent.",
      );
    }
    return Object.freeze({
      phase,
      operation: phase === "pre" ? "verified-noop" : "ready",
      decision: inventory.decision,
    });
  }
  fail(
    "BASELINE_STATE_INVALID",
    phase === "pre"
      ? "Precheck accepts only an exact prefix before 0104 or exact 0104."
      : "Postcheck requires exact 0104.",
  );
}

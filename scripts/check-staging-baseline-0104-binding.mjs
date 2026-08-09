import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "./check-staging-provisioning.mjs";
import { createStagingDeploymentBinding } from "./check-staging-deployment-binding.mjs";
import { validateStagingPredecessorImage } from "./verify-staging-predecessor-image.mjs";

const FIXED_PREDECESSOR_SHA =
  "c3a83a0e68e4c2eb4b2a64661e0396c81f1adde3";
const FIXED_PREDECESSOR_TREE =
  "cd46c3bcf51d6ab64f2fe788e0a7af97e74c999c";
const FIXED_PREDECESSOR_TAIL = "0104_thin_sheva_callister";
const BASELINE_ACTION = "apply-0104-baseline";

export class StagingBaseline0104BindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingBaseline0104BindingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingBaseline0104BindingError(code, message);
}

function requireHash(value, field) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    fail("BASELINE_BINDING_HASH_INVALID", `${field} must be 64 lowercase hex.`);
  }
  return value;
}

function requireImage(value, field) {
  if (
    typeof value !== "string" ||
    !/^ghcr\.io\/modvolt\/[a-z0-9-]+@sha256:[0-9a-f]{64}$/.test(value)
  ) {
    fail(
      "BASELINE_BINDING_IMAGE_INVALID",
      `${field} must be an immutable modvolt GHCR digest reference.`,
    );
  }
  return value;
}

function requirePositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(
      "BASELINE_BINDING_NUMBER_INVALID",
      `${field} must be a positive bounded integer.`,
    );
  }
  return value;
}

export function buildStagingBaseline0104Inputs({
  candidateBinding,
  predecessor,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  if (
    !candidateBinding ||
    candidateBinding.decision !== "PASS" ||
    candidateBinding.inspect?.inputs?.schemaAction !== "inspect" ||
    candidateBinding.inspect?.inputs?.externalAccountsEnabled !== false
  ) {
    fail(
      "BASELINE_BINDING_CANDIDATE_INVALID",
      "A validated dark-rollout candidate inspect binding is required.",
    );
  }
  if (!predecessor || predecessor.decision !== "PASS" || !predecessor.trusted) {
    fail(
      "BASELINE_BINDING_PREDECESSOR_UNTRUSTED",
      "A separately approved predecessor manifest checksum is required.",
    );
  }
  if (
    predecessor.sourceSha !== FIXED_PREDECESSOR_SHA ||
    predecessor.sourceTree !== FIXED_PREDECESSOR_TREE
  ) {
    fail(
      "BASELINE_BINDING_PREDECESSOR_INVALID",
      "Predecessor source and tree must match the fixed audited 0104 build.",
    );
  }

  const candidate = candidateBinding.inspect.inputs;
  const candidateApiImage = requireImage(candidate.images?.api, "candidate API image");
  const predecessorApiImage = requireImage(
    predecessor.image,
    "predecessor API image",
  );
  if (candidateApiImage === predecessorApiImage) {
    fail(
      "BASELINE_BINDING_IMAGE_COLLISION",
      "Candidate and predecessor API images must have distinct immutable digests.",
    );
  }

  const evidenceId = requirePositiveInteger(backupEvidenceId, "backupEvidenceId");
  const restoreMaxAge = requirePositiveInteger(
    backupRestoreMaxAgeHours,
    "backupRestoreMaxAgeHours",
    168,
  );

  return Object.freeze({
    schemaVersion: 1,
    kind: "site-logbook-staging-baseline-0104",
    action: BASELINE_ACTION,
    productionTargetsTouched: false,
    environmentId: candidate.environmentId,
    composeProjectName: candidate.composeProjectName,
    database: Object.freeze({
      host: "postgres",
      name: "site_logbook_staging",
      user: "site_logbook_staging",
    }),
    externalAccountsEnabled: false,
    candidate: Object.freeze({
      sourceSha: candidate.sourceSha,
      imageManifestSha256: requireHash(
        candidate.imageManifestSha256,
        "candidate imageManifestSha256",
      ),
      provisioningManifestSha256: requireHash(
        candidate.provisioningManifestSha256,
        "candidate provisioningManifestSha256",
      ),
      inspectInputsSha256: requireHash(
        candidateBinding.inspect.sha256,
        "candidate inspect inputs SHA-256",
      ),
      apiImage: candidateApiImage,
    }),
    predecessor: Object.freeze({
      sourceSha: predecessor.sourceSha,
      sourceTree: predecessor.sourceTree,
      imageManifestSha256: requireHash(
        predecessor.manifestSha256,
        "predecessor image manifest SHA-256",
      ),
      apiImage: predecessorApiImage,
      publisherRun: Object.freeze({ ...predecessor.publisherRun }),
    }),
    backup: Object.freeze({
      evidenceId,
      restoreMaxAgeHours: restoreMaxAge,
    }),
    target: Object.freeze({
      migrationCount: 104,
      latestTag: FIXED_PREDECESSOR_TAIL,
      excluded0100: true,
      excluded0105: true,
    }),
    nextGate: "fresh-exact-0104-backup-and-restore-required",
    authorizes0105: false,
  });
}

export function baseline0104InputsSha256(inputs) {
  return crypto.createHash("sha256").update(canonicalJson(inputs)).digest("hex");
}

export function createStagingBaseline0104Binding({
  candidateManifestBytes,
  candidateChecksumText,
  provisioningManifest,
  expectedCandidateManifestSha256,
  expectedCandidateSourceSha,
  expectedCandidateCallerWorkflowRef,
  expectedCandidateRunId,
  expectedCandidateRunAttempt,
  predecessorManifestBytes,
  predecessorChecksumText,
  expectedPredecessorManifestSha256,
  expectedPredecessorCallerWorkflowRef,
  expectedPredecessorRunId,
  expectedPredecessorRunAttempt,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  const candidateBinding = createStagingDeploymentBinding({
    manifestBytes: candidateManifestBytes,
    checksumText: candidateChecksumText,
    provisioningManifest,
    expectedManifestSha256: expectedCandidateManifestSha256,
    expectedSourceSha: expectedCandidateSourceSha,
    expectedCallerWorkflowRef: expectedCandidateCallerWorkflowRef,
    expectedRunId: expectedCandidateRunId,
    expectedRunAttempt: expectedCandidateRunAttempt,
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const predecessor = validateStagingPredecessorImage(
    predecessorManifestBytes,
    predecessorChecksumText,
    {
      expectedManifestSha256: expectedPredecessorManifestSha256,
      expectedCallerWorkflowRef: expectedPredecessorCallerWorkflowRef,
      expectedRunId: expectedPredecessorRunId,
      expectedRunAttempt: expectedPredecessorRunAttempt,
    },
  );
  const inputs = buildStagingBaseline0104Inputs({
    candidateBinding,
    predecessor,
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const inputsBytes = Buffer.from(canonicalJson(inputs), "utf8");
  const inputsSha256 = baseline0104InputsSha256(inputs);
  const environment = Object.freeze({
    ...candidateBinding.inspect.environment,
    STAGING_SCHEMA_ACTION: "inspect",
    STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION: "",
    STAGING_BASELINE_0104_ACTION: BASELINE_ACTION,
    STAGING_BASELINE_0104_CONFIRMATION: "",
    STAGING_BASELINE_0104_INPUTS_B64: inputsBytes.toString("base64"),
    STAGING_BASELINE_0104_INPUTS_SHA256: inputsSha256,
    STAGING_PREDECESSOR_0104_MANIFEST_B64: predecessor.manifestBase64,
    STAGING_PREDECESSOR_0104_MANIFEST_SHA256: predecessor.manifestSha256,
    STAGING_PREDECESSOR_0104_API_IMAGE: predecessor.image,
    STAGING_PREDECESSOR_0104_SOURCE_SHA: predecessor.sourceSha,
  });
  return Object.freeze({
    decision: "PASS",
    inputs,
    inputsSha256,
    environment,
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name) {
  const value = argument(name);
  if (!value) fail("BASELINE_BINDING_INPUT_MISSING", `${name} is required.`);
  return value;
}

function regularFile(value, label) {
  const absolute = path.resolve(value);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("BASELINE_BINDING_INPUT_INVALID", `${label} must be a regular file.`);
  }
  return absolute;
}

function atomicWriteExclusive(directory, name, bytes) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "BASELINE_BINDING_OUTPUT_EXISTS",
      `${name} already exists; use a new evidence directory.`,
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
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  return target;
}

export function writeStagingBaseline0104Binding(directory, result) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "BASELINE_BINDING_OUTPUT_INVALID",
      "Output directory must be a nonsymlink directory.",
    );
  }
  const inputsName = "staging-baseline-0104-inputs.json";
  const inputsBytes = canonicalJson(result.inputs);
  return Object.freeze({
    inputs: atomicWriteExclusive(absolute, inputsName, inputsBytes),
    checksum: atomicWriteExclusive(
      absolute,
      "staging-baseline-0104-inputs.sha256",
      `${result.inputsSha256}  ${inputsName}\n`,
    ),
    environment: atomicWriteExclusive(
      absolute,
      "staging-baseline-0104-environment.json",
      `${JSON.stringify(result.environment, null, 2)}\n`,
    ),
  });
}

function main() {
  const candidateManifest = regularFile(
    requiredArgument("--candidate-manifest"),
    "candidate manifest",
  );
  const candidateChecksum = regularFile(
    requiredArgument("--candidate-checksum"),
    "candidate checksum",
  );
  const provisioning = regularFile(
    requiredArgument("--provisioning"),
    "provisioning manifest",
  );
  const predecessorManifest = regularFile(
    requiredArgument("--predecessor-manifest"),
    "predecessor manifest",
  );
  const predecessorChecksum = regularFile(
    requiredArgument("--predecessor-checksum"),
    "predecessor checksum",
  );
  const result = createStagingBaseline0104Binding({
    candidateManifestBytes: fs.readFileSync(candidateManifest),
    candidateChecksumText: fs.readFileSync(candidateChecksum, "utf8"),
    provisioningManifest: JSON.parse(fs.readFileSync(provisioning, "utf8")),
    expectedCandidateManifestSha256: requiredArgument(
      "--expected-candidate-manifest-sha256",
    ),
    expectedCandidateSourceSha: requiredArgument("--expected-candidate-source-sha"),
    expectedCandidateCallerWorkflowRef: requiredArgument(
      "--expected-candidate-caller-workflow-ref",
    ),
    expectedCandidateRunId: requiredArgument("--expected-candidate-run-id"),
    expectedCandidateRunAttempt: requiredArgument(
      "--expected-candidate-run-attempt",
    ),
    predecessorManifestBytes: fs.readFileSync(predecessorManifest),
    predecessorChecksumText: fs.readFileSync(predecessorChecksum, "utf8"),
    expectedPredecessorManifestSha256: requiredArgument(
      "--expected-predecessor-manifest-sha256",
    ),
    expectedPredecessorCallerWorkflowRef: requiredArgument(
      "--expected-predecessor-caller-workflow-ref",
    ),
    expectedPredecessorRunId: requiredArgument("--expected-predecessor-run-id"),
    expectedPredecessorRunAttempt: requiredArgument(
      "--expected-predecessor-run-attempt",
    ),
    backupEvidenceId: Number(requiredArgument("--backup-evidence-id")),
    backupRestoreMaxAgeHours: Number(
      requiredArgument("--backup-restore-max-age-hours"),
    ),
  });
  const files = writeStagingBaseline0104Binding(
    requiredArgument("--output-dir"),
    result,
  );
  process.stdout.write(
    `${JSON.stringify({ decision: result.decision, inputsSha256: result.inputsSha256, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

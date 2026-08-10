import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateStagingProvisioning,
  canonicalJson,
} from "./check-staging-provisioning.mjs";
import { validateStagingImageManifest } from "./verify-staging-image-manifest.mjs";

export class StagingDeploymentBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingDeploymentBindingError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new StagingDeploymentBindingError(code, message);
}

export function buildStagingDeploymentInputs({
  images,
  imageManifestSha256,
  provisioning,
  schemaAction,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  if (!["inspect", "apply-0105", "steady-0105"].includes(schemaAction)) {
    fail(
      "DEPLOYMENT_BINDING_SCHEMA_ACTION",
      "schemaAction must be inspect, apply-0105 or steady-0105.",
    );
  }
  const input = {
    schemaVersion: 1,
    sourceSha: provisioning.sourceSha,
    imageManifestSha256,
    provisioningManifestSha256: provisioning.manifestSha256,
    environmentId: provisioning.environmentId,
    composeProjectName: provisioning.composeProjectName,
    publicAppUrl: provisioning.publicAppUrl,
    nginxServerName: new URL(provisioning.publicAppUrl).hostname,
    operationalAlertReceiverUrl: provisioning.alertReceiverUrl,
    operationalAlertReceiverHost: provisioning.alertReceiverHost,
    s3Endpoint: provisioning.s3.endpoint,
    s3Region: provisioning.s3.region,
    s3Bucket: provisioning.s3.bucket,
    s3ForcePathStyle: provisioning.s3.forcePathStyle,
    externalAccountsEnabled: false,
    schemaAction,
    images: {
      preflight: images.preflight,
      mailpit: images.mailpit,
      api: images.api,
      web: images.web,
      alertReceiver: images.alertReceiver,
    },
  };
  if (schemaAction !== "steady-0105") {
    if (!Number.isInteger(backupEvidenceId) || backupEvidenceId <= 0) {
      fail(
        "DEPLOYMENT_BINDING_BACKUP_INVALID",
        "Transition requires a positive backup evidence id.",
      );
    }
    if (
      !Number.isInteger(backupRestoreMaxAgeHours) ||
      backupRestoreMaxAgeHours < 1 ||
      backupRestoreMaxAgeHours > 168
    ) {
      fail(
        "DEPLOYMENT_BINDING_BACKUP_INVALID",
        "Transition backup maximum age must be 1 through 168 hours.",
      );
    }
    input.backupEvidenceId = backupEvidenceId;
    input.backupRestoreMaxAgeHours = backupRestoreMaxAgeHours;
  }
  return Object.freeze(input);
}

export function deploymentInputsSha256(inputs) {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(inputs))
    .digest("hex");
}

export function createStagingDeploymentBinding({
  manifestBytes,
  checksumText,
  provisioningManifest,
  expectedManifestSha256,
  expectedSourceSha,
  expectedCallerWorkflowRef,
  expectedCallerWorkflowSha,
  expectedRunId,
  expectedRunAttempt,
  backupEvidenceId,
  backupRestoreMaxAgeHours,
}) {
  const images = validateStagingImageManifest(manifestBytes, checksumText, {
    expectedManifestSha256,
    expectedSourceSha,
    expectedCallerWorkflowRef,
    expectedCallerWorkflowSha,
    expectedRunId,
    expectedRunAttempt,
  });
  if (!images.trusted) {
    fail(
      "DEPLOYMENT_BINDING_MANIFEST_UNTRUSTED",
      "A separately approved image manifest checksum is required.",
    );
  }
  const provisioning = validateStagingProvisioning(provisioningManifest, {
    expectedSourceSha: images.sourceSha,
  });
  if (!provisioning.authorizesDeployment) {
    fail(
      "DEPLOYMENT_BINDING_PROVISIONING_UNOBSERVED",
      "Observed Coolify provisioning is required.",
    );
  }
  const transition = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "apply-0105",
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const inspect = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "inspect",
    backupEvidenceId,
    backupRestoreMaxAgeHours,
  });
  const steady = buildStagingDeploymentInputs({
    images: images.images,
    imageManifestSha256: images.manifestSha256,
    provisioning,
    schemaAction: "steady-0105",
  });
  const commonEnvironment = {
    STAGING_IMAGE_MANIFEST_B64: images.manifestBase64,
    STAGING_IMAGE_MANIFEST_SHA256: images.manifestSha256,
    STAGING_PROVISIONING_MANIFEST_SHA256: provisioning.manifestSha256,
    STAGING_IMAGE_MANIFEST_SOURCE_SHA: images.sourceSha,
    STAGING_PREFLIGHT_IMAGE: images.images.preflight,
    STAGING_MAILPIT_IMAGE: images.images.mailpit,
    STAGING_API_IMAGE: images.images.api,
    STAGING_WEB_IMAGE: images.images.web,
    STAGING_ALERT_RECEIVER_IMAGE: images.images.alertReceiver,
  };
  return Object.freeze({
    decision: "PASS",
    sourceSha: images.sourceSha,
    imageManifestSha256: images.manifestSha256,
    provisioningManifestSha256: provisioning.manifestSha256,
    provisioningArtifact: Object.freeze(structuredClone(provisioningManifest)),
    inspect: Object.freeze({
      inputs: inspect,
      sha256: deploymentInputsSha256(inspect),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "inspect",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(inspect),
        STAGING_BACKUP_EVIDENCE_ID: String(backupEvidenceId),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(backupRestoreMaxAgeHours),
      }),
    }),
    transition: Object.freeze({
      inputs: transition,
      sha256: deploymentInputsSha256(transition),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "apply-0105",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(transition),
        STAGING_BACKUP_EVIDENCE_ID: String(backupEvidenceId),
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: String(backupRestoreMaxAgeHours),
      }),
    }),
    steady: Object.freeze({
      inputs: steady,
      sha256: deploymentInputsSha256(steady),
      environment: Object.freeze({
        ...commonEnvironment,
        STAGING_SCHEMA_ACTION: "steady-0105",
        STAGING_DEPLOYMENT_INPUTS_SHA256: deploymentInputsSha256(steady),
        STAGING_BACKUP_EVIDENCE_ID: "",
        STAGING_BACKUP_RESTORE_MAX_AGE_HOURS: "",
      }),
    }),
  });
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function atomicWriteExclusive(directory, name, content) {
  const target = path.join(directory, name);
  if (fs.existsSync(target)) {
    fail(
      "DEPLOYMENT_BINDING_OUTPUT_EXISTS",
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
    fs.writeFileSync(descriptor, content, "utf8");
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

export function writeBindingArtifacts(directory, result) {
  const absolute = path.resolve(directory);
  fs.mkdirSync(absolute, { recursive: true });
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(
      "DEPLOYMENT_BINDING_OUTPUT_INVALID",
      "Output directory must be a nonsymlink directory.",
    );
  }
  return Object.freeze({
    provisioning: atomicWriteExclusive(
      absolute,
      "staging-provisioning-observed.json",
      canonicalJson(result.provisioningArtifact),
    ),
    inspectInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-inspect.json",
      canonicalJson(result.inspect.inputs),
    ),
    transitionInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-transition.json",
      canonicalJson(result.transition.inputs),
    ),
    steadyInputs: atomicWriteExclusive(
      absolute,
      "staging-deployment-steady.json",
      canonicalJson(result.steady.inputs),
    ),
    environment: atomicWriteExclusive(
      absolute,
      "staging-deployment-environment.json",
      `${JSON.stringify(
        {
          inspect: result.inspect.environment,
          transition: result.transition.environment,
          steady: result.steady.environment,
        },
        null,
        2,
      )}\n`,
    ),
  });
}

function main() {
  const manifestPath = argument("--manifest");
  const checksumPath = argument("--checksum");
  const provisioningPath = argument("--provisioning");
  const expectedManifestSha256 = argument("--expected-manifest-sha256");
  const expectedSourceSha = argument("--expected-source-sha");
  const expectedCallerWorkflowRef = argument("--expected-caller-workflow-ref");
  const expectedCallerWorkflowSha = argument("--expected-caller-workflow-sha");
  if (
    !manifestPath ||
    !checksumPath ||
    !provisioningPath ||
    !expectedManifestSha256 ||
    !expectedSourceSha ||
    !expectedCallerWorkflowRef ||
    !expectedCallerWorkflowSha
  ) {
    fail(
      "DEPLOYMENT_BINDING_INPUT_MISSING",
      "Pass manifest, checksum, provisioning, approved manifest checksum, source SHA, caller workflow ref and caller workflow SHA.",
    );
  }
  const result = createStagingDeploymentBinding({
    manifestBytes: fs.readFileSync(path.resolve(manifestPath)),
    checksumText: fs.readFileSync(path.resolve(checksumPath), "utf8"),
    provisioningManifest: JSON.parse(
      fs.readFileSync(path.resolve(provisioningPath), "utf8"),
    ),
    expectedManifestSha256,
    expectedSourceSha,
    expectedCallerWorkflowRef,
    expectedCallerWorkflowSha,
    expectedRunId: argument("--expected-run-id"),
    expectedRunAttempt: argument("--expected-run-attempt"),
    backupEvidenceId: Number(argument("--backup-evidence-id")),
    backupRestoreMaxAgeHours: Number(
      argument("--backup-restore-max-age-hours"),
    ),
  });
  const outputDirectory = argument("--output-dir");
  const output = outputDirectory
    ? {
        decision: result.decision,
        sourceSha: result.sourceSha,
        imageManifestSha256: result.imageManifestSha256,
        provisioningManifestSha256: result.provisioningManifestSha256,
        inspectSha256: result.inspect.sha256,
        transitionSha256: result.transition.sha256,
        steadySha256: result.steady.sha256,
        files: writeBindingArtifacts(outputDirectory, result),
      }
    : result;
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

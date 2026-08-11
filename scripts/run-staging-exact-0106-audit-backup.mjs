import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  STAGING_POSTGRES_INSPECT_FORMAT,
  validateResolvedStagingComposeTarget,
  validateRunningStagingPostgresContainer,
  validateStagingDeploymentInputs,
} from "./check-staging-deployment-binding.mjs";
import {
  canonicalJson,
  sha256Canonical,
} from "./check-staging-provisioning.mjs";
import { validateExact0106BackupGate } from "./check-staging-audit-0107-binding.mjs";
import {
  argument,
  AUDIT_0107,
  AUDIT_0107_FILES,
  audit0107Fail,
  canonicalOpaqueLegacyRows,
  canonicalTimestamp,
  parseOpaqueLegacyRowsJson,
  prepareExclusiveOutput,
  readRegularFile,
  requiredArgument,
  trustedCanonicalArtifact,
  writeCanonicalPair,
} from "./staging-audit-0107-contract.mjs";

export class StagingExact0106AuditBackupRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "StagingExact0106AuditBackupRunnerError";
    this.code = code;
  }
}

function wrap(error) {
  if (error instanceof StagingExact0106AuditBackupRunnerError) throw error;
  const code =
    typeof error?.code === "string"
      ? error.code
      : "EXACT_0106_AUDIT_BACKUP_INVALID";
  throw new StagingExact0106AuditBackupRunnerError(
    code,
    error instanceof Error ? error.message : String(error),
  );
}

function defaultExecute(command, args) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function checked(execute, args, label) {
  const result = execute("docker", args);
  if (result.error || result.status !== 0) {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_COMMAND_FAILED",
      `${label} failed without approved evidence.`,
    );
  }
  return result.stdout ?? "";
}

function parseInspect(bytes, checksumText, expectedSha256, expectedSourceSha) {
  const artifact = trustedCanonicalArtifact({
    bytes,
    checksumText,
    expectedSha256,
    name: "staging-deployment-inspect.json",
    label: "reviewed inspect deployment inputs",
  });
  try {
    return Object.freeze({
      inputs: validateStagingDeploymentInputs(artifact.value, {
        expectedSchemaAction: "inspect",
        expectedSourceSha,
      }),
      sha256: artifact.sha256,
    });
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_INSPECT_INVALID",
      "Inspect deployment inputs do not match the exact staging candidate.",
    );
  }
}

function resolveCompose(execute, composeArgs, inspect, lineage) {
  const stdout = checked(
    execute,
    [...composeArgs, "config", "--format", "json"],
    "resolved exact-0106 audit backup target inspection",
  );
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_COMPOSE_INVALID",
      "Resolved Compose target must be strict JSON.",
    );
  }
  try {
    const binding = validateResolvedStagingComposeTarget(
      value,
      inspect.inputs,
      {
        targetService: "exact-0106-audit-backup",
        deploymentInputsSha256: inspect.sha256,
        auditLineageMode: lineage.mode,
        auditOpaqueLegacyRowsJson: lineage.opaqueLegacyRowsJson,
      },
    );
    return Object.freeze({
      binding,
      resolvedComposeSha256: sha256Canonical(value),
    });
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_COMPOSE_MISMATCH",
      "Resolved backup target does not match the reviewed candidate and lineage.",
    );
  }
}

function assertOnlyPostgresRunning(
  execute,
  composeArgs,
  binding,
  phase,
  expectedContainerId,
) {
  const services = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--services"],
    phase,
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (services.length !== 1 || services[0] !== "postgres") {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_RUNTIME_NOT_QUIESCENT",
      "Postgres must be the isolated Compose project's only running service.",
    );
  }
  const ids = checked(
    execute,
    [...composeArgs, "ps", "--status", "running", "--quiet", "postgres"],
    `${phase} postgres container lookup`,
  )
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    ids.length !== 1 ||
    !/^[0-9a-f]{12,64}$/.test(ids[0]) ||
    (expectedContainerId &&
      !expectedContainerId.startsWith(ids[0]) &&
      !ids[0].startsWith(expectedContainerId))
  ) {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_POSTGRES_INVALID",
      "Exactly one unchanged staging postgres container is required.",
    );
  }
  const expectedId = expectedContainerId ?? ids[0];
  const projectionText = checked(
    execute,
    ["inspect", "--format", STAGING_POSTGRES_INSPECT_FORMAT, ids[0]],
    `${phase} live postgres inspection`,
  );
  let projection;
  try {
    projection = JSON.parse(projectionText);
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_POSTGRES_INVALID",
      "Live postgres projection must be strict JSON.",
    );
  }
  try {
    const target = validateRunningStagingPostgresContainer(
      projection,
      binding,
      {
        expectedContainerId: expectedId,
      },
    );
    return Object.freeze({
      ...target,
      projectionSha256: sha256Canonical(target),
    });
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_POSTGRES_MISMATCH",
      "Live postgres does not match the resolved isolated target.",
    );
  }
}

function runtimeBinding(resolved, postgres) {
  return Object.freeze({
    resolvedComposeSha256: `sha256:${resolved.resolvedComposeSha256}`,
    deploymentConfigSha256: `sha256:${sha256Canonical(resolved.binding)}`,
    livePostgresTarget: Object.freeze({
      containerId: postgres.containerId,
      image: postgres.image,
      imageId: postgres.imageId,
      volumeName: postgres.volumeName,
      networkName: postgres.networkName,
      networkId: postgres.networkId,
      projectionSha256: `sha256:${postgres.projectionSha256}`,
    }),
  });
}

function sameRuntimeBinding(left, right, phase) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_RUNTIME_BINDING_CHANGED",
      `Resolved Compose or live Postgres target changed during ${phase}.`,
    );
  }
}

function parseMarker(stdout) {
  const prefix = "[audit-schema-exact-0106-backup] PASS ";
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(prefix));
  if (lines.length !== 1) {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_MARKER_INVALID",
      "The one-shot must emit exactly one secret-free PASS marker.",
    );
  }
  try {
    return JSON.parse(lines[0].slice(prefix.length));
  } catch {
    audit0107Fail(
      "EXACT_0106_AUDIT_BACKUP_MARKER_INVALID",
      "Backup PASS marker must contain strict JSON.",
    );
  }
}

export function runStagingExact0106AuditBackup({
  composeFile = "docker-compose.staging.yml",
  envFile = ".env.staging",
  expectedSourceSha,
  confirmation,
  lineageMode,
  opaqueLegacyRowsJson,
  inspectDeploymentBytes,
  inspectDeploymentChecksumText,
  expectedInspectDeploymentSha256,
  execute = defaultExecute,
  now = () => new Date(),
}) {
  try {
    if (!/^[0-9a-f]{40}$/.test(expectedSourceSha ?? "")) {
      audit0107Fail(
        "EXACT_0106_AUDIT_BACKUP_SOURCE_INVALID",
        "The exact candidate source SHA is required.",
      );
    }
    if (confirmation !== AUDIT_0107.backupConfirmation) {
      audit0107Fail(
        "EXACT_0106_AUDIT_BACKUP_CONFIRMATION_INVALID",
        "The distinct exact-0106 audit backup confirmation is required.",
      );
    }
    const lineage = parseOpaqueLegacyRowsJson(
      opaqueLegacyRowsJson,
      lineageMode,
    );
    const inspect = parseInspect(
      inspectDeploymentBytes,
      inspectDeploymentChecksumText,
      expectedInspectDeploymentSha256,
      expectedSourceSha,
    );
    const composeArgs = [
      "compose",
      "--env-file",
      path.resolve(envFile),
      "-f",
      path.resolve(composeFile),
      "--profile",
      "exact-0106-audit-backup",
    ];
    const initialResolved = resolveCompose(
      execute,
      composeArgs,
      inspect,
      lineage,
    );
    const initialPostgres = assertOnlyPostgresRunning(
      execute,
      composeArgs,
      initialResolved.binding,
      "initial quiescence check",
    );
    const initialRuntimeBinding = runtimeBinding(
      initialResolved,
      initialPostgres,
    );
    const preStatefulResolved = resolveCompose(
      execute,
      composeArgs,
      inspect,
      lineage,
    );
    const preStatefulPostgres = assertOnlyPostgresRunning(
      execute,
      composeArgs,
      preStatefulResolved.binding,
      "pre-backup quiescence check",
      initialPostgres.containerId,
    );
    const preStatefulRuntimeBinding = runtimeBinding(
      preStatefulResolved,
      preStatefulPostgres,
    );
    sameRuntimeBinding(
      initialRuntimeBinding,
      preStatefulRuntimeBinding,
      "pre-backup revalidation",
    );
    const startedAt = now().toISOString();
    let stdout;
    let finalRuntimeBinding;
    try {
      stdout = checked(
        execute,
        [
          ...composeArgs,
          "run",
          "--rm",
          "--no-deps",
          "-e",
          `STAGING_EXACT_0106_BACKUP_ACTION=${AUDIT_0107.backupAction}`,
          "-e",
          `STAGING_EXACT_0106_BACKUP_CONFIRMATION=${AUDIT_0107.backupConfirmation}`,
          "-e",
          "STAGING_AUDIT_SCHEMA_ACTION=inspect",
          "-e",
          `AUDIT_SCHEMA_LINEAGE_MODE=${lineage.mode}`,
          "-e",
          `AUDIT_SCHEMA_OPAQUE_LEGACY_ROWS_JSON=${lineage.opaqueLegacyRowsJson}`,
          "exact-0106-audit-backup",
          "node",
          "dist/audit-schema-exact-0106-backup.mjs",
        ],
        "exact-0106 audit backup one-shot",
      );
    } finally {
      const finalResolved = resolveCompose(
        execute,
        composeArgs,
        inspect,
        lineage,
      );
      const finalPostgres = assertOnlyPostgresRunning(
        execute,
        composeArgs,
        finalResolved.binding,
        "final quiescence check",
        preStatefulPostgres.containerId,
      );
      finalRuntimeBinding = runtimeBinding(finalResolved, finalPostgres);
      sameRuntimeBinding(
        preStatefulRuntimeBinding,
        finalRuntimeBinding,
        "post-backup revalidation",
      );
    }
    const gate = validateExact0106BackupGate(
      parseMarker(stdout),
      expectedSourceSha,
      lineage,
    );
    const completedAt = now().toISOString();
    if (
      canonicalTimestamp(completedAt, "completedAt") <
      canonicalTimestamp(startedAt, "startedAt")
    ) {
      audit0107Fail(
        "EXACT_0106_AUDIT_BACKUP_TIME_INVALID",
        "completedAt must not precede startedAt.",
      );
    }
    return Object.freeze({
      schemaVersion: 1,
      kind: "site-logbook-staging-exact-0106-audit-backup-execution",
      decision: "PASS",
      productionTargetsTouched: false,
      startedAt,
      completedAt,
      sourceSha: expectedSourceSha,
      inspectDeploymentInputsSha256: `sha256:${inspect.sha256}`,
      runtimeBinding: finalRuntimeBinding,
      lineage: Object.freeze({
        mode: lineage.mode,
        opaqueLegacyRows: lineage.opaqueLegacyRows,
        opaqueLegacyRowsSha256: lineage.opaqueLegacyRowsSha256,
      }),
      gate,
      runtimeIsolation: Object.freeze({
        onlyPostgresRunningAtEveryBoundary: true,
        samePostgresContainerAtEveryBoundary: true,
        apiStarted: false,
        webStarted: false,
        auditSchema0107GateStarted: false,
      }),
      nextGate: "audit-0107-transition-binding-required",
      authorizes0107: false,
      authorizesApplicationStart: false,
    });
  } catch (error) {
    wrap(error);
  }
}

export function writeStagingExact0106AuditBackupEvidence(directory, evidence) {
  try {
    const absolute = prepareExclusiveOutput(directory, [
      AUDIT_0107_FILES.backup,
      AUDIT_0107_FILES.backupChecksum,
    ]);
    return writeCanonicalPair(
      absolute,
      AUDIT_0107_FILES.backup,
      AUDIT_0107_FILES.backupChecksum,
      evidence,
    );
  } catch (error) {
    wrap(error);
  }
}

function main() {
  const inspect = readRegularFile(
    requiredArgument("--inspect-inputs"),
    "inspect inputs",
  );
  const inspectChecksum = readRegularFile(
    requiredArgument("--inspect-inputs-checksum"),
    "inspect checksum",
  );
  const evidence = runStagingExact0106AuditBackup({
    composeFile: argument("--compose-file") ?? "docker-compose.staging.yml",
    envFile: argument("--env-file") ?? ".env.staging",
    expectedSourceSha: requiredArgument("--expected-source-sha"),
    confirmation: requiredArgument("--confirm"),
    lineageMode: requiredArgument("--lineage-mode"),
    opaqueLegacyRowsJson: requiredArgument("--opaque-legacy-rows-json"),
    inspectDeploymentBytes: fs.readFileSync(inspect),
    inspectDeploymentChecksumText: fs.readFileSync(inspectChecksum, "utf8"),
    expectedInspectDeploymentSha256: requiredArgument(
      "--expected-inspect-inputs-sha256",
    ),
  });
  const files = writeStagingExact0106AuditBackupEvidence(
    requiredArgument("--output-dir"),
    evidence,
  );
  process.stdout.write(
    `${JSON.stringify({ decision: evidence.decision, backupId: evidence.gate.backupId, files }, null, 2)}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    const failure =
      error instanceof StagingExact0106AuditBackupRunnerError
        ? { code: error.code, message: error.message }
        : {
            code: "UNEXPECTED_FAILURE",
            message: error instanceof Error ? error.message : String(error),
          };
    process.stderr.write(
      `[staging-exact-0106-audit-backup-runner] FAIL ${JSON.stringify(failure)}\n`,
    );
    process.exitCode = 1;
  }
}

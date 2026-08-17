#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION,
  PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
  PRODUCTION_EXACT_0096_STORAGE_BINDING,
  PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS,
  canonicalProductionExact0096BackupJson,
  productionExact0096BackupSha256,
  rejectProductionExact0096BackupSecrets,
  validateExact0096ProductionInventory,
  validateStoppedWritersProof,
} from "./production-exact-0096-backup-contract.mjs";
import {
  PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
  runProductionExact0096BackupWithLongLivedHostSession,
  syncProductionExact0096EvidenceDirectory,
} from "./production-exact-0096-backup-host-adapter.mjs";
import {
  createProductionExact0096BackupPlan,
  parseProductionExact0096BackupPlan,
} from "./production-exact-0096-backup-planner.mjs";
import { createProductionExact0096DisposableRestoreLifecycle } from "./production-exact-0096-disposable-restore-lifecycle.mjs";
import {
  loadProductionMigrationCatalog,
  parseProductionMigrationInventoryRows,
} from "./production-migration-adapter.mjs";

export const PRODUCTION_EXACT_0096_HOST_EXECUTION_CONFIRMATION =
  "RUN_EXACT_0096_PRODUCTION_BACKUP_AND_DISPOSABLE_RESTORE_NO_MIGRATION";
export const PRODUCTION_EXACT_0096_HOST_PREFLIGHT_CONFIRMATION =
  "READ_ONLY_EXACT_0096_PRODUCTION_BACKUP_PREFLIGHT_NO_CHANGES";
export const PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION =
  "PREPARE_EXACT_0096_PRODUCTION_BACKUP_PLAN_READ_ONLY_NO_BACKUP";

const execFile = promisify(execFileCallback);
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const IMMUTABLE_IMAGE =
  /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const REQUIRED_SECRET_ENV = Object.freeze([
  "BACKUP_ENCRYPTION_ACTIVE_KEY_ID",
  "BACKUP_ENCRYPTION_KEYRING",
  "DATABASE_URL",
  "S3_ACCESS_KEY_ID",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "S3_REGION",
  "S3_SECRET_ACCESS_KEY",
]);
const PRODUCER_ACTIVATION =
  "ACTIVATE_EXACT_0096_PRODUCER_SESSION_FIVE_OPERATIONS_NO_MIGRATION";
const PRODUCER_ENTRYPOINT =
  "/app/dist/production-exact-0096-backup-producer.mjs";
const WORKER_ENTRYPOINT =
  "/app/dist/production-exact-0096-backup-host-worker.mjs";
const CONTAINER_REQUEST_DIRECTORY = "/run/site-logbook-production-backup";
const CONTAINER_PROJECTION = [
  '{"Id":{{json .Id}},"Image":{{json .Image}},"Name":{{json .Name}},',
  '"Config":{"Image":{{json .Config.Image}},"User":{{json .Config.User}}},',
  '"State":{"Status":{{json .State.Status}}},',
  '"Mounts":{{json .Mounts}},"NetworkSettings":{"Networks":{{json .NetworkSettings.Networks}}},',
  '"HostConfig":{"Binds":{{json .HostConfig.Binds}},"PortBindings":{{json .HostConfig.PortBindings}}}}',
].join("");
const IMAGE_PROJECTION =
  '{"Id":{{json .Id}},"RepoDigests":{{json .RepoDigests}},"Labels":{{json .Config.Labels}}}';
const NETWORK_PROJECTION =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Internal":{{json .Internal}},"Containers":{{json .Containers}}}';
const VOLUME_PROJECTION =
  '{"Name":{{json .Name}},"CreatedAt":{{json .CreatedAt}},"Labels":{{json .Labels}}}';

class ProductionExact0096HostRunnerError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ProductionExact0096HostRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductionExact0096HostRunnerError(code, message);
}

function sameCanonical(left, right) {
  return (
    canonicalProductionExact0096BackupJson(left) ===
    canonicalProductionExact0096BackupJson(right)
  );
}

function exactConfig(value) {
  const keys = [
    "controlPlaneImageRef",
    "evidenceDirectory",
    "hostRequestDirectory",
    "migrationsDirectory",
    "overallTimeoutMs",
    "postgresImageRef",
    "schemaVersion",
    "secretEnvFile",
    "timeoutMs",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys.sort()) ||
    value.schemaVersion !==
      "site-logbook.production-exact-0096-host-runner/v1" ||
    !IMMUTABLE_IMAGE.test(value.controlPlaneImageRef) ||
    !IMMUTABLE_IMAGE.test(value.postgresImageRef) ||
    ![
      value.evidenceDirectory,
      value.hostRequestDirectory,
      value.migrationsDirectory,
      value.secretEnvFile,
    ].every(
      (path) =>
        typeof path === "string" && isAbsolute(path) && !/[\r\n,]/.test(path),
    ) ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < 10_000 ||
    value.timeoutMs > 15 * 60_000 ||
    !Number.isSafeInteger(value.overallTimeoutMs) ||
    value.overallTimeoutMs < 5 * 60_000 ||
    value.overallTimeoutMs > 30 * 60_000
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_CONFIG_INVALID",
      "Runner configuration is not exact.",
    );
  }
  rejectProductionExact0096BackupSecrets(
    { ...value, secretEnvFile: "mode-0600-secret-env-file" },
    "hostRunnerConfig",
  );
  return Object.freeze({ ...value });
}

function exactKeys(value, keys, field) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_PREPARE_INTENT_INVALID",
      `${field} is not exact.`,
    );
  }
  return value;
}

function exactPreparationIntent(value) {
  rejectProductionExact0096BackupSecrets(value, "prepareIntent");
  const intent = exactKeys(
    value,
    [
      "executor",
      "liveSource",
      "maintenanceWindowId",
      "operationId",
      "runtimeBinding",
      "schemaVersion",
    ],
    "prepareIntent",
  );
  const liveSource = exactKeys(
    intent.liveSource,
    ["imageRef", "sha"],
    "prepareIntent.liveSource",
  );
  const executor = exactKeys(
    intent.executor,
    ["buildSha", "imageRef"],
    "prepareIntent.executor",
  );
  const runtime = exactKeys(
    intent.runtimeBinding,
    [
      "applicationImageRef",
      "containerId",
      "deploymentConfigSha256",
      "networkId",
      "networkName",
      "postgresImageId",
      "postgresImageRef",
      "resolvedConfigSha256",
      "sourceSha",
      "volumeCreatedAt",
      "volumeLabelsSha256",
      "volumeName",
    ],
    "prepareIntent.runtimeBinding",
  );
  const created = new Date(runtime.volumeCreatedAt);
  if (
    intent.schemaVersion !==
      "site-logbook.production-exact-0096-plan-prepare-intent/v1" ||
    !BOUNDED_ID.test(intent.operationId) ||
    !BOUNDED_ID.test(intent.maintenanceWindowId) ||
    !GIT_SHA.test(liveSource.sha) ||
    !IMMUTABLE_IMAGE.test(liveSource.imageRef) ||
    !GIT_SHA.test(executor.buildSha) ||
    !IMMUTABLE_IMAGE.test(executor.imageRef) ||
    !GIT_SHA.test(runtime.sourceSha) ||
    !IMMUTABLE_IMAGE.test(runtime.applicationImageRef) ||
    !HEX64.test(runtime.containerId) ||
    !IMMUTABLE_IMAGE.test(runtime.postgresImageRef) ||
    !DIGEST.test(runtime.postgresImageId) ||
    !DOCKER_NAME.test(runtime.volumeName) ||
    !Number.isFinite(created.valueOf()) ||
    created.toISOString() !== runtime.volumeCreatedAt ||
    !DIGEST.test(runtime.volumeLabelsSha256) ||
    !DOCKER_NAME.test(runtime.networkName) ||
    !HEX64.test(runtime.networkId) ||
    !DIGEST.test(runtime.resolvedConfigSha256) ||
    !DIGEST.test(runtime.deploymentConfigSha256) ||
    liveSource.sha !== runtime.sourceSha ||
    liveSource.imageRef !== runtime.applicationImageRef
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_PREPARE_INTENT_INVALID",
      "Preparation intent identities are invalid or internally inconsistent.",
    );
  }
  return Object.freeze({
    ...intent,
    liveSource: Object.freeze({ ...liveSource }),
    executor: Object.freeze({ ...executor }),
    runtimeBinding: Object.freeze({ ...runtime }),
  });
}

export async function persistPreparedPlanExclusive(planOut, canonical) {
  if (!isAbsolute(planOut)) {
    fail(
      "PRODUCTION_BACKUP_HOST_PREPARE_OUTPUT_INVALID",
      "Prepared plan output path must be absolute.",
    );
  }
  const target = resolve(planOut);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const handle = await open(target, "wx", 0o600);
  try {
    await handle.writeFile(canonical);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const metadata = await lstat(target);
  const readback = await readFile(target, "utf8");
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) ||
    readback !== canonical
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_PREPARE_PERSISTENCE_FAILED",
      "Prepared plan did not survive exact no-clobber readback.",
    );
  }
  await syncProductionExact0096EvidenceDirectory(parent);
  return Object.freeze({
    path: target,
    sha256: productionExact0096BackupSha256(readback),
  });
}

async function readCanonicalFile(
  path,
  field,
  maximumBytes = PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES,
) {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 3 ||
    before.size > maximumBytes
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INPUT_INVALID",
      `${field} is not one bounded regular file.`,
    );
  }
  const raw = await readFile(absolute, "utf8");
  const after = await lstat(absolute);
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INPUT_CHANGED",
      `${field} changed while read.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INPUT_INVALID",
      `${field} is not JSON.`,
    );
  }
  if (canonicalProductionExact0096BackupJson(parsed) !== raw) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INPUT_INVALID",
      `${field} is not canonical JSON.`,
    );
  }
  rejectProductionExact0096BackupSecrets(parsed, field);
  return Object.freeze({ absolute, raw, value: parsed });
}

async function verifySecretEnvFile(path) {
  const metadata = await lstat(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size < 32 ||
    metadata.size > 64 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_SECRET_FILE_INVALID",
      "Secret env file must be one bounded mode-0600 regular file.",
    );
  }
  const raw = await readFile(path, "utf8");
  const names = [];
  const values = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const name = separator > 0 ? line.slice(0, separator) : "";
    if (
      !ENV_NAME.test(name) ||
      separator === line.length - 1 ||
      names.includes(name)
    ) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_SECRET_FILE_INVALID",
        "Secret env file names or values are invalid.",
      );
    }
    names.push(name);
    values.set(name, line.slice(separator + 1));
  }
  const allowed = [...REQUIRED_SECRET_ENV];
  if (
    REQUIRED_SECRET_ENV.some((name) => !names.includes(name)) ||
    names.some((name) => !allowed.includes(name)) ||
    values.get("S3_FORCE_PATH_STYLE") !== "false" ||
    values.get("S3_ENDPOINT") !==
      PRODUCTION_EXACT_0096_STORAGE_BINDING.endpoint ||
    values.get("S3_REGION") !== PRODUCTION_EXACT_0096_STORAGE_BINDING.region ||
    values.get("S3_BUCKET") !== PRODUCTION_EXACT_0096_STORAGE_BINDING.bucket
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_SECRET_FILE_INVALID",
      "Secret env file has missing or unreviewed variable names.",
    );
  }
  raw.fill?.(0);
  return Object.freeze(names.sort());
}

function exactCanonicalOutput(raw, field) {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw) < 3 ||
    Buffer.byteLength(raw) > PRODUCTION_EXACT_0096_MAX_ARTIFACT_BYTES
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_OUTPUT_INVALID",
      `${field} output is absent or oversized.`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_OUTPUT_INVALID",
      `${field} output is not JSON.`,
    );
  }
  if (canonicalProductionExact0096BackupJson(value) !== raw) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_OUTPUT_INVALID",
      `${field} output is not canonical.`,
    );
  }
  rejectProductionExact0096BackupSecrets(value, field);
  return Object.freeze(value);
}

async function docker(run, args, options) {
  try {
    const result = await run("docker", args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: options.timeoutMs,
      windowsHide: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const stdout =
      typeof result === "string" ? result : String(result.stdout ?? "");
    const stderr =
      typeof result === "string" ? "" : String(result.stderr ?? "");
    if (stderr !== "")
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_DOCKER_FAILED",
        "Docker emitted unexpected stderr.",
      );
    return stdout.trim();
  } catch (error) {
    if (error instanceof ProductionExact0096HostRunnerError) throw error;
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_DOCKER_FAILED",
      "A fixed-argv Docker operation failed.",
    );
  }
}

async function dockerJson(run, args, options, field) {
  const raw = await docker(run, args, options);
  try {
    return JSON.parse(raw);
  } catch {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_DOCKER_INVALID",
      `${field} projection is invalid.`,
    );
  }
}

function imageIdDigest(value) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_DOCKER_INVALID",
      "Docker image id is invalid.",
    );
  }
  return value;
}

async function inspectSourceBoundary(
  plan,
  allowedPeerIds,
  dependencies,
  signal,
) {
  const options = { timeoutMs: dependencies.timeoutMs, signal };
  const container = await dockerJson(
    dependencies.execFile,
    [
      "container",
      "inspect",
      "--format",
      CONTAINER_PROJECTION,
      plan.runtimeBinding.containerId,
    ],
    options,
    "source container",
  );
  const image = await dockerJson(
    dependencies.execFile,
    [
      "image",
      "inspect",
      "--format",
      IMAGE_PROJECTION,
      plan.runtimeBinding.postgresImageRef,
    ],
    options,
    "PostgreSQL image",
  );
  const volume = await dockerJson(
    dependencies.execFile,
    [
      "volume",
      "inspect",
      "--format",
      VOLUME_PROJECTION,
      plan.runtimeBinding.volumeName,
    ],
    options,
    "source volume",
  );
  const network = await dockerJson(
    dependencies.execFile,
    [
      "network",
      "inspect",
      "--format",
      NETWORK_PROJECTION,
      plan.runtimeBinding.networkName,
    ],
    options,
    "source network",
  );
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const networks = container.NetworkSettings?.Networks ?? {};
  const attached = networks[plan.runtimeBinding.networkName];
  const labelsDigest = productionExact0096BackupSha256(
    canonicalProductionExact0096BackupJson(volume.Labels ?? {}),
  );
  if (
    container.Id !== plan.runtimeBinding.containerId ||
    container.State?.Status !== "running" ||
    imageIdDigest(container.Image) !== plan.runtimeBinding.postgresImageId ||
    image.Id !== plan.runtimeBinding.postgresImageId ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(plan.runtimeBinding.postgresImageRef) ||
    !mounts.some(
      (mount) =>
        mount.Type === "volume" &&
        mount.Name === plan.runtimeBinding.volumeName,
    ) ||
    attached?.NetworkID !== plan.runtimeBinding.networkId ||
    network.Id !== plan.runtimeBinding.networkId ||
    network.Name !== plan.runtimeBinding.networkName ||
    volume.Name !== plan.runtimeBinding.volumeName ||
    new Date(volume.CreatedAt).toISOString() !==
      plan.runtimeBinding.volumeCreatedAt ||
    labelsDigest !== plan.runtimeBinding.volumeLabelsSha256
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_SOURCE_DRIFT",
      "Live source Docker identity differs from the plan.",
    );
  }
  const peerIds = Object.keys(network.Containers ?? {}).sort();
  const allowed = [plan.runtimeBinding.containerId, ...allowedPeerIds].sort();
  const writers = peerIds.filter((id) => !allowed.includes(id));
  return Object.freeze({ writers, peerIds });
}

async function inspectControlPlane(
  plan,
  config,
  containerId,
  expectedUser,
  dependencies,
  signal,
) {
  const options = { timeoutMs: config.timeoutMs, signal };
  const container = await dockerJson(
    dependencies.execFile,
    ["container", "inspect", "--format", CONTAINER_PROJECTION, containerId],
    options,
    "control-plane container",
  );
  const image = await dockerJson(
    dependencies.execFile,
    [
      "image",
      "inspect",
      "--format",
      IMAGE_PROJECTION,
      config.controlPlaneImageRef,
    ],
    options,
    "control-plane image",
  );
  const mounts = Array.isArray(container.Mounts) ? container.Mounts : [];
  const labels = image.Labels ?? {};
  if (
    container.Id !== containerId ||
    container.State?.Status !== "running" ||
    container.Config?.Image !== config.controlPlaneImageRef ||
    container.Config?.User !== expectedUser ||
    !Array.isArray(image.RepoDigests) ||
    !image.RepoDigests.includes(config.controlPlaneImageRef) ||
    labels["io.modvolt.site-logbook.image-profile"] !== "control-plane" ||
    labels["org.opencontainers.image.revision"] !== plan.executor.buildSha ||
    !mounts.some(
      (mount) =>
        mount.Type === "bind" &&
        resolve(mount.Source) === resolve(config.hostRequestDirectory) &&
        mount.Destination === CONTAINER_REQUEST_DIRECTORY &&
        mount.RW === false,
    ) ||
    mounts.some((mount) => mount.Destination === "/var/run/docker.sock") ||
    Object.keys(container.HostConfig?.PortBindings ?? {}).length !== 0
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_EXECUTOR_DRIFT",
      "Control-plane isolation or immutable identity differs.",
    );
  }
}

async function writeExclusiveRequest(
  directory,
  invocationId,
  sequence,
  request,
) {
  rejectProductionExact0096BackupSecrets(request, "hostWorkerRequest");
  const canonical = canonicalProductionExact0096BackupJson(request);
  const name = `${invocationId}-${String(sequence).padStart(2, "0")}.json`;
  const hostPath = join(directory, name);
  const handle = await open(hostPath, "wx", 0o600);
  try {
    await handle.writeFile(canonical);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return Object.freeze({
    hostPath,
    containerPath: `${CONTAINER_REQUEST_DIRECTORY}/${name}`,
  });
}

function parseWorkerDatabase(value) {
  if (
    !value ||
    typeof value !== "object" ||
    !value.database ||
    !Array.isArray(value.journalRows) ||
    typeof value.observedAt !== "string"
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_OBSERVATION_INVALID",
      "Database observation is invalid.",
    );
  }
  return value;
}

export async function runProductionExact0096HostPreparation(
  { intent: rawIntent, config, planOut, confirmation, signal },
  dependencies = {},
) {
  if (
    confirmation !== PRODUCTION_EXACT_0096_HOST_PREPARE_CONFIRMATION ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_DARK",
      "Exact read-only plan-preparation confirmation and a live AbortSignal are required.",
    );
  }
  const intent = exactPreparationIntent(rawIntent);
  const exact = exactConfig(config);
  const run = dependencies.execFile ?? execFile;
  if (
    exact.controlPlaneImageRef !== intent.executor.imageRef ||
    exact.postgresImageRef !== intent.runtimeBinding.postgresImageRef
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_IMAGE_DRIFT",
      "Preparation images differ from the reviewed intent.",
    );
  }
  await stat(exact.migrationsDirectory);
  await verifySecretEnvFile(exact.secretEnvFile);
  const invocationId =
    dependencies.invocationId?.() ?? randomBytes(32).toString("hex");
  const proofId = dependencies.proofId?.() ?? randomBytes(32).toString("hex");
  if (
    !HEX64.test(invocationId) ||
    /^0{64}$/.test(invocationId) ||
    !HEX64.test(proofId) ||
    /^0{64}$/.test(proofId)
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INVOCATION_INVALID",
      "Preparation invocation or proof id is invalid.",
    );
  }
  const hostIdentity = dependencies.hostIdentity?.() ?? {
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
  if (
    !Number.isSafeInteger(hostIdentity.uid) ||
    hostIdentity.uid < 1 ||
    !Number.isSafeInteger(hostIdentity.gid) ||
    hostIdentity.gid < 1
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_IDENTITY_INVALID",
      "Prepare must run as one dedicated non-root host identity.",
    );
  }
  const executorImage = await dockerJson(
    run,
    [
      "image",
      "inspect",
      "--format",
      IMAGE_PROJECTION,
      exact.controlPlaneImageRef,
    ],
    { timeoutMs: exact.timeoutMs, signal },
    "control-plane image",
  );
  if (
    !Array.isArray(executorImage.RepoDigests) ||
    !executorImage.RepoDigests.includes(exact.controlPlaneImageRef) ||
    executorImage.Labels?.["io.modvolt.site-logbook.image-profile"] !==
      "control-plane" ||
    executorImage.Labels?.["org.opencontainers.image.revision"] !==
      intent.executor.buildSha
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_EXECUTOR_DRIFT",
      "Control-plane image is not the reviewed preparation build.",
    );
  }
  const before = await inspectSourceBoundary(
    intent,
    [],
    { execFile: run, timeoutMs: exact.timeoutMs },
    signal,
  );
  if (before.writers.length !== 0) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
      "Production writer containers remain attached.",
    );
  }
  await mkdir(exact.hostRequestDirectory, { recursive: true, mode: 0o700 });
  const controlPlaneUser = `${hostIdentity.uid}:${hostIdentity.gid}`;
  const containerName = `slb-exact0096-prepare-${invocationId.slice(0, 12)}`;
  const dockerOptions = { timeoutMs: exact.timeoutMs, signal };
  let controlPlaneContainerId;
  let workerSequence = 0;
  let plan;
  try {
    controlPlaneContainerId = await docker(
      run,
      [
        "container",
        "create",
        "--name",
        containerName,
        "--network",
        intent.runtimeBinding.networkName,
        "--user",
        controlPlaneUser,
        "--mount",
        `type=bind,source=${exact.hostRequestDirectory},target=${CONTAINER_REQUEST_DIRECTORY},readonly`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        "128",
        "--memory",
        "384m",
        "--cpus",
        "0.5",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=64m",
        "--env-file",
        exact.secretEnvFile,
        exact.controlPlaneImageRef,
        "node",
        "-e",
        "setInterval(()=>{},2147483647)",
      ],
      dockerOptions,
    );
    if (!HEX64.test(controlPlaneContainerId)) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_EXECUTOR_INVALID",
        "Docker did not create one exact preparation container.",
      );
    }
    await docker(
      run,
      ["container", "start", controlPlaneContainerId],
      dockerOptions,
    );
    await inspectControlPlane(
      intent,
      exact,
      controlPlaneContainerId,
      controlPlaneUser,
      { execFile: run },
      signal,
    );
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory: exact.migrationsDirectory,
    });
    const invokeWorker = async (request) => {
      workerSequence += 1;
      const file = await writeExclusiveRequest(
        exact.hostRequestDirectory,
        invocationId,
        workerSequence,
        request,
      );
      try {
        const output = await docker(
          run,
          [
            "container",
            "exec",
            controlPlaneContainerId,
            "node",
            WORKER_ENTRYPOINT,
            "--request-file",
            file.containerPath,
          ],
          dockerOptions,
        );
        return exactCanonicalOutput(
          `${output}\n`,
          `prepareWorker.${request.operation}`,
        );
      } finally {
        await rm(file.hostPath, { force: true });
      }
    };
    const observed = parseWorkerDatabase(
      await invokeWorker({ operation: "observe-source" }),
    );
    const inventory = parseProductionMigrationInventoryRows(
      observed.journalRows,
      catalog,
    );
    validateExact0096ProductionInventory(inventory, "prepare.inventory");
    if (
      typeof observed.schemaFingerprintSha256 !== "string" ||
      !DIGEST.test(observed.schemaFingerprintSha256)
    ) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_OBSERVATION_INVALID",
        "Preparation schema fingerprint observation is invalid.",
      );
    }
    const source = await inspectSourceBoundary(
      intent,
      [controlPlaneContainerId],
      { execFile: run, timeoutMs: exact.timeoutMs },
      signal,
    );
    if (source.writers.length !== 0) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
        "A production writer container appeared during preparation.",
      );
    }
    const window = await invokeWorker({
      operation: "writer-window",
      gracePeriodMs: 60_000,
    });
    if (
      window.activeApplicationSessions !== 0 ||
      window.activeWriteTransactions !== 0 ||
      window.databaseWritesObserved !== 0 ||
      Date.parse(window.quiescentSince) < Date.parse(observed.observedAt) ||
      Date.parse(window.observedAt) - Date.parse(observed.observedAt) >
        PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS
    ) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
        "Preparation did not observe one bounded writer-free window after source observation.",
      );
    }
    const runtimeBindingSha256 = productionExact0096BackupSha256(
      canonicalProductionExact0096BackupJson(intent.runtimeBinding),
    );
    const stoppedWritersProof = {
      schemaVersion: "site-logbook.production-stopped-writers-proof/v2",
      mode: "production-maintenance-stopped-writers",
      proofId,
      maintenanceWindowId: intent.maintenanceWindowId,
      sourceSha: intent.liveSource.sha,
      runtimeBindingSha256,
      databaseIdentitySha256: productionExact0096BackupSha256(
        canonicalProductionExact0096BackupJson(observed.database),
      ),
      quiescentSince: window.quiescentSince,
      observedAt: window.observedAt,
      gracePeriodMs: window.gracePeriodMs,
      runningWriterContainerIds: [],
      activeApplicationSessions: window.activeApplicationSessions,
      activeWriteTransactions: window.activeWriteTransactions,
      databaseWritesObserved: window.databaseWritesObserved,
    };
    validateStoppedWritersProof(
      stoppedWritersProof,
      "prepare.stoppedWritersProof",
    );
    const createdAt = (dependencies.now?.() ?? new Date()).toISOString();
    plan = createProductionExact0096BackupPlan({
      operationId: intent.operationId,
      createdAt,
      liveSource: intent.liveSource,
      executor: intent.executor,
      sourceDatabase: observed.database,
      runtimeBinding: intent.runtimeBinding,
      stoppedWritersProof,
      baselineInventory: inventory,
      schemaFingerprintSha256: observed.schemaFingerprintSha256,
      confirmation: PRODUCTION_EXACT_0096_BACKUP_CONFIRMATION,
    });
  } finally {
    const cleanupErrors = [];
    if (controlPlaneContainerId) {
      await docker(
        run,
        ["container", "rm", "--force", controlPlaneContainerId],
        { timeoutMs: exact.timeoutMs },
      ).catch((error) => cleanupErrors.push(error));
    }
    await rm(exact.hostRequestDirectory, { recursive: false }).catch(
      () => undefined,
    );
    if (cleanupErrors.length > 0) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_CLEANUP_FAILED",
        "Preparation control-plane cleanup failed.",
      );
    }
  }
  if (!plan) {
    fail(
      "PRODUCTION_BACKUP_HOST_PREPARE_FAILED",
      "Preparation did not create a plan.",
    );
  }
  const persisted = await persistPreparedPlanExclusive(planOut, plan.canonical);
  return Object.freeze({ plan, persisted, productionTargetsTouched: false });
}

export async function runProductionExact0096HostPreflight(
  { planCanonical, config },
  dependencies = {},
) {
  const plan = parseProductionExact0096BackupPlan(planCanonical).value;
  const exact = exactConfig(config);
  const run = dependencies.execFile ?? execFile;
  await stat(exact.migrationsDirectory);
  await verifySecretEnvFile(exact.secretEnvFile);
  if (
    exact.controlPlaneImageRef !== plan.executor.imageRef ||
    exact.postgresImageRef !== plan.runtimeBinding.postgresImageRef
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_IMAGE_DRIFT",
      "Runner images differ from the plan.",
    );
  }
  const executorImage = await dockerJson(
    run,
    [
      "image",
      "inspect",
      "--format",
      IMAGE_PROJECTION,
      exact.controlPlaneImageRef,
    ],
    { timeoutMs: exact.timeoutMs },
    "control-plane image",
  );
  if (
    !Array.isArray(executorImage.RepoDigests) ||
    !executorImage.RepoDigests.includes(exact.controlPlaneImageRef) ||
    executorImage.Labels?.["io.modvolt.site-logbook.image-profile"] !==
      "control-plane" ||
    executorImage.Labels?.["org.opencontainers.image.revision"] !==
      plan.executor.buildSha
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_EXECUTOR_DRIFT",
      "Control-plane image is not the reviewed build.",
    );
  }
  const source = await inspectSourceBoundary(
    plan,
    [],
    { execFile: run, timeoutMs: exact.timeoutMs },
    undefined,
  );
  return Object.freeze({
    mode: "read-only-preflight",
    ready: source.writers.length === 0,
    runningWriterContainerIds: source.writers,
    productionTargetsTouched: false,
  });
}

export async function runProductionExact0096HostExecution(
  { planCanonical, config, confirmation, signal },
  dependencies = {},
) {
  if (
    confirmation !== PRODUCTION_EXACT_0096_HOST_EXECUTION_CONFIRMATION ||
    !(signal instanceof AbortSignal) ||
    signal.aborted
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_DARK",
      "Exact confirmation and a live AbortSignal are required.",
    );
  }
  const plan = parseProductionExact0096BackupPlan(planCanonical).value;
  const exact = exactConfig(config);
  const run = dependencies.execFile ?? execFile;
  const runComposite =
    dependencies.runComposite ??
    runProductionExact0096BackupWithLongLivedHostSession;
  const lifecycleFactory =
    dependencies.lifecycleFactory ??
    createProductionExact0096DisposableRestoreLifecycle;
  const invocationId =
    dependencies.invocationId?.() ?? randomBytes(32).toString("hex");
  if (!HEX64.test(invocationId) || /^0{64}$/.test(invocationId)) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_INVOCATION_INVALID",
      "Invocation id is invalid.",
    );
  }
  const hostIdentity = dependencies.hostIdentity?.() ?? {
    uid: process.getuid?.() ?? 1000,
    gid: process.getgid?.() ?? 1000,
  };
  if (
    !Number.isSafeInteger(hostIdentity.uid) ||
    hostIdentity.uid < 1 ||
    !Number.isSafeInteger(hostIdentity.gid) ||
    hostIdentity.gid < 1
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_IDENTITY_INVALID",
      "Execute must run as one dedicated non-root host identity so mode-0600 requests remain readable only by the control plane.",
    );
  }
  const controlPlaneUser = `${hostIdentity.uid}:${hostIdentity.gid}`;
  await verifySecretEnvFile(exact.secretEnvFile);
  const preflight = await runProductionExact0096HostPreflight(
    { planCanonical, config: exact },
    { execFile: run },
  );
  if (!preflight.ready) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
      "Production writer containers remain attached.",
    );
  }
  await mkdir(exact.hostRequestDirectory, { recursive: true, mode: 0o700 });
  const containerName = `slb-exact0096-${invocationId.slice(0, 16)}-control`;
  let controlPlaneContainerId;
  let restoreLifecycle;
  let restoreNetworkConnected = false;
  let workerSequence = 0;
  const restoreState = {};
  const dockerOptions = { timeoutMs: exact.timeoutMs, signal };
  const lifecycleExecFile = async (command, args, options) => {
    try {
      const result = await run(command, args, options);
      return {
        code: 0,
        stdout:
          typeof result === "string" ? result : String(result.stdout ?? ""),
        stderr: typeof result === "string" ? "" : String(result.stderr ?? ""),
      };
    } catch (error) {
      return { code: Number(error?.code ?? 1), stdout: "", stderr: "failed" };
    }
  };
  try {
    controlPlaneContainerId = await docker(
      run,
      [
        "container",
        "create",
        "--name",
        containerName,
        "--network",
        plan.runtimeBinding.networkName,
        "--user",
        controlPlaneUser,
        "--mount",
        `type=bind,source=${exact.hostRequestDirectory},target=${CONTAINER_REQUEST_DIRECTORY},readonly`,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        "256",
        "--memory",
        "768m",
        "--cpus",
        "1",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=320m",
        "--env-file",
        exact.secretEnvFile,
        "--env",
        `PRODUCTION_EXACT_0096_PRODUCER_ACTIVATION=${PRODUCER_ACTIVATION}`,
        exact.controlPlaneImageRef,
        "node",
        "-e",
        "setInterval(()=>{},2147483647)",
      ],
      dockerOptions,
    );
    if (!HEX64.test(controlPlaneContainerId)) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_EXECUTOR_INVALID",
        "Docker did not create one exact control-plane container.",
      );
    }
    await docker(
      run,
      ["container", "start", controlPlaneContainerId],
      dockerOptions,
    );
    await inspectControlPlane(
      plan,
      exact,
      controlPlaneContainerId,
      controlPlaneUser,
      { execFile: run },
      signal,
    );
    const catalog = await loadProductionMigrationCatalog({
      migrationsDirectory: exact.migrationsDirectory,
    });
    const invokeWorker = async (request, internalSignal) => {
      workerSequence += 1;
      const file = await writeExclusiveRequest(
        exact.hostRequestDirectory,
        invocationId,
        workerSequence,
        request,
      );
      try {
        const output = await docker(
          run,
          [
            "container",
            "exec",
            controlPlaneContainerId,
            "node",
            WORKER_ENTRYPOINT,
            "--request-file",
            file.containerPath,
          ],
          { timeoutMs: exact.timeoutMs, signal: internalSignal },
        );
        return exactCanonicalOutput(
          `${output}\n`,
          `worker.${request.operation}`,
        );
      } finally {
        await rm(file.hostPath, { force: true });
      }
    };
    const requireNoWriters = async (internalSignal) => {
      const source = await inspectSourceBoundary(
        plan,
        [controlPlaneContainerId],
        { execFile: run, timeoutMs: exact.timeoutMs },
        internalSignal,
      );
      if (source.writers.length !== 0) {
        fail(
          "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
          "A production writer container is running.",
        );
      }
      const window = await invokeWorker(
        { operation: "writer-window", gracePeriodMs: 60_000 },
        internalSignal,
      );
      if (
        window.activeApplicationSessions !== 0 ||
        window.activeWriteTransactions !== 0 ||
        window.databaseWritesObserved !== 0
      ) {
        fail(
          "PRODUCTION_BACKUP_HOST_RUNNER_WRITERS_RUNNING",
          "The database was not quiescent for the complete window.",
        );
      }
      return window;
    };
    const exactInventory = (rows) => {
      const inventory = parseProductionMigrationInventoryRows(rows, catalog);
      validateExact0096ProductionInventory(inventory, "host.inventory");
      return inventory;
    };
    let sourceBeforeObservedAt;
    const freshStoppedWritersProof = (window) => {
      const proof = {
        schemaVersion: "site-logbook.production-stopped-writers-proof/v2",
        mode: "production-maintenance-stopped-writers",
        proofId: dependencies.proofId?.() ?? randomBytes(32).toString("hex"),
        maintenanceWindowId: plan.stoppedWritersProof.maintenanceWindowId,
        sourceSha: plan.liveSource.sha,
        runtimeBindingSha256: plan.runtimeBindingSha256,
        databaseIdentitySha256: productionExact0096BackupSha256(
          canonicalProductionExact0096BackupJson(plan.sourceDatabase),
        ),
        quiescentSince: window.quiescentSince,
        observedAt: window.observedAt,
        gracePeriodMs: window.gracePeriodMs,
        runningWriterContainerIds: [],
        activeApplicationSessions: window.activeApplicationSessions,
        activeWriteTransactions: window.activeWriteTransactions,
        databaseWritesObserved: window.databaseWritesObserved,
      };
      validateStoppedWritersProof(proof, "host.stoppedWritersProof");
      return proof;
    };
    const exactObservedSchemaFingerprint = (observed, field) => {
      if (
        typeof observed.schemaFingerprintSha256 !== "string" ||
        !DIGEST.test(observed.schemaFingerprintSha256) ||
        observed.schemaFingerprintSha256 !== plan.schemaFingerprintSha256
      ) {
        fail(
          "PRODUCTION_BACKUP_HOST_RUNNER_SCHEMA_DRIFT",
          `${field} canonical audit schema fingerprint differs from the plan.`,
        );
      }
      return observed.schemaFingerprintSha256;
    };
    const hostHandlers = (internalSignal) => ({
      async observeExecutorIdentity({ planSha256 }) {
        if (planSha256 !== productionExact0096BackupSha256(planCanonical)) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_PLAN_DRIFT",
            "Plan digest differs.",
          );
        }
        await inspectControlPlane(
          plan,
          exact,
          controlPlaneContainerId,
          controlPlaneUser,
          { execFile: run },
          internalSignal,
        );
        return canonicalProductionExact0096BackupJson({
          schemaVersion: "site-logbook.production-backup-executor/v1",
          kind: "production-exact-0096-backup-executor",
          buildSha: plan.executor.buildSha,
          executorImageRef: plan.executor.imageRef,
          invocationId,
        });
      },
      async observeImmutableProductionSourceReadOnly() {
        await inspectSourceBoundary(
          plan,
          [controlPlaneContainerId],
          { execFile: run, timeoutMs: exact.timeoutMs },
          internalSignal,
        );
        const observed = parseWorkerDatabase(
          await invokeWorker({ operation: "observe-source" }, internalSignal),
        );
        const inventory = exactInventory(observed.journalRows);
        if (!sameCanonical(observed.database, plan.sourceDatabase)) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_SOURCE_DRIFT",
            "Live database identity differs.",
          );
        }
        const schemaFingerprintSha256 = exactObservedSchemaFingerprint(
          observed,
          "Live source",
        );
        sourceBeforeObservedAt = observed.observedAt;
        return canonicalProductionExact0096BackupJson({
          observedAt: observed.observedAt,
          database: observed.database,
          inventory,
          runtimeBinding: plan.runtimeBinding,
          schemaFingerprintSha256,
        });
      },
      async proveProductionWritersStopped(request) {
        if (
          request.boundary !== "before" ||
          request.maintenanceWindowId !==
            plan.stoppedWritersProof.maintenanceWindowId ||
          request.sourceSha !== plan.liveSource.sha ||
          request.runtimeBindingSha256 !== plan.runtimeBindingSha256
        ) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_WRITER_PROOF_INVALID",
            "Writer-proof request differs from the plan.",
          );
        }
        if (!sourceBeforeObservedAt) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_WRITER_PROOF_INVALID",
            "Writer proof cannot precede the live source observation.",
          );
        }
        const live = await requireNoWriters(internalSignal);
        const proof = freshStoppedWritersProof(live);
        if (
          Date.parse(proof.quiescentSince) <
            Date.parse(sourceBeforeObservedAt) ||
          Date.parse(proof.observedAt) - Date.parse(sourceBeforeObservedAt) >
            PRODUCTION_EXACT_0096_WRITERS_PROOF_MAX_AGE_MS ||
          proof.proofId === plan.stoppedWritersProof.proofId
        ) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_WRITER_PROOF_STALE",
            "Fresh writer proof is not temporally bound to the live source observation.",
          );
        }
        return canonicalProductionExact0096BackupJson(proof);
      },
      async restoreIntoNewDisposablePostgres16(request) {
        if (restoreLifecycle) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_RESTORE_STATE_INVALID",
            "Disposable restore already exists.",
          );
        }
        const object = exactCanonicalOutput(
          request.backupObjectCanonical,
          "restore.backupObject",
        );
        restoreLifecycle = await lifecycleFactory(
          {
            activated: true,
            executorContainerId: controlPlaneContainerId,
            executorImageRef: exact.controlPlaneImageRef,
            invocationId,
            postgresImageRef: exact.postgresImageRef,
            sourceContainerId: plan.runtimeBinding.containerId,
            sourceNetworkId: plan.runtimeBinding.networkId,
            sourceVolumeName: plan.runtimeBinding.volumeName,
            timeoutMs: exact.timeoutMs,
          },
          { execFile: lifecycleExecFile, spawn },
        );
        await docker(
          run,
          [
            "network",
            "connect",
            restoreLifecycle.runtimeBinding.networkName,
            controlPlaneContainerId,
          ],
          { timeoutMs: exact.timeoutMs, signal: internalSignal },
        );
        restoreNetworkConnected = true;
        const suffix = ".dump.mve1";
        const basename = String(object.key).split("/").at(-1) ?? "";
        const dumpId = basename.endsWith(suffix)
          ? basename.slice(0, -suffix.length)
          : "";
        const worker = await invokeWorker(
          {
            operation: "restore-object",
            backupObject: object,
            dumpId,
            encryptedPayloadSha256: request.encryptedPayloadSha256,
            sourceDumpSha256: request.sourceDumpSha256,
            plaintextCeilingBytes: plan.payloadCeilingBytes,
            restore: {
              host: `slb-exact0096-${invocationId.slice(0, 16)}-postgres`,
              database: restoreLifecycle.database.name,
              user: restoreLifecycle.database.user,
            },
          },
          internalSignal,
        );
        restoreState.object = object;
        restoreState.encryptedPayloadSha256 = request.encryptedPayloadSha256;
        restoreState.sourceDumpSha256 = request.sourceDumpSha256;
        restoreState.restoreWorker = worker;
        return canonicalProductionExact0096BackupJson({
          acceptedObjectVersionId: worker.acceptedObjectVersionId,
          restoreId: restoreLifecycle.restoreId,
        });
      },
      async observeRestoredJournalSchemaAndContentReadOnly({ restoreId }) {
        if (!restoreLifecycle || restoreId !== restoreLifecycle.restoreId) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_RESTORE_STATE_INVALID",
            "Restore observation is not bound.",
          );
        }
        const observed = parseWorkerDatabase(
          await invokeWorker(
            {
              operation: "observe-restore",
              restore: {
                host: `slb-exact0096-${invocationId.slice(0, 16)}-postgres`,
                database: restoreLifecycle.database.name,
                user: restoreLifecycle.database.user,
              },
            },
            internalSignal,
          ),
        );
        const inventory = exactInventory(observed.journalRows);
        const schemaFingerprintSha256 = exactObservedSchemaFingerprint(
          observed,
          "Disposable restore",
        );
        return canonicalProductionExact0096BackupJson({
          restoreId,
          environmentId: "site-logbook-production-backup-restore-drill",
          startedAt: restoreLifecycle.startedAt,
          completedAt: observed.observedAt,
          database: restoreLifecycle.database,
          runtimeBinding: restoreLifecycle.runtimeBinding,
          newDisposableDatabase: true,
          productionSourceAttached: false,
          pgRestoreExitCode: restoreState.restoreWorker.pgRestoreExitCode,
          backupObject: restoreState.object,
          encryptedPayloadSha256: restoreState.encryptedPayloadSha256,
          sourceDumpSha256: restoreState.sourceDumpSha256,
          sourceDataSnapshotSha256: observed.tableSnapshot.dataSnapshotSha256,
          tableSnapshot: observed.tableSnapshot,
          inventory,
          schemaFingerprintSha256,
          productionDatabaseWrites: false,
          destructiveRestore: false,
          retentionPrune: false,
        });
      },
      async reobserveProductionSourceReadOnly(request) {
        if (
          request.boundary !== "after" ||
          request.maintenanceWindowId !==
            plan.stoppedWritersProof.maintenanceWindowId
        ) {
          fail(
            "PRODUCTION_BACKUP_HOST_RUNNER_WRITER_PROOF_INVALID",
            "After-boundary request differs.",
          );
        }
        const observed = parseWorkerDatabase(
          await invokeWorker(
            { operation: "observe-source-snapshot" },
            internalSignal,
          ),
        );
        const inventory = exactInventory(observed.journalRows);
        const window = await requireNoWriters(internalSignal);
        const proof = freshStoppedWritersProof(window);
        const schemaFingerprintSha256 = exactObservedSchemaFingerprint(
          observed,
          "Re-observed source",
        );
        return canonicalProductionExact0096BackupJson({
          observedAt: proof.observedAt,
          inventory,
          runtimeBinding: plan.runtimeBinding,
          stoppedWritersProof: proof,
          stoppedWritersProofSha256: productionExact0096BackupSha256(
            canonicalProductionExact0096BackupJson(proof),
          ),
          schemaFingerprintSha256,
          tableSnapshot: observed.tableSnapshot,
          productionDatabaseWrites: false,
        });
      },
    });
    return await runComposite({
      planCanonical,
      config: {
        activated: true,
        controlPlaneContainerId,
        containerRequestDirectory: CONTAINER_REQUEST_DIRECTORY,
        evidenceDirectory: exact.evidenceDirectory,
        hostRequestDirectory: exact.hostRequestDirectory,
        producerEntrypoint: PRODUCER_ENTRYPOINT,
        timeoutMs: exact.timeoutMs,
      },
      invocationId,
      signal,
      activation: PRODUCTION_EXACT_0096_COMPOSITE_ACTIVATION,
      hostHandlers,
      overallTimeoutMs: exact.overallTimeoutMs,
    });
  } finally {
    const cleanupErrors = [];
    if (
      restoreNetworkConnected &&
      restoreLifecycle &&
      controlPlaneContainerId
    ) {
      await docker(
        run,
        [
          "network",
          "disconnect",
          "--force",
          restoreLifecycle.runtimeBinding.networkName,
          controlPlaneContainerId,
        ],
        { timeoutMs: exact.timeoutMs },
      ).catch((error) => cleanupErrors.push(error));
    }
    if (restoreLifecycle) {
      await restoreLifecycle
        .close()
        .catch((error) => cleanupErrors.push(error));
    }
    if (controlPlaneContainerId) {
      await docker(
        run,
        ["container", "rm", "--force", controlPlaneContainerId],
        { timeoutMs: exact.timeoutMs },
      ).catch((error) => cleanupErrors.push(error));
    }
    await rm(exact.hostRequestDirectory, { recursive: false }).catch(
      () => undefined,
    );
    if (cleanupErrors.length > 0) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_CLEANUP_FAILED",
        "One or more owned disposable resources remained.",
      );
    }
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/production-evidence/run-production-exact-0096-backup.mjs prepare --request FILE --intent FILE --plan-out FILE --confirm PREPARE_EXACT_0096_PRODUCTION_BACKUP_PLAN_READ_ONLY_NO_BACKUP",
    "  node scripts/production-evidence/run-production-exact-0096-backup.mjs preflight --request FILE --plan FILE --confirm READ_ONLY_EXACT_0096_PRODUCTION_BACKUP_PREFLIGHT_NO_CHANGES",
    "  node scripts/production-evidence/run-production-exact-0096-backup.mjs execute --request FILE --plan FILE --confirm RUN_EXACT_0096_PRODUCTION_BACKUP_AND_DISPOSABLE_RESTORE_NO_MIGRATION",
  ].join("\n");
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const allowed =
    command === "prepare"
      ? ["--request", "--intent", "--plan-out", "--confirm"]
      : ["--request", "--plan", "--confirm"];
  if (
    !["prepare", "preflight", "execute"].includes(command) ||
    rest.length !== allowed.length * 2
  ) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_USAGE_INVALID",
      "Arguments differ from the exact interface.",
    );
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!allowed.includes(key) || !value || Object.hasOwn(options, key)) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_USAGE_INVALID",
        "Arguments differ from the exact interface.",
      );
    }
    options[key] = value;
  }
  if (Object.keys(options).length !== allowed.length) {
    fail(
      "PRODUCTION_BACKUP_HOST_RUNNER_USAGE_INVALID",
      "Arguments differ from the exact interface.",
    );
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout ?? process.stdout;
  const { command, options } = parseArgs(argv);
  const request = await readCanonicalFile(options["--request"], "request");
  const config = exactConfig(request.value);
  if (command === "prepare") {
    const intent = await readCanonicalFile(
      options["--intent"],
      "prepareIntent",
    );
    const controller = new AbortController();
    const abort = () =>
      controller.abort(new Error("production backup plan preparation aborted"));
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      const result = await runProductionExact0096HostPreparation(
        {
          intent: intent.value,
          config,
          planOut: options["--plan-out"],
          confirmation: options["--confirm"],
          signal: controller.signal,
        },
        dependencies,
      );
      stdout.write(
        `mode=read-only-plan-preparation\nplan=${result.persisted.path}\nplanSha256=${result.persisted.sha256}\nproductionTargetsTouched=false\nbackupCreated=false\n`,
      );
      return;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }
  const plan = await readCanonicalFile(options["--plan"], "plan");
  if (command === "preflight") {
    if (
      options["--confirm"] !== PRODUCTION_EXACT_0096_HOST_PREFLIGHT_CONFIRMATION
    ) {
      fail(
        "PRODUCTION_BACKUP_HOST_RUNNER_DARK",
        "Exact read-only preflight confirmation is required.",
      );
    }
    const result = await runProductionExact0096HostPreflight({
      planCanonical: plan.raw,
      config,
    });
    stdout.write(
      `mode=${result.mode}\nready=${result.ready}\nrunningWriterContainerCount=${result.runningWriterContainerIds.length}\nproductionTargetsTouched=false\n`,
    );
    return;
  }
  const controller = new AbortController();
  const abort = () =>
    controller.abort(new Error("production backup host runner aborted"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const result = await runProductionExact0096HostExecution({
      planCanonical: plan.raw,
      config,
      confirmation: options["--confirm"],
      signal: controller.signal,
    });
    stdout.write(
      `decision=${result.receipt.value.decision}\nreceiptSha256=${result.receipt.sha256}\nexecutorTraceSha256=${result.trace.sha256}\nproductionMigrationAuthorized=false\n`,
    );
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    const code =
      error instanceof ProductionExact0096HostRunnerError
        ? error.code
        : "PRODUCTION_BACKUP_HOST_RUNNER_FAILED";
    process.stderr.write(`${code}\n${usage()}\n`);
    process.exitCode = 1;
  });
}
